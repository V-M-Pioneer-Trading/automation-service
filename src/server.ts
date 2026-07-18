import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { AnomalyChecker, AnomalyRepo } from "./anomaly";
import { AnomalyConfig, AnomalyScheduler } from "./anomalyScheduler";
import { AutopilotMode, AutopilotState, InvalidTransitionError } from "./autopilotState";
import { Clock, systemClock } from "./clock";
import { ServiceConfig, configFromEnv } from "./config";
import { ContractRepo } from "./contractRepo";
import { createPool, migrate } from "./db";
import { MarketIntelRepo } from "./marketIntelRepo";
import { EventLog } from "./eventLog";
import { createGameClients, UpstreamCallError } from "./gameClients";
import { KnobNotFoundError, KnobOutOfRangeError, KnobRepo } from "./knobs";
import { MetricsRepo } from "./metrics";
import { MetricsScheduler } from "./metricsScheduler";
import { Planner } from "./planner";
import { MiningScheduler } from "./scheduler";
import { ShipTaskRepo } from "./shipTaskRepo";
import { WebhookDelivery } from "./webhookDelivery";

const MAX_EVENTS_LIMIT = 1000;
const MAX_ROLLUPS_LIMIT = 200;
const DEFAULT_CONTEXT_ROLLUP_LIMIT = 10;
const DEFAULT_CONTEXT_EVENT_LIMIT = 20;
const MAX_CONTEXT_EVENT_LIMIT = 100;
const MAX_ANOMALIES_LIMIT = 200;
const DEFAULT_DIGEST_ANOMALY_LIMIT = 50;
const DEFAULT_DIGEST_EVENT_LIMIT = 50;
const DEFAULT_DIGEST_WINDOW_MINUTES = 60;
const MAX_DIGEST_WINDOW_MINUTES = 7 * 24 * 60;

// Event types worth surfacing in the digest alongside anomalies — lifecycle
// transitions and terminal failure/discard outcomes, not every routine
// per-tick mining event (those are what the anomaly checks themselves summarize).
const NOTABLE_EVENT_TYPES = [
  "armed",
  "paused",
  "aborted",
  "planner_no_viable_target",
  "mining_task_failed",
  "mining_no_market_found",
  "mining_discarded_after_abort",
  "planner_discarded_after_abort_or_pause",
];

/** Express 4 does not forward async-handler rejections to error middleware on its own. */
type AsyncHandler = (req: express.Request, res: express.Response) => Promise<void>;
const asyncHandler = (fn: AsyncHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) =>
  fn(req, res).catch(next);

const clampLimit = (raw: unknown, fallback: number, max: number): number => {
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

export interface MiningConfig {
  navigationServiceUrl: string;
  agentServiceUrl: string;
  fleetServiceUrl: string;
  miningShipSymbol: string;
  schedulerIntervalMs: number;
  replanIntervalMs: number;
}

export interface MetricsConfig {
  rollupIntervalMs: number;
}

/**
 * mining: optional so ticket-8's lifecycle-only tests (and any deployment that
 * hasn't configured a mining target yet) keep working with autopilot arm/pause/
 * abort but no ship-driving scheduler at all. metrics: optional for the same
 * reason — tests that don't care about rollups shouldn't get a background
 * timer they then have to account for. anomaly: optional likewise; requires a
 * webhook URL to be configured, so a deployment that hasn't set one up yet
 * doesn't get anomaly checks silently trying (and failing) to deliver anywhere.
 */
export function createApp(
  pool: Pool,
  clock: Clock = systemClock,
  mining?: MiningConfig,
  metrics?: MetricsConfig,
  anomaly?: AnomalyConfig,
  corsAllowedOrigin: string = "http://localhost:3000"
) {
  const app = express();
  app.use(
    cors({
      origin: corsAllowedOrigin,
      methods: ["GET", "POST", "PUT", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );
  app.use(express.json());

  const state = new AutopilotState();
  const events = new EventLog(pool, clock);
  const shipTaskRepo = new ShipTaskRepo(pool, clock);
  const knobs = new KnobRepo(pool);
  const metricsRepo = new MetricsRepo(pool, clock);
  const anomalyRepo = new AnomalyRepo(pool, clock);
  const contractRepo = new ContractRepo(pool, clock);

  const gameClients = mining !== undefined ? createGameClients(mining) : null;
  const planner = gameClients !== null ? new Planner(gameClients, knobs) : null;
  const marketIntelRepo = new MarketIntelRepo(pool, clock);

  const scheduler =
    mining !== undefined && gameClients !== null && planner !== null
      ? new MiningScheduler(state, shipTaskRepo, events, gameClients, clock, planner, knobs, contractRepo, marketIntelRepo, {
          shipSymbol: mining.miningShipSymbol,
          intervalMs: mining.schedulerIntervalMs,
          replanIntervalMs: mining.replanIntervalMs,
        })
      : null;

  // Runs independent of autopilot arm/pause/abort — metrics (including the
  // error rate) are meaningful whether or not the fleet is currently armed.
  const metricsScheduler =
    metrics !== undefined ? new MetricsScheduler(metricsRepo, clock, metrics.rollupIntervalMs) : null;
  metricsScheduler?.start();

  // Also independent of arm/pause/abort, for the same reason as metrics — an
  // idle or erroring fleet is exactly what an operator needs to hear about
  // whether or not autopilot happens to be armed right now.
  const anomalyScheduler =
    anomaly !== undefined
      ? new AnomalyScheduler(
          state,
          anomalyRepo,
          new AnomalyChecker(pool, clock, knobs, state),
          new WebhookDelivery({ url: anomaly.webhookUrl }),
          events,
          clock,
          knobs,
          shipTaskRepo,
          gameClients,
          { shipSymbol: mining?.miningShipSymbol ?? null, intervalMs: anomaly.intervalMs },
          () => scheduler?.requestReplan("anomaly")
        )
      : null;
  anomalyScheduler?.start();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/autopilot/status", (_req, res) => {
    res.json({ status: state.getStatus(), mode: state.getMode() });
  });

  app.post(
    "/autopilot/arm",
    asyncHandler(async (req, res) => {
      const token = req.body?.token;
      if (typeof token !== "string" || token.length === 0) {
        res.status(400).json({ error: { message: "token is required" } });
        return;
      }
      const mode: unknown = req.body?.mode ?? "live";
      if (mode !== "live" && mode !== "shadow") {
        res.status(400).json({ error: { message: 'mode must be "live" or "shadow"' } });
        return;
      }
      const from = state.getStatus();
      state.arm(token, mode as AutopilotMode);
      scheduler?.start();
      await events.append("armed", { from, mode });
      res.json({ status: state.getStatus(), mode: state.getMode() });
    })
  );

  const transition = (action: "pause" | "abort", eventType: string) =>
    asyncHandler(async (_req, res) => {
      try {
        const from = state.getStatus();
        state[action]();
        // Awaited so the abort response only returns once any in-flight tick
        // (assignTarget can now run several sequential HTTP calls for meta#11's
        // contract discovery) has actually finished, not just been told to stop.
        if (action === "abort") await scheduler?.stop();
        await events.append(eventType, { from });
        res.json({ status: state.getStatus(), mode: state.getMode() });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          res.status(409).json({ error: { message: err.message } });
          return;
        }
        throw err;
      }
    });

  app.post("/autopilot/pause", transition("pause", "paused"));
  app.post("/autopilot/abort", transition("abort", "aborted"));

  app.get(
    "/autopilot/events",
    asyncHandler(async (req, res) => {
      const limit = clampLimit(req.query.limit, 100, MAX_EVENTS_LIMIT);
      res.json({ events: await events.list(limit) });
    })
  );

  app.get(
    "/planner/knobs",
    asyncHandler(async (_req, res) => {
      res.json({ knobs: await knobs.getAll() });
    })
  );

  app.put(
    "/planner/knobs/:name",
    asyncHandler(async (req, res) => {
      const value = req.body?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        res.status(400).json({ error: { message: "value must be a finite number" } });
        return;
      }
      try {
        const knob = await knobs.set(req.params.name, value);
        scheduler?.requestReplan("knob_change");
        res.json({ knob });
      } catch (err) {
        if (err instanceof KnobNotFoundError) {
          res.status(404).json({ error: { message: err.message } });
          return;
        }
        if (err instanceof KnobOutOfRangeError) {
          res.status(400).json({ error: { message: err.message } });
          return;
        }
        throw err;
      }
    })
  );

  if (scheduler !== null) {
    app.post(
      "/planner/replan",
      asyncHandler(async (_req, res) => {
        scheduler.requestReplan("manual");
        res.json({ requested: true });
      })
    );
  }

  if (metricsScheduler !== null) {
    app.get(
      "/metrics/context",
      asyncHandler(async (req, res) => {
        const rollupLimit = clampLimit(req.query.rollupLimit, DEFAULT_CONTEXT_ROLLUP_LIMIT, MAX_ROLLUPS_LIMIT);
        const eventLimit = clampLimit(req.query.eventLimit, DEFAULT_CONTEXT_EVENT_LIMIT, MAX_CONTEXT_EVENT_LIMIT);
        const [rollups, recentEvents] = await Promise.all([
          metricsRepo.list(rollupLimit),
          events.list(eventLimit),
        ]);
        res.json({ rollups, events: recentEvents });
      })
    );
  }

  if (anomalyScheduler !== null) {
    app.get(
      "/anomalies/digest",
      asyncHandler(async (req, res) => {
        const windowMinutes = clampLimit(req.query.windowMinutes, DEFAULT_DIGEST_WINDOW_MINUTES, MAX_DIGEST_WINDOW_MINUTES);
        const anomalyLimit = clampLimit(req.query.anomalyLimit, DEFAULT_DIGEST_ANOMALY_LIMIT, MAX_ANOMALIES_LIMIT);
        const eventLimit = clampLimit(req.query.eventLimit, DEFAULT_DIGEST_EVENT_LIMIT, MAX_CONTEXT_EVENT_LIMIT);
        const since = new Date(clock.now().getTime() - windowMinutes * 60_000);
        const [anomalies, notableEvents] = await Promise.all([
          anomalyRepo.listSince(since, anomalyLimit),
          events.listSince(since, eventLimit, NOTABLE_EVENT_TYPES),
        ]);
        res.json({ anomalies, events: notableEvents });
      })
    );
  }

  if (scheduler !== null) {
    app.get(
      "/autopilot/ships/:shipSymbol",
      asyncHandler(async (req, res) => {
        const task = await shipTaskRepo.get(req.params.shipSymbol);
        if (task === null) {
          res.status(404).json({ error: { message: "no task for this ship yet" } });
          return;
        }
        res.json({ task });
      })
    );
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof UpstreamCallError ? err.statusCode : 500;
    res.status(status).json({ error: { message: err.message || "internal error" } });
  });

  // Metrics and anomaly detection run independent of autopilot arm/abort by
  // design, so /autopilot/abort can't stop them — tests that spin up many
  // short-lived apps in one process need an explicit way to stop these
  // background timers, or a leaked scheduler from an earlier test keeps
  // ticking against (and polluting) a later test's freshly-truncated tables.
  // Deliberately does NOT stop the mining/contract schedulers — those ARE tied
  // to arm/abort (see the "abort" transition above), so a test that configures
  // mining should call POST /autopilot/abort for those, same as production.
  app.locals.stopBackgroundSchedulers = async () => {
    await Promise.all([metricsScheduler?.stop(), anomalyScheduler?.stop()]);
  };

  return app;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const config: ServiceConfig = configFromEnv();
      const pool = createPool(config.databaseUrl);
      const port = Number(process.env.PORT ?? 3003);
      const anomalyConfig: AnomalyConfig | undefined =
        config.anomalyWebhookUrl !== null
          ? { webhookUrl: config.anomalyWebhookUrl, intervalMs: config.anomalyIntervalMs }
          : undefined;
      return migrate(pool).then(() =>
        createApp(
          pool,
          systemClock,
          config,
          { rollupIntervalMs: config.metricsRollupIntervalMs },
          anomalyConfig,
          config.corsAllowedOrigin
        ).listen(port, () => {
          console.log(`automation-service listening on http://localhost:${port}`);
        })
      );
    })
    .catch((err) => {
      console.error("automation-service failed to start:", err);
      process.exit(1);
    });
}

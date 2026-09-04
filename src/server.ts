import cors from "cors";
import express from "express";
import { Pool } from "pg";
import { AnomalyChecker, AnomalyRepo } from "./anomaly";
import { AnomalyConfig, AnomalyScheduler } from "./anomalyScheduler";
import { AuthConfig, actorOf, createVerifier, SCOPE_FLEET_CONTROL } from "./auth";
import { AutopilotState, InvalidTransitionError } from "./autopilotState";
import { Clock, systemClock } from "./clock";
import { ServiceConfig, configFromEnv } from "./config";
import { ContractRepo } from "./contractRepo";
import { createPool, migrate } from "./db";
import { EventLog } from "./eventLog";
import { createGameClients, UpstreamCallError } from "./gameClients";
import { isKnobClass, KnobNotFoundError, KnobOutOfRangeError, KnobRepo } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { MetricsRepo } from "./metrics";
import { MetricsScheduler } from "./metricsScheduler";
import { ObservationRepo, priorsFromKnobs } from "./observations";
import { Planner } from "./planner";
import { FleetScheduler } from "./scheduler";
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
  // meta#19's ai-service supervisor logs these via POST /events — included
  // here so both the digest (an operator's hourly review) and the
  // supervisor's own next run (which reads this same digest for context)
  // see prior AI actions, not just command-interface's unfiltered Event Feed.
  "ai_intervention",
  "ai_no_action",
];

/** Express 4 does not forward async-handler rejections to error middleware on its own. */
type AsyncHandler = (req: express.Request, res: express.Response) => Promise<void>;
const asyncHandler = (fn: AsyncHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) =>
  fn(req, res).catch(next);

const clampLimit = (raw: unknown, fallback: number, max: number): number => {
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const badRequest = (res: express.Response, message: string) => res.status(400).json({ error: { message } });

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

export interface AppOptions {
  pool: Pool;
  /** Required: a caller cannot construct this service without deciding what it trusts. Tests use `createTestApp`. */
  auth: AuthConfig;
  clock?: Clock;
  /** Optional so lifecycle-only deployments and tests get arm/pause/abort with no ship-driving scheduler at all. */
  mining?: MiningConfig;
  /** Optional so tests that don't care about rollups don't get a background timer to account for. */
  metrics?: MetricsConfig;
  /** Optional: needs a webhook URL, so a deployment without one doesn't run checks that can't deliver anywhere. */
  anomaly?: AnomalyConfig;
  corsAllowedOrigin?: string;
}

export function createApp(options: AppOptions) {
  const { pool, auth, clock = systemClock, mining, metrics, anomaly, corsAllowedOrigin = "http://localhost:3000" } = options;

  const { requireScope, requireServiceSecret } = createVerifier(auth);
  const requireControl = requireScope(SCOPE_FLEET_CONTROL);

  const app = express();
  // Every response here is either a live status check or reflects mutable
  // autopilot/event state — none of it is meaningfully cacheable
  app.set("etag", false);
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
  const tasks = new ShipTaskRepo(pool, clock);
  const knobs = new KnobRepo(pool);
  const metricsRepo = new MetricsRepo(pool, clock);
  const anomalyRepo = new AnomalyRepo(pool, clock);
  const contracts = new ContractRepo(pool, clock);
  const observations = new ObservationRepo(pool, clock);
  const marketIntel = new MarketIntelRepo(pool, clock);

  const gameClients = mining !== undefined ? createGameClients(mining) : null;
  const planner = gameClients !== null ? new Planner(gameClients, knobs, observations, contracts, marketIntel) : null;
  const scheduler =
    mining !== undefined && gameClients !== null && planner !== null
      ? new FleetScheduler({
          state,
          tasks,
          events,
          clients: gameClients,
          clock,
          planner,
          knobs,
          contracts,
          marketIntel,
          observations,
          pool,
          shipSymbol: mining.miningShipSymbol,
          intervalMs: mining.schedulerIntervalMs,
          replanIntervalMs: mining.replanIntervalMs,
        })
      : null;

  // Metrics and anomaly detection run independent of autopilot arm/pause/abort:
  // an idle or erroring fleet is exactly what an operator needs to hear about
  // whether or not autopilot happens to be armed right now.
  const metricsScheduler = metrics !== undefined ? new MetricsScheduler(metricsRepo, clock, metrics.rollupIntervalMs) : null;
  metricsScheduler?.start();

  const anomalyScheduler =
    anomaly !== undefined
      ? new AnomalyScheduler({
          state,
          repo: anomalyRepo,
          checker: new AnomalyChecker(pool, clock, knobs, state, marketIntel),
          webhook: new WebhookDelivery({ url: anomaly.webhookUrl }),
          events,
          clock,
          knobs,
          tasks,
          gameClients,
          shipSymbol: mining?.miningShipSymbol ?? null,
          intervalMs: anomaly.intervalMs,
          onAnomalyRecorded: () => scheduler?.requestReplan("anomaly"),
        })
      : null;
  anomalyScheduler?.start();

  const health = (_req: express.Request, res: express.Response) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok" });
  };
  // Resource routes live under /api/automation/v1 — health stays unversioned
  // since it's operational tooling, not versioned API surface. Mounted both
  // bare (local dev/compose) and under /api/automation (production CloudFront
  // only routes requests matching a configured path pattern).
  app.get("/health", health);
  app.get("/api/automation/health", health);

  const api = express.Router();

  // --- Autopilot lifecycle ---

  const lifecycleStatus = () => ({ status: state.getStatus(), mode: state.getMode() });

  api.get("/autopilot/status", (_req, res) => {
    res.json(lifecycleStatus());
  });

  api.post(
    "/autopilot/arm",
    requireControl,
    asyncHandler(async (req, res) => {
      const token: unknown = req.body?.token;
      if (typeof token !== "string" || token.length === 0) {
        badRequest(res, "token is required");
        return;
      }
      const mode: unknown = req.body?.mode ?? "live";
      if (mode !== "live" && mode !== "shadow") {
        badRequest(res, 'mode must be "live" or "shadow"');
        return;
      }
      const from = state.getStatus();
      state.arm(token, mode);
      scheduler?.start();
      await events.append("armed", { from, mode, actor: actorOf(res) });
      res.json(lifecycleStatus());
    })
  );

  const transition = (action: "pause" | "abort") =>
    asyncHandler(async (_req, res) => {
      const from = state.getStatus();
      try {
        state[action]();
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          res.status(409).json({ error: { message: err.message } });
          return;
        }
        throw err;
      }
      // Awaited so the abort response only returns once any in-flight tick has
      // actually finished, not just been told to stop.
      if (action === "abort") await scheduler?.stop();
      await events.append(action === "pause" ? "paused" : "aborted", { from, actor: actorOf(res) });
      res.json(lifecycleStatus());
    });

  api.post("/autopilot/pause", requireControl, transition("pause"));
  api.post("/autopilot/abort", requireControl, transition("abort"));

  api.get(
    "/autopilot/events",
    asyncHandler(async (req, res) => {
      const limit = clampLimit(req.query.limit, 100, MAX_EVENTS_LIMIT);
      res.json({ events: await events.list(limit) });
    })
  );

  if (scheduler !== null) {
    api.get(
      "/autopilot/ships/:shipSymbol",
      asyncHandler(async (req, res) => {
        const task = await tasks.get(req.params.shipSymbol);
        if (task === null) {
          res.status(404).json({ error: { message: "no task for this ship yet" } });
          return;
        }
        res.json({ task });
      })
    );
  }

  // For an external supervisor (meta#19's ai-service) to log its own rationale
  // into the same audit trail everything else here uses. `type` is restricted
  // to the "ai_" namespace so an external caller can log its own decisions but
  // can never spoof a lifecycle/planner event type (e.g. "armed", "knob_changed")
  // that the rest of this service treats as authoritative.
  //
  // Machine caller, so a shared secret rather than a Clerk scope — there is no
  // human identity behind it, and Clerk stays scoped to humans.
  api.post(
    "/events",
    requireServiceSecret(),
    asyncHandler(async (req, res) => {
      const type: unknown = req.body?.type;
      const detail: unknown = req.body?.detail;
      if (typeof type !== "string" || !type.startsWith("ai_")) {
        badRequest(res, 'type must be a string starting with "ai_"');
        return;
      }
      if (detail !== undefined && (typeof detail !== "object" || detail === null || Array.isArray(detail))) {
        badRequest(res, "detail must be an object");
        return;
      }
      await events.append(type, (detail as Record<string, unknown> | undefined) ?? {});
      res.status(201).json({ ok: true });
    })
  );

  // --- Planner ---

  // `?class=policy` is how the AI supervisor asks for exactly the knobs it is
  // allowed to write. Serving the filter here rather than trusting the caller
  // to filter means the restriction holds even if a client forgets it.
  api.get(
    "/planner/knobs",
    asyncHandler(async (req, res) => {
      const requested = req.query.class;
      if (requested === undefined) {
        res.json({ knobs: await knobs.getAll() });
        return;
      }
      if (!isKnobClass(requested)) {
        badRequest(res, 'class must be "model", "policy" or "alert"');
        return;
      }
      res.json({ knobs: await knobs.getByClass(requested) });
    })
  );

  api.put(
    "/planner/knobs/:name",
    requireControl,
    asyncHandler(async (req, res) => {
      const value: unknown = req.body?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        badRequest(res, "value must be a finite number");
        return;
      }
      try {
        const { knob, previousValue } = await knobs.set(req.params.name, value);
        await events.append("knob_changed", { name: req.params.name, previousValue, newValue: knob.value, actor: actorOf(res) });
        scheduler?.requestReplan("knob_change");
        res.json({ knob });
      } catch (err) {
        if (err instanceof KnobNotFoundError) {
          res.status(404).json({ error: { message: err.message } });
          return;
        }
        if (err instanceof KnobOutOfRangeError) {
          badRequest(res, err.message);
          return;
        }
        throw err;
      }
    })
  );

  // What the planner currently believes about the universe, and whether each
  // belief was measured or assumed. The single most useful thing to look at
  // when a ship goes somewhere surprising.
  api.get(
    "/planner/model",
    asyncHandler(async (_req, res) => {
      res.json({ model: await observations.calibrate(priorsFromKnobs(await knobs.getValues())) });
    })
  );

  if (scheduler !== null) {
    api.post(
      "/planner/replan",
      requireControl,
      asyncHandler(async (_req, res) => {
        scheduler.requestReplan("manual");
        res.json({ requested: true });
      })
    );
  }

  // --- Observability ---

  if (metricsScheduler !== null) {
    api.get(
      "/metrics/context",
      asyncHandler(async (req, res) => {
        const rollupLimit = clampLimit(req.query.rollupLimit, DEFAULT_CONTEXT_ROLLUP_LIMIT, MAX_ROLLUPS_LIMIT);
        const eventLimit = clampLimit(req.query.eventLimit, DEFAULT_CONTEXT_EVENT_LIMIT, MAX_CONTEXT_EVENT_LIMIT);
        const [rollups, recentEvents] = await Promise.all([metricsRepo.list(rollupLimit), events.list(eventLimit)]);
        res.json({ rollups, events: recentEvents });
      })
    );
  }

  if (anomalyScheduler !== null) {
    api.get(
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

  app.use("/api/automation/v1", api);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof UpstreamCallError ? err.statusCode : 500;
    res.status(status).json({ error: { message: err.message || "internal error" } });
  });

  // Metrics and anomaly detection run independent of autopilot arm/abort by
  // design, so /autopilot/abort can't stop them — tests that spin up many
  // short-lived apps in one process need an explicit way to stop these
  // background timers, or a leaked scheduler from an earlier test keeps
  // ticking against (and polluting) a later test's freshly-truncated tables.
  // Deliberately does NOT stop the fleet scheduler — that IS tied to
  // arm/abort, so a test that configures mining should POST /autopilot/abort.
  app.locals.stopBackgroundSchedulers = async () => {
    await Promise.all([metricsScheduler?.stop(), anomalyScheduler?.stop()]);
  };

  // Test-only escape hatch from the anomaly scheduler's real interval — lets
  // a test force exactly one deterministic tick instead of racing FakeClock
  // jumps against wall-clock ticks.
  app.locals.forceAnomalyTick = async () => {
    await anomalyScheduler?.forceTick();
  };

  return app;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const config: ServiceConfig = configFromEnv();
      const pool = createPool(config.databaseUrl);
      return migrate(pool).then(() =>
        createApp({
          pool,
          auth: { clerkJwtKeyPem: config.clerkJwtKeyPem, clerkIssuer: config.clerkIssuer, aiServiceSecret: config.aiServiceSecret },
          mining: config,
          metrics: { rollupIntervalMs: config.metricsRollupIntervalMs },
          anomaly:
            config.anomalyWebhookUrl !== null ? { webhookUrl: config.anomalyWebhookUrl, intervalMs: config.anomalyIntervalMs } : undefined,
          corsAllowedOrigin: config.corsAllowedOrigin,
        }).listen(config.port, () => {
          console.log(`automation-service listening on http://localhost:${config.port}`);
        })
      );
    })
    .catch((err) => {
      console.error("automation-service failed to start:", err);
      process.exit(1);
    });
}

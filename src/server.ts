import cors from "cors";
import { generateKeyPairSync } from "crypto";
import express from "express";
import { Pool } from "pg";
import { AnomalyChecker, AnomalyRepo } from "./anomaly";
import { AnomalyConfig, AnomalyScheduler } from "./anomalyScheduler";
import { AuthConfig, actorOf, createVerifier, SCOPE_FLEET_CONTROL } from "./auth";
import { AutopilotState, InvalidTransitionError } from "./autopilotState";
import { Clock, systemClock } from "./clock";
import { ServiceConfig, configFromEnv, resolveM2MTokenSource } from "./config";
import { ContractRepo } from "./contractRepo";
import { createPool, migrate } from "./db";
import { EventLog } from "./eventLog";
import { createGameClients } from "./gameClients";
import { isKnobClass, KnobClass, KnobClassForbiddenError, KnobNotFoundError, KnobOutOfRangeError, KnobRepo } from "./knobs";
import { createLocalM2MTokenSource, M2MTokenSource } from "./m2mToken";
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

/**
 * Event types worth surfacing in the digest alongside anomalies.
 *
 * The digest is two audiences at once: an operator's hourly review, and the AI
 * supervisor's context on its next run. The test for inclusion is therefore not
 * "is this an error" but **"would someone be wrong about the fleet without it,
 * and does nothing else tell them?"** Routine per-tick events stay out — the
 * anomaly checks already summarize those, and diluting a bounded list is how a
 * digest stops being read.
 *
 * The failure mode this list keeps having is the one the audit kept finding
 * elsewhere: the record gets written, and the page nobody built never shows it.
 * `contract_discovery_error` is the cautionary tale — decision 19's production
 * outage, the entire autonomous loop down, was eventually found by grepping the
 * raw event log for exactly this type, because the digest filtered it out.
 */
const NOTABLE_EVENT_TYPES = [
  // Lifecycle: what the operator last said they wanted.
  "armed",
  "paused",
  "aborted",

  // Terminal task outcomes — a ship gave up, or had nowhere to go.
  "planner_no_viable_target",
  "mining_task_failed",
  "mining_no_market_found",
  "mining_discarded_after_abort",
  "planner_discarded_after_abort_or_pause",

  // Failures that silently degrade something rather than stopping it, which is
  // exactly why they need surfacing: nothing else reports them, and the fleet
  // keeps running while quietly getting worse at its job.
  //   contract_discovery_error — the contract loop is down; mining continues,
  //     so credits/hour sags rather than flatlining.
  //   observation_write_error  — calibration stopped recording. The planner
  //     goes on scoring against the last values it measured, so it looks
  //     confident while drifting away from reality.
  "contract_discovery_error",
  "observation_write_error",

  // An operational condition, not a failure: another replica holds the dispatch
  // lock and this process is standing by. Logged once per spell, not per tick.
  // Two instances contending is something an operator should learn from the
  // digest rather than from a ship that mysteriously never moves.
  "dispatch_standby",

  // Configuration changes, which are the most consequential thing that can
  // happen without any ship doing anything.
  //   knob_changed — who retuned what. The supervisor may write policy knobs,
  //     so this is also how its next run sees its own prior tuning.
  //   knob_clamped — a deploy silently pulled a tuned value back inside new
  //     bounds. The audit added this event precisely so that stops being
  //     invisible; leaving it out of the digest left the fix half-finished.
  "knob_changed",
  "knob_clamped",

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

/**
 * Safety net for a direct `createApp` caller that wires up `mining` without
 * also supplying `authTokenSource` — the real entrypoint and `createTestApp`
 * both always supply one explicitly, so this only ever fires as a fallback.
 * A throwaway keypair generated once per process: gameClients' calls would
 * still 401 against a real agent/fleet-service (this signs nothing production
 * trusts), so this fails safe rather than open.
 */
let fallback: M2MTokenSource | null = null;
const fallbackAuthTokenSource = (): M2MTokenSource => {
  fallback ??= createLocalM2MTokenSource(
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
    { scope: SCOPE_FLEET_CONTROL }
  );
  return fallback;
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
  /**
   * What gameClients presents as `Authorization` on every outbound call to
   * agent/fleet-service (auth-design.md decision 19). Only meaningful
   * alongside `mining`. Optional so a caller that wires no `mining` needn't
   * think about it; with `mining` set but this absent it falls back to a
   * throwaway local signer, which fails safe (nothing in production trusts
   * it) rather than open. The entrypoint and `createTestApp` both supply one.
   */
  authTokenSource?: M2MTokenSource;
}

export function createApp(options: AppOptions) {
  const {
    pool,
    auth,
    clock = systemClock,
    mining,
    metrics,
    anomaly,
    corsAllowedOrigin = "http://localhost:3000",
    authTokenSource,
  } = options;

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

  const gameClients =
    mining !== undefined
      ? createGameClients({ ...mining, authTokenSource: authTokenSource ?? fallbackAuthTokenSource() })
      : null;
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
          checker: new AnomalyChecker(clock, state, marketIntel, events, metricsRepo),
          webhook: anomaly.webhookUrl ? new WebhookDelivery({ url: anomaly.webhookUrl }) : null,
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
      const mode: unknown = req.body?.mode ?? "live";
      if (mode !== "live" && mode !== "shadow") {
        badRequest(res, 'mode must be "live" or "shadow"');
        return;
      }
      const from = state.getStatus();
      state.arm(mode);
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

  /**
   * Two kinds of caller may tune, and they are not trusted equally.
   *
   * A human operator with `fleet:control` may write any class. The AI
   * supervisor authenticates as a machine and may write `policy` only — the
   * class model is a fence around *it*, and a fence enforced only by which
   * knobs it is shown is not a fence: nothing stopped it naming
   * `anomaly.errorRateThreshold` and resolving "the error alarm fired" by
   * making the error alarm unable to fire.
   */
  const machineWritableClasses: readonly KnobClass[] = ["policy"];
  const knobWriteGuard: express.RequestHandler = (req, res, next) => {
    if (req.header("X-Service-Secret") !== undefined) {
      res.locals.machineCaller = true;
      requireServiceSecret()(req, res, next);
      return;
    }
    requireControl(req, res, next);
  };

  api.put(
    "/planner/knobs/:name",
    knobWriteGuard,
    asyncHandler(async (req, res) => {
      const value: unknown = req.body?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        badRequest(res, "value must be a finite number");
        return;
      }
      const isMachine = res.locals.machineCaller === true;
      try {
        const { knob, previousValue } = await knobs.set(req.params.name, value, isMachine ? machineWritableClasses : undefined);
        await events.append("knob_changed", {
          name: req.params.name,
          previousValue,
          newValue: knob.value,
          actor: isMachine ? "ai-service" : actorOf(res),
        });
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
        if (err instanceof KnobClassForbiddenError) {
          // 403, not 401: the credential is valid, it simply does not reach
          // this class of knob. Re-authenticating would not help.
          res.status(403).json({ error: { message: err.message } });
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

  // No route here calls an upstream service: every one of them reads Postgres
  // or flips in-memory state, and the game is only ever touched from a
  // scheduler tick, whose failures are classified and handled there. This used
  // to re-serve an `UpstreamCallError`'s status code, which was unreachable and
  // told a reader the opposite — that an operator's 401 might be the fleet's
  // own expired token rather than their session.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: { message: err.message || "internal error" } });
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

  // Test-only escape hatches from the real intervals — a test forces exactly
  // one deterministic tick instead of racing FakeClock jumps against
  // wall-clock ticks and then polling to find out what happened.
  //
  // Give the scheduler an interval long enough never to fire rather than
  // stopping it: `runOnce()` on a stopped loop throws, deliberately, because
  // silently not ticking is the bug these exist to prevent.
  app.locals.forceAnomalyTick = async () => {
    await anomalyScheduler?.forceTick();
  };
  // Deliberately only defined when there is a loop to drive. A hook that
  // resolves without ticking is the same silent no-op runOnce() now throws on,
  // so a test wiring an app with no mining config gets a TypeError naming the
  // hook rather than an assertion that passes for the wrong reason.
  if (scheduler !== null) {
    app.locals.forceFleetTick = async () => {
      await scheduler.forceTick();
    };
  }
  if (metricsScheduler !== null) {
    app.locals.forceMetricsTick = async () => {
      await metricsScheduler.forceTick();
    };
  }

  return app;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const config: ServiceConfig = configFromEnv();
      const pool = createPool(config.databaseUrl);
      return migrate(pool).then(async (knobClamps) => {
        // A boot that moved an operator's tuned value to fit tightened bounds
        // says so in the same audit trail every other knob change lands in.
        const bootLog = new EventLog(pool, systemClock);
        for (const clamp of knobClamps) await bootLog.append("knob_clamped", { ...clamp });
        return createApp({
          pool,
          auth: { clerkJwtKeyPem: config.clerkJwtKeyPem, clerkIssuer: config.clerkIssuer, aiServiceSecret: config.aiServiceSecret },
          mining: config,
          metrics: { rollupIntervalMs: config.metricsRollupIntervalMs },
          // Always on, like the metrics rollups above it. Detection used to be
          // gated on ANOMALY_WEBHOOK_URL being set, which meant a deployment
          // with no webhook consumer ran no checks and served no digest — the
          // state production was actually in. The URL now only decides whether
          // anomalies are *also* posted somewhere.
          anomaly: { webhookUrl: config.anomalyWebhookUrl, intervalMs: config.anomalyIntervalMs },
          corsAllowedOrigin: config.corsAllowedOrigin,
          authTokenSource: resolveM2MTokenSource(),
        }).listen(config.port, () => {
          console.log(`automation-service listening on http://localhost:${config.port}`);
        });
      });
    })
    .catch((err) => {
      console.error("automation-service failed to start:", err);
      process.exit(1);
    });
}

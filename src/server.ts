import cors from "cors";
import express from "express";
import {
  actorOf,
  type M2MTokenSource,
  createExpressAuth,
  kindOf,
  notFound,
  passthrough,
  secured,
  type ExpressAuth,
} from "@v-m-pioneer-trading/clerk-client";
import type { Server } from "http";
import type { Pool } from "pg";
import { AnomalyChecker, AnomalyRepo } from "./anomaly";
import type { AnomalyConfig } from "./anomalyScheduler";
import { AnomalyScheduler } from "./anomalyScheduler";
import { SCOPE_EVENTS_WRITE, SCOPE_FLEET_CONTROL, SCOPE_PLANNER_ADVISE } from "./auth";
import { AutopilotLifecycle, LifecycleClosedError } from "./autopilotLifecycle";
import { AutopilotState, InvalidTransitionError } from "./autopilotState";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import type { ServiceConfig } from "./config";
import { configFromEnv, fetchStartupToken, resolveM2MTokenSource } from "./config";
import { ContractRepo } from "./contractRepo";
import { createPool, migrate } from "./db";
import { EventLog } from "./eventLog";
import { createGameClients } from "./gameClients";
import type { KnobClass } from "./knobs";
import { LegacyErrorTextScrubber } from "./legacyScrub";
import { isKnobClass, KnobClassForbiddenError, KnobNotFoundError, KnobOutOfRangeError, KnobRepo } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { MetricsRepo } from "./metrics";
import { MetricsScheduler } from "./metricsScheduler";
import { ObservationRepo, priorsFromKnobs } from "./observations";
import { Planner } from "./planner";
import { FleetScheduler } from "./scheduler";
import { ShipTaskRepo } from "./shipTaskRepo";
import { installShutdownHandlers, shutdownGracefully, type ShutdownSteps } from "./shutdown";
import { WebhookDelivery } from "./webhookDelivery";

/**
 * How long a SIGTERM may take before the process gives up and exits 1.
 * Production is Docker on EC2: `docker stop` sends SIGTERM and SIGKILLs after
 * 10 s by default (the deploy passes `-t 9`), so this stays under both and
 * the service exits on its own terms. It does not outlast every tick — the
 * 15 s upstream timeout is per call, and a tick makes several — so a tick
 * caught mid-call is cut off; the lifecycle row is safe regardless, because
 * closing the lifecycle is the first step and finishes in milliseconds.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

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
// Returns void: Express 4 ignores the return value of a handler, so the promise was never used by anyone.
const asyncHandler = (fn: AsyncHandler) => (req: express.Request, res: express.Response, next: express.NextFunction): void => {
  fn(req, res).catch(next);
};

const clampLimit = (raw: unknown, fallback: number, max: number): number => {
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const badRequest = (res: express.Response, message: string) => res.status(400).json({ error: { message } });

/** What the entrypoint needs from an app beyond the Express handler itself. */
interface AppLifecycleHandles {
  /** Settles once the persisted autopilot state is restored; rejects if it could not be. */
  autopilotRestored: Promise<void>;
  /** Shutdown steps 1 and 2: refuse lifecycle changes, then drain and stop every scheduler. */
  closeLifecycle: () => Promise<void>;
  stopSchedulers: () => Promise<void>;
  /** Starts the #45 background scrub of old rows. The entrypoint calls it once listening; tests drive `LegacyErrorTextScrubber` directly. */
  startLegacyScrub: () => void;
}
// Keyed by the app rather than hung on app.locals, which is untyped and is
// where the test-only hooks live; these are for the entrypoint.
const appHandles = new WeakMap<object, AppLifecycleHandles>();
const handlesOf = (app: object): AppLifecycleHandles => {
  const handles = appHandles.get(app);
  if (handles === undefined) throw new TypeError("not an app built by createApp");
  return handles;
};

/** Resolves once `app` has restored the persisted autopilot state (Q29). */
export const autopilotRestored = (app: object): Promise<void> => handlesOf(app).autopilotRestored;
/** Refuses further arm/pause/abort and waits until every accepted one is persisted. */
export const closeLifecycle = (app: object): Promise<void> => handlesOf(app).closeLifecycle();
/** Stops the fleet, anomaly and metrics loops, each awaiting its in-flight tick. Not an abort: nothing is persisted. */
export const stopSchedulers = (app: object): Promise<void> => handlesOf(app).stopSchedulers();
/** Starts the background scrub of pre-#45 error text (legacyScrub.ts). Returns at once; the scrub logs its own start and end. */
export const startLegacyScrub = (app: object): void => {
  handlesOf(app).startLegacyScrub();
};

/** The entrypoint's shutdown, step by step (see `ShutdownSteps` for why this order). Exported so a test runs the same wiring. */
export const shutdownStepsFor = (app: object, server: Server, pool: Pool): ShutdownSteps => ({
  closeLifecycle: () => closeLifecycle(app),
  stopSchedulers: () => stopSchedulers(app),
  closeServer: () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  closePool: () => pool.end(),
});

/**
 * Safety net for a direct `createApp` caller that wires up `mining` without
 * also supplying `authTokenSource` — the real entrypoint and `createTestApp`
 * both always supply one explicitly, so this only ever fires as a fallback.
 * It hands out a string no center recognises, so gameClients' calls would
 * still 401 against a real agent/fleet-service: this fails safe rather than open.
 */
const fallbackAuthTokenSource = (): M2MTokenSource => ({
  getToken: () => Promise.resolve("unconfigured-machine-token"),
});

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
  /**
   * Required: a caller cannot construct this service without deciding what it
   * trusts. Production passes `createExpressAuth(loadIntrospectionConfig())`,
   * which asks auth-service about every credential (decision 21); tests pass
   * one wired to a stub center via `createTestApp`.
   */
  auth: ExpressAuth;
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
   * agent/fleet-service (auth-design.md decision 22). Only meaningful
   * alongside `mining`. Optional so a caller that wires no `mining` needn't
   * think about it; with `mining` set but this absent it falls back to a
   * token no center recognises, which fails safe rather than open. The entrypoint and `createTestApp` both supply one.
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

  // Every mutating route declares this; every read declares
  // ignoreCredentials(). There is no third kind of route here.
  // One literal per route (decisions 20, 22): fleet:control does not satisfy
  // the events or planner-advice routes, and those scopes do not satisfy it.
  const requireControl = auth.requireScope(SCOPE_FLEET_CONTROL);
  const requireEventsWrite = auth.requireScope(SCOPE_EVENTS_WRITE);
  const requirePlannerAdvise = auth.requireScope(SCOPE_PLANNER_ADVISE);
  const publicRead = () => auth.ignoreCredentials();

  // secured(): a route registered on the app or on `api` below without a
  // declaration as its first handler refuses to start. "Public" is something a
  // route says out loud, never something that happens because a lookup missed.
  const app = secured(express());
  // Every response here is either a live status check or reflects mutable
  // autopilot/event state — none of it is meaningfully cacheable
  app.set("etag", false);
  // cors() first: it terminates a preflight itself, which is what lets a
  // browser's OPTIONS through. Mounted after the guard, the router would answer
  // the preflight with no Access-Control-Allow-Origin and the browser fails it.
  app.use(
    passthrough(
      cors({
        origin: corsAllowedOrigin,
        methods: ["GET", "POST", "PUT", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
      }),
      "answers CORS preflights; never serves a resource"
    )
  );
  app.use(passthrough(express.json(), "parses bodies; never answers a request for a resource"));

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
          webhook: anomaly.webhookUrl
            ? new WebhookDelivery({ url: anomaly.webhookUrl, format: anomaly.webhookFormat, telegramChatId: anomaly.telegramChatId ?? undefined })
            : null,
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

  // Constructed last: it starts restoring the persisted state immediately, and
  // a restore that finds the autopilot armed starts the fleet loop above.
  const lifecycle = new AutopilotLifecycle({
    state,
    pool,
    clock,
    startFleet: () => scheduler?.start(),
    stopFleet: async () => {
      await scheduler?.stop();
    },
  });

  const health = (_req: express.Request, res: express.Response) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok" });
  };
  // Resource routes live under /api/automation/v1 — health stays unversioned
  // since it's operational tooling, not versioned API surface. Mounted both
  // bare (local dev/compose) and under /api/automation (production CloudFront
  // only routes requests matching a configured path pattern).
  //
  // ignoreCredentials(), not allowPublic(): health reads no identity, so a
  // bearer sent here is never read and auth-service is never called. Health
  // must not turn 401 on a stale token, or 503 while auth-service is down.
  app.get("/health", publicRead(), health);
  app.get("/api/automation/health", publicRead(), health);

  // Every read under the API is public on purpose — the dashboard is meant to
  // be watchable without credentials, the event log especially — and none of
  // them reads identity, so they all declare ignoreCredentials() too: a
  // dashboard read keeps working while auth-service is down, and a stale token
  // riding along on one is never a 401.
  const api = secured(express.Router());

  // --- Autopilot lifecycle ---

  const lifecycleStatus = () => ({ status: state.getStatus(), mode: state.getMode() });

  // Waits for the restore (milliseconds, once per process), so a status read
  // never reports the "disarmed" a process starts with before it has looked.
  // A failed restore leaves the process disarmed, and that is what it reports.
  api.get(
    "/autopilot/status",
    publicRead(),
    asyncHandler(async (_req, res) => {
      await lifecycle.restored.catch(() => undefined);
      res.json(lifecycleStatus());
    })
  );

  // Every lifecycle change goes through `lifecycle`, which persists it and
  // queues it behind the restore and behind any other change (Q29).
  api.post(
    "/autopilot/arm",
    requireControl,
    asyncHandler(async (req, res) => {
      const mode: unknown = (req.body as { mode?: unknown } | undefined)?.mode ?? "live";
      if (mode !== "live" && mode !== "shadow") {
        badRequest(res, 'mode must be "live" or "shadow"');
        return;
      }
      res.json(await lifecycle.arm(mode, actorOf(res)));
    })
  );

  const transition = (action: "pause" | "abort") =>
    asyncHandler(async (_req, res) => {
      try {
        res.json(await lifecycle[action](actorOf(res)));
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          res.status(409).json({ error: { message: err.message } });
          return;
        }
        throw err;
      }
    });

  api.post("/autopilot/pause", requireControl, transition("pause"));
  api.post("/autopilot/abort", requireControl, transition("abort"));

  api.get(
    "/autopilot/events",
    publicRead(),
    asyncHandler(async (req, res) => {
      const limit = clampLimit(req.query.limit, 100, MAX_EVENTS_LIMIT);
      res.json({ events: await events.list(limit) });
    })
  );

  if (scheduler !== null) {
    api.get(
      "/autopilot/ships/:shipSymbol",
      publicRead(),
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
  // `events:write` only, from any kind of caller: `fleet:control` does not
  // satisfy it (decision 22). ai-service presents a Clerk M2M token minted by
  // auth-service (meta#59), like every other caller (decision 21). The shared secret
  // this route used to take is gone; the center has no primitive for one.
  //
  // `detail.actor` is stamped with the verified `sub` and overrides anything
  // the caller put there. The audit trail says who wrote a row because the
  // center said so, not because the row said so.
  api.post(
    "/events",
    requireEventsWrite,
    asyncHandler(async (req, res) => {
      const body = req.body as { type?: unknown; detail?: unknown } | undefined;
      const type: unknown = body?.type;
      const detail: unknown = body?.detail;
      if (typeof type !== "string" || !type.startsWith("ai_")) {
        badRequest(res, 'type must be a string starting with "ai_"');
        return;
      }
      if (detail !== undefined && (typeof detail !== "object" || detail === null || Array.isArray(detail))) {
        badRequest(res, "detail must be an object");
        return;
      }
      await events.append(type, { ...((detail as Record<string, unknown> | undefined) ?? {}), actor: actorOf(res) });
      res.status(201).json({ ok: true });
    })
  );

  // --- Planner ---

  // `?class=policy` is how the AI supervisor asks for exactly the knobs it is
  // allowed to write. Serving the filter here rather than trusting the caller
  // to filter means the restriction holds even if a client forgets it.
  api.get(
    "/planner/knobs",
    publicRead(),
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
   * Both need `planner:advise` (not `fleet:control`; decision 22). An operator may then write any class. A
   * machine — the AI supervisor, on its Clerk M2M token — may write `policy`
   * only: the class model is a fence around *it*, and a fence enforced only by
   * which knobs it is shown is not a fence: nothing stopped it naming
   * `anomaly.errorRateThreshold` and resolving "the error alarm fired" by
   * making the error alarm unable to fire.
   *
   * "Machine" is the center's `kind`, never the `sub` prefix and never which
   * header was sent; this used to key on `X-Service-Secret` being present.
   * Only an explicit operator is unfenced, so a `kind` this code does not
   * know fails toward the narrower set.
   */
  const machineWritableClasses: readonly KnobClass[] = ["policy"];

  api.put(
    "/planner/knobs/:name",
    requirePlannerAdvise,
    asyncHandler(async (req, res) => {
      const value: unknown = (req.body as { value?: unknown } | undefined)?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        badRequest(res, "value must be a finite number");
        return;
      }
      const isOperator = kindOf(res) === "operator";
      try {
        const { knob, previousValue } = await knobs.set(req.params.name, value, isOperator ? undefined : machineWritableClasses);
        await events.append("knob_changed", {
          name: req.params.name,
          previousValue,
          newValue: knob.value,
          // The caller's verified sub: `user_…` for an operator, `mch_…` for
          // a machine. It used to be the literal "ai-service" for any caller
          // holding the shared secret, which named a role, not a credential.
          actor: actorOf(res),
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
    publicRead(),
    asyncHandler(async (_req, res) => {
      res.json({ model: await observations.calibrate(priorsFromKnobs(await knobs.getValues())) });
    })
  );

  if (scheduler !== null) {
    api.post(
      "/planner/replan",
      requirePlannerAdvise,
      // eslint-disable-next-line @typescript-eslint/require-await -- asyncHandler wants a promise-returning handler, and a throw from requestReplan must still reach next() as a rejection
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
      publicRead(),
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
      publicRead(),
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

  // Express' default 404 is an HTML page; every other answer from this service
  // is JSON, so a mistyped path shouldn't be the one a caller can't parse.
  // notFound() serves no resource, so it needs no declaration and never asks
  // the center.
  app.use(
    notFound((_req: express.Request, res: express.Response) => {
      res.status(404).json({ error: { message: "not found" } });
    })
  );

  // No route here calls an upstream service: every one of them reads Postgres
  // or flips in-memory state, and the game is only ever touched from a
  // scheduler tick, whose failures are classified and handled there. This used
  // to re-serve an `UpstreamCallError`'s status code, which was unreachable and
  // told a reader the opposite — that an operator's 401 might be the fleet's
  // own expired token rather than their session.
  //
  // A caller's malformed or oversized body is a caller's fault, reported by
  // express.json() before any route runs. Answer it as one, in the same
  // envelope, rather than as a 500 carrying the parser's own wording.
  const BODY_ERRORS: Record<string, [number, string]> = {
    "entity.parse.failed": [400, "malformed JSON body"],
    "entity.too.large": [413, "request body too large"],
  };
  const onError: express.ErrorRequestHandler = (err: Error & { type?: unknown }, _req, res, _next) => {
    const bodyError = typeof err.type === "string" ? BODY_ERRORS[err.type] : undefined;
    if (bodyError !== undefined) {
      res.status(bodyError[0]).json({ error: { message: bodyError[1] } });
      return;
    }
    // A lifecycle change that arrived after shutdown began. Retryable against
    // the next process, which restores whatever this one persisted.
    if (err instanceof LifecycleClosedError) {
      res.status(503).json({ error: { message: err.message } });
      return;
    }
    // Anything else is our defect, and its message is ours to read, not the
    // caller's: a Postgres or parser message names tables and encodings.
    console.error("automation-service: unhandled error", err);
    res.status(500).json({ error: { message: "internal error" } });
  };
  app.use(onError);

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

  const legacyScrub = new LegacyErrorTextScrubber(pool);
  appHandles.set(app, {
    autopilotRestored: lifecycle.restored,
    closeLifecycle: () => lifecycle.close(),
    startLegacyScrub: () => {
      void legacyScrub.start();
    },
    // The scrub's stop() returns at once rather than waiting out a batch, so
    // it never spends the shutdown deadline.
    stopSchedulers: async () => {
      await Promise.all([scheduler?.stop(), metricsScheduler?.stop(), anomalyScheduler?.stop(), legacyScrub.stop()]);
    },
  });

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
        // Resolved first so a missing AUTH_M2M_* variable fails before any port
        // is bound, then fetched once so a caller secret the center does not
        // recognise fails loudly now rather than as a 401 on every mining tick.
        const authTokenSource = resolveM2MTokenSource();
        if ((await fetchStartupToken(authTokenSource)) === "unknown-caller") {
          console.error(
            "automation-service failed to start: auth-service did not recognise this caller (check AUTH_M2M_CALLER_SECRET)"
          );
          process.exit(1);
        }
        const app = createApp({
          pool,
          auth: createExpressAuth(config.introspection),
          mining: config,
          metrics: { rollupIntervalMs: config.metricsRollupIntervalMs },
          // Always on, like the metrics rollups above it. Detection used to be
          // gated on ANOMALY_WEBHOOK_URL being set, which meant a deployment
          // with no webhook consumer ran no checks and served no digest — the
          // state production was actually in. The URL now only decides whether
          // anomalies are *also* posted somewhere.
          anomaly: {
            webhookUrl: config.anomalyWebhookUrl,
            webhookFormat: config.anomalyWebhookFormat,
            telegramChatId: config.anomalyTelegramChatId,
            intervalMs: config.anomalyIntervalMs,
          },
          corsAllowedOrigin: config.corsAllowedOrigin,
          authTokenSource,
        });
        // Before listening, so the first request already sees the restored
        // state; a restore that fails exits 1 below and the orchestrator
        // retries, rather than serving a disarmed autopilot that should not be.
        await autopilotRestored(app);
        const server = app.listen(config.port, () => {
          console.log(`automation-service listening on http://localhost:${String(config.port)}`);
          // After listening, never before: on production this walks ~460k
          // rows, which must not stand between docker run and a healthy
          // /health (#45). It never throws; failures are logged and retried.
          startLegacyScrub(app);
        });
        installShutdownHandlers(
          process,
          () => shutdownGracefully(shutdownStepsFor(app, server, pool), SHUTDOWN_TIMEOUT_MS),
          (code) => process.exit(code)
        );
      });
    })
    .catch((err: unknown) => {
      console.error("automation-service failed to start:", err);
      process.exit(1);
    });
}

import cors from "cors";
import express from "express";
import {
  type M2MTokenSource,
  createExpressAuth,
  notFound,
  passthrough,
  secured,
  type ExpressAuth,
} from "@v-m-pioneer-trading/clerk-client";
import { ValidateError } from "@tsoa/runtime";
import type { Server } from "http";
import type { Pool } from "pg";
import { AnomalyChecker, AnomalyRepo } from "./anomaly";
import type { AnomalyConfig } from "./anomalyScheduler";
import { AnomalyScheduler } from "./anomalyScheduler";
import { declaring, routePolicy, type Policy, type Registrar } from "./auth";
import { AutopilotLifecycle, LifecycleClosedError } from "./autopilotLifecycle";
import { AutopilotState } from "./autopilotState";
import type { Clock } from "./clock";
import { systemClock } from "./clock";
import type { ServiceConfig } from "./config";
import { configFromEnv, fetchStartupToken, resolveM2MTokenSource } from "./config";
import { ContractRepo } from "./contractRepo";
import { AUTOPILOT_LOCAL, EVENTS_LOCAL, OBSERVABILITY_LOCAL, PLANNER_LOCAL } from "./controllers/support";
import { createPool, migrate } from "./db";
import { EventLog } from "./eventLog";
import { createGameClients } from "./gameClients";
import { LegacyErrorTextScrubber } from "./legacyScrub";
import { KnobRepo } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { MetricsRepo } from "./metrics";
import { MetricsScheduler } from "./metricsScheduler";
import { ObservationRepo } from "./observations";
import { Planner } from "./planner";
import { RegisterRoutes } from "./generated/routes";
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
  /** Replaces the policy table for the tsoa routes (tests). */
  policy?: Policy;
  /** Replaces tsoa's RegisterRoutes (tests); receives the declaring registrar. */
  registerRoutes?: (registrar: Registrar) => void;
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
    policy = routePolicy,
    registerRoutes = (r) => {
      RegisterRoutes(r as never);
    },
  } = options;

  // secured(): a route registered on the app below without a
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

  // Every route is a tsoa controller (src/controllers). Each gets the
  // declaration its routePolicy entry names, and one with no entry refuses
  // startup. Mounted after the cors and body passthroughs, before notFound().
  // The ship and replan routes exist only with a fleet scheduler, metrics
  // context only with metrics, the digest only with anomaly detection; without
  // its collaborator the request falls through to notFound().
  app.locals[AUTOPILOT_LOCAL] = { state, lifecycle, events, tasks };
  app.locals[EVENTS_LOCAL] = { events };
  app.locals[PLANNER_LOCAL] = { knobs, events, observations, scheduler };
  app.locals[OBSERVABILITY_LOCAL] = { metrics: metricsRepo, anomalies: anomalyRepo, events, clock };
  const omitted = new Set<string>();
  if (scheduler === null) {
    omitted.add("GET /api/automation/v1/autopilot/ships/:shipSymbol");
    omitted.add("POST /api/automation/v1/planner/replan");
  }
  if (metricsScheduler === null) omitted.add("GET /api/automation/v1/metrics/context");
  if (anomalyScheduler === null) omitted.add("GET /api/automation/v1/anomalies/digest");
  registerRoutes(declaring(app as unknown as Registrar, auth, policy, omitted));

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
    // tsoa refused the input of a controller route.
    if (err instanceof ValidateError) {
      const message = Object.values(err.fields).map((f) => f.message).join("; ");
      res.status(400).json({ error: { message } });
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

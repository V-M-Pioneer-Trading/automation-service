import express from "express";
import { Pool } from "pg";
import { AutopilotState, InvalidTransitionError } from "./autopilotState";
import { Clock, systemClock } from "./clock";
import { ServiceConfig, configFromEnv } from "./config";
import { createPool, migrate } from "./db";
import { EventLog } from "./eventLog";
import { createGameClients, UpstreamCallError } from "./gameClients";
import { MiningScheduler } from "./scheduler";
import { ShipTaskRepo } from "./shipTaskRepo";

const MAX_EVENTS_LIMIT = 1000;

/** Express 4 does not forward async-handler rejections to error middleware on its own. */
type AsyncHandler = (req: express.Request, res: express.Response) => Promise<void>;
const asyncHandler = (fn: AsyncHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) =>
  fn(req, res).catch(next);

export interface MiningConfig {
  navigationServiceUrl: string;
  agentServiceUrl: string;
  fleetServiceUrl: string;
  miningShipSymbol: string;
  miningAsteroidWaypoint: string;
  schedulerIntervalMs: number;
}

/**
 * mining: optional so ticket-8's lifecycle-only tests (and any deployment that
 * hasn't configured a mining target yet) keep working with autopilot arm/pause/
 * abort but no ship-driving scheduler at all.
 */
export function createApp(pool: Pool, clock: Clock = systemClock, mining?: MiningConfig) {
  const app = express();
  app.use(express.json());

  const state = new AutopilotState();
  const events = new EventLog(pool, clock);
  const shipTaskRepo = new ShipTaskRepo(pool, clock);

  const scheduler =
    mining !== undefined
      ? new MiningScheduler(state, shipTaskRepo, events, createGameClients(mining), clock, {
          shipSymbol: mining.miningShipSymbol,
          asteroidWaypoint: mining.miningAsteroidWaypoint,
          intervalMs: mining.schedulerIntervalMs,
        })
      : null;

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/autopilot/status", (_req, res) => {
    res.json({ status: state.getStatus() });
  });

  app.post(
    "/autopilot/arm",
    asyncHandler(async (req, res) => {
      const token = req.body?.token;
      if (typeof token !== "string" || token.length === 0) {
        res.status(400).json({ error: { message: "token is required" } });
        return;
      }
      const from = state.getStatus();
      state.arm(token);
      scheduler?.start();
      await events.append("armed", { from });
      res.json({ status: state.getStatus() });
    })
  );

  const transition = (action: "pause" | "abort", eventType: string) =>
    asyncHandler(async (_req, res) => {
      try {
        const from = state.getStatus();
        state[action]();
        if (action === "abort") scheduler?.stop();
        await events.append(eventType, { from });
        res.json({ status: state.getStatus() });
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
      const raw = req.query.limit;
      const parsed = typeof raw === "string" ? Number(raw) : NaN;
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_EVENTS_LIMIT) : 100;
      res.json({ events: await events.list(limit) });
    })
  );

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

  return app;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const config: ServiceConfig = configFromEnv();
      const pool = createPool(config.databaseUrl);
      const port = Number(process.env.PORT ?? 3003);
      return migrate(pool).then(() =>
        createApp(pool, systemClock, config).listen(port, () => {
          console.log(`automation-service listening on http://localhost:${port}`);
        })
      );
    })
    .catch((err) => {
      console.error("automation-service failed to start:", err);
      process.exit(1);
    });
}

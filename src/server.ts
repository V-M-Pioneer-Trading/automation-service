import express from "express";
import { Pool } from "pg";
import { AutopilotState, InvalidTransitionError } from "./autopilotState";
import { Clock, systemClock } from "./clock";
import { ServiceConfig, configFromEnv } from "./config";
import { createPool, migrate } from "./db";
import { EventLog } from "./eventLog";

const MAX_EVENTS_LIMIT = 1000;

/** Express 4 does not forward async-handler rejections to error middleware on its own. */
type AsyncHandler = (req: express.Request, res: express.Response) => Promise<void>;
const asyncHandler = (fn: AsyncHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) =>
  fn(req, res).catch(next);

export function createApp(pool: Pool, clock: Clock = systemClock) {
  const app = express();
  app.use(express.json());

  const state = new AutopilotState();
  const events = new EventLog(pool, clock);

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
      await events.append("armed", { from });
      res.json({ status: state.getStatus() });
    })
  );

  const transition = (action: "pause" | "abort", eventType: string) =>
    asyncHandler(async (_req, res) => {
      try {
        const from = state.getStatus();
        state[action]();
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

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: { message: err.message || "internal error" } });
  });

  return app;
}

if (require.main === module) {
  const config: ServiceConfig = configFromEnv();
  const pool = createPool(config.databaseUrl);
  const port = Number(process.env.PORT ?? 3003);

  migrate(pool)
    .then(() => {
      createApp(pool).listen(port, () => {
        console.log(`automation-service listening on http://localhost:${port}`);
      });
    })
    .catch((err) => {
      console.error("automation-service failed to start:", err);
      process.exit(1);
    });
}

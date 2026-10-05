/**
 * @file Graceful shutdown: the step order, the deadline, the signal handler,
 * and the entrypoint's real wiring against a listening app.
 */

import { EventEmitter } from "events";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import type { Pool } from "pg";
import { AutopilotStateRepo } from "../autopilotLifecycle";
import { createPool, migrate } from "../db";
import { autopilotRestored, shutdownStepsFor } from "../server";
import { installShutdownHandlers, SHUTDOWN_STEP_ORDER, shutdownGracefully, type ShutdownSteps } from "../shutdown";
import { forceAnomalyTick, forceFleetTick } from "../testSupport/appHooks";
import { bearer } from "../testSupport/authTokens";
import { createTestApp } from "../testSupport/createTestApp";
import { databaseUrl } from "../testSupport/databaseUrl";
import { FakeClock } from "../testSupport/fakeClock";
import { resetDatabase } from "../testSupport/resetDatabase";

const quiet = () => undefined;

const recordingSteps = (order: string[], overrides: Partial<ShutdownSteps> = {}): ShutdownSteps => {
  const step = (name: keyof ShutdownSteps) =>
    overrides[name] ??
    (async () => {
      await Promise.resolve();
      order.push(name);
    });
  return {
    closeLifecycle: step("closeLifecycle"),
    stopSchedulers: step("stopSchedulers"),
    closeServer: step("closeServer"),
    closePool: step("closePool"),
  };
};

describe("shutdownGracefully", () => {
  it("runs lifecycle, schedulers, server, pool — in that order, each awaited", async () => {
    const order: string[] = [];
    expect(await shutdownGracefully(recordingSteps(order), 1000, quiet)).toBe("clean");
    expect(order).toEqual(["closeLifecycle", "stopSchedulers", "closeServer", "closePool"]);
    expect(SHUTDOWN_STEP_ORDER).toEqual(order);
  });

  it("does not start a step until the one before it has finished", async () => {
    const order: string[] = [];
    let releaseSchedulers: () => void = () => undefined;
    const steps = recordingSteps(order, {
      stopSchedulers: () =>
        new Promise<void>((resolve) => {
          releaseSchedulers = () => {
            order.push("stopSchedulers");
            resolve();
          };
        }),
    });
    const done = shutdownGracefully(steps, 1000, quiet);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["closeLifecycle"]);
    releaseSchedulers();
    expect(await done).toBe("clean");
    expect(order).toEqual(["closeLifecycle", "stopSchedulers", "closeServer", "closePool"]);
  });

  it("keeps going past a failed step, so the pool still closes, and reports failed", async () => {
    const order: string[] = [];
    const steps = recordingSteps(order, { stopSchedulers: () => Promise.reject(new Error("boom")) });
    expect(await shutdownGracefully(steps, 1000, quiet)).toBe("failed");
    expect(order).toEqual(["closeLifecycle", "closeServer", "closePool"]);
  });

  it("gives up at the deadline on a step that hangs", async () => {
    const order: string[] = [];
    const steps = recordingSteps(order, { closeServer: () => new Promise<void>(() => undefined) });
    jest.useFakeTimers();
    try {
      let outcome: string | null = null;
      void shutdownGracefully(steps, 8000, quiet).then((o) => (outcome = o));
      await jest.advanceTimersByTimeAsync(7999);
      expect(outcome).toBeNull(); // not a moment early
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome).toBe("timed-out");
    } finally {
      jest.useRealTimers();
    }
    expect(order).toEqual(["closeLifecycle", "stopSchedulers"]);
  });
});

describe("installShutdownHandlers", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it.each(["SIGTERM", "SIGINT"] as const)("%s runs the shutdown once and exits 0 when it was clean", async (signal) => {
    const source = new EventEmitter();
    const shutdown = jest.fn(() => Promise.resolve("clean" as const));
    const exit = jest.fn();
    installShutdownHandlers(source, shutdown, exit);
    source.emit(signal);
    source.emit("SIGTERM");
    source.emit("SIGINT");
    await settle();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each(["failed", "timed-out"] as const)("exits 1 when the shutdown %s", async (outcome) => {
    const source = new EventEmitter();
    const exit = jest.fn();
    installShutdownHandlers(source, () => Promise.resolve(outcome), exit);
    source.emit("SIGTERM");
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when the shutdown itself throws", async () => {
    const source = new EventEmitter();
    const exit = jest.fn();
    installShutdownHandlers(source, () => Promise.reject(new Error("boom")), exit);
    source.emit("SIGTERM");
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("the entrypoint's shutdown against a running app", () => {
  let pool: Pool;
  let appPool: Pool;
  let server: Server;

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * While `hold` is set, the next write to `autopilot_state` waits for
   * `release()` and resolves `reached` when it gets there — a request pinned
   * mid-persist without a sleep.
   */
  let gate: { hold: boolean; reached: Promise<void>; release: () => void };
  const gated = (target: Pool): Pool => {
    let signal: () => void = () => undefined;
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (open = resolve));
    gate = { hold: false, reached: new Promise<void>((resolve) => (signal = resolve)), release: () => {
        open();
      },
    };
    const holdOn = (query: (...a: unknown[]) => unknown) => async (...args: unknown[]) => {
      if (gate.hold && typeof args[0] === "string" && args[0].includes("INTO autopilot_state")) {
        gate.hold = false;
        signal();
        await opened;
      }
      return query(...args);
    };
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === "connect") {
          return async () => {
            const client = await t.connect();
            return new Proxy(client, {
              get(c, cprop, creceiver) {
                if (cprop === "query") return holdOn(c.query.bind(c));
                return Reflect.get(c, cprop, creceiver) as unknown;
              },
            });
          };
        }
        return Reflect.get(t, prop, receiver) as unknown;
      },
    });
  };

  beforeEach(async () => {
    await resetDatabase(pool);
    appPool = createPool(databaseUrl()); // the app's own, so the test can watch it close
  });

  const start = async () => {
    const clock = new FakeClock(new Date("2026-10-05T10:00:00Z"));
    const app = createTestApp(
      gated(appPool),
      clock,
      {
        agentServiceUrl: "http://127.0.0.1:9",
        fleetServiceUrl: "http://127.0.0.1:9",
        navigationServiceUrl: "http://127.0.0.1:9",
        miningShipSymbol: "MINING-1",
        schedulerIntervalMs: 3_600_000,
        replanIntervalMs: 3_600_000,
      },
      { rollupIntervalMs: 3_600_000 },
      { webhookUrl: null, intervalMs: 3_600_000 }
    );
    await autopilotRestored(app);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    return { app, base };
  };

  it("persists an arm that was in flight, stops every loop, closes the server and the pool, and leaves the autopilot armed", async () => {
    const { app, base } = await start();
    await request(base).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({ mode: "shadow" });

    // An arm held at its row write, so shutdown begins while it is accepted but not yet persisted.
    gate.hold = true;
    const inFlightResponse = request(base)
      .post("/api/automation/v1/autopilot/arm")
      .set("Authorization", bearer())
      .send({ mode: "live" })
      .then((res) => res);
    await gate.reached;
    const shutdown = shutdownGracefully(shutdownStepsFor(app, server, appPool), 5000, quiet);
    await new Promise((resolve) => setImmediate(resolve));
    gate.release();
    const outcome = await shutdown;

    expect(outcome).toBe("clean");
    expect((await inFlightResponse).status).toBe(200);
    // Shutdown is not an abort: the row is what the operator last set.
    expect(await new AutopilotStateRepo(pool, new FakeClock(new Date())).load()).toMatchObject({ status: "armed", mode: "live" });
    // Every loop is stopped: forcing a tick on a stopped loop throws.
    await expect(forceFleetTick(app)).rejects.toThrow(/stopped loop/);
    await expect(forceAnomalyTick(app)).rejects.toThrow(/stopped loop/);
    expect(server.listening).toBe(false);
    await expect(appPool.query("SELECT 1")).rejects.toThrow();
  });

  it("answers 503 to a lifecycle change once shutdown has begun, and changes nothing", async () => {
    const { app, base } = await start();
    const steps = shutdownStepsFor(app, server, appPool);
    await steps.closeLifecycle();
    const res = await request(base).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    expect(res.status).toBe(503);
    expect((await request(base).get("/api/automation/v1/autopilot/status")).body).toEqual({ status: "disarmed", mode: null });
    await steps.stopSchedulers();
    await steps.closeServer();
    await steps.closePool();
    expect(await new AutopilotStateRepo(pool, new FakeClock(new Date())).load()).toBeNull();
  });
});

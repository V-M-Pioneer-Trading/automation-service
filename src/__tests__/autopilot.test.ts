import request from "supertest";
import { Pool } from "pg";
import { FakeClock } from "../testSupport/fakeClock";
import { createTestApp } from "../testSupport/createTestApp";
import { bearer } from "../testSupport/authTokens";
import { createPool, migrate } from "../db";
import { Clock } from "../clock";
import { resetDatabase } from "../testSupport/resetDatabase";

describe("automation-service autopilot lifecycle", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const app = (clock?: Clock) => createTestApp(pool, clock);

  it("starts disarmed", async () => {
    const res = await request(app()).get("/api/automation/v1/autopilot/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "disarmed", mode: null });
  });

  it("arms and logs the transition", async () => {
    const clock = new FakeClock(new Date("2026-07-17T10:00:00Z"));
    const gateway = app(clock);

    const armRes = await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    expect(armRes.status).toBe(200);
    expect(armRes.body).toEqual({ status: "armed", mode: "live" });

    const statusRes = await request(gateway).get("/api/automation/v1/autopilot/status");
    expect(statusRes.body).toEqual({ status: "armed", mode: "live" });

    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events");
    expect(eventsRes.body.events).toHaveLength(1);
    expect(eventsRes.body.events[0]).toMatchObject({ type: "armed", detail: { from: "disarmed" } });
    expect(eventsRes.body.events[0].occurredAt).toBe("2026-07-17T10:00:00.000Z");

  });

  // Stage 5 of increment 3: arming carries no credential any more (st-gateway
  // injects the game token, auth-design.md decision 5). A stale client still
  // sending `token` is served normally; the only thing validated is `mode`.
  it("ignores a stray token field and rejects only an unknown mode", async () => {
    const gateway = app();
    const stale = await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({ token: "stale-client-still-sends-this" });
    expect(stale.status).toBe(200);
    const raw = JSON.stringify((await request(gateway).get("/api/automation/v1/autopilot/events")).body);
    expect(raw).not.toContain("stale-client-still-sends-this");

    const res = await request(app()).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({ mode: "turbo" });
    expect(res.status).toBe(400);
    const statusRes = await request(app()).get("/api/automation/v1/autopilot/status");
    expect(statusRes.body.status).toBe("disarmed");
  });

  it("pauses from armed and logs it", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    const res = await request(gateway).post("/api/automation/v1/autopilot/pause").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "paused", mode: "live" });

    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events");
    expect(eventsRes.body.events[0]).toMatchObject({ type: "paused", detail: { from: "armed" } });
  });

  it("rejects pausing when not armed", async () => {
    const res = await request(app()).post("/api/automation/v1/autopilot/pause").set("Authorization", bearer());
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/disarmed/);
  });

  it("aborts from armed or paused, and logs it", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    const res = await request(gateway).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "aborted", mode: null });

    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events");
    expect(eventsRes.body.events[0]).toMatchObject({ type: "aborted", detail: { from: "armed" } });
  });

  it("aborts from paused too", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    await request(gateway).post("/api/automation/v1/autopilot/pause").set("Authorization", bearer());

    const res = await request(gateway).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "aborted", mode: null });
  });

  it("rejects aborting when disarmed", async () => {
    const res = await request(app()).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());
    expect(res.status).toBe(409);
  });

  it("allows re-arming from paused or aborted", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    await request(gateway).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());

    const res = await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "armed", mode: "live" });
  });

  it("a fresh app instance (simulated restart) always starts disarmed even though prior events persisted", async () => {
    const firstRun = app();
    await request(firstRun).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    const restarted = app();
    const statusRes = await request(restarted).get("/api/automation/v1/autopilot/status");
    expect(statusRes.body.status).toBe("disarmed");

    const eventsRes = await request(restarted).get("/api/automation/v1/autopilot/events");
    expect(eventsRes.body.events).toHaveLength(1); // event log survived the "restart"
  });

  it("orders events most-recent-first and respects limit", async () => {
    const clock = new FakeClock(new Date("2026-07-17T10:00:00Z"));
    const gateway = app(clock);

    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    clock.advance(1000);
    await request(gateway).post("/api/automation/v1/autopilot/pause").set("Authorization", bearer());
    clock.advance(1000);
    await request(gateway).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());

    const res = await request(gateway).get("/api/automation/v1/autopilot/events?limit=2");
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].type).toBe("aborted");
    expect(res.body.events[1].type).toBe("paused");
  });

  it("does not error on an oversized or malformed limit", async () => {
    const gateway = app();
    const huge = await request(gateway).get("/api/automation/v1/autopilot/events?limit=999999999");
    expect(huge.status).toBe(200);

    const repeated = await request(gateway).get("/api/automation/v1/autopilot/events?limit=1&limit=2");
    expect(repeated.status).toBe(200); // array value falls back to the default, not a crash
  });
});

describe("automation-service error mapping", () => {
  // A DB failure must surface as a clean 500, not hang the request forever —
  // Express 4 does not auto-catch rejections thrown inside async handlers.
  class FailingPool {
    async query(): Promise<never> {
      throw new Error("db unreachable");
    }
  }
  const failingApp = () => createTestApp(new FailingPool() as unknown as Pool);

  it("returns 500 instead of hanging when the event log write fails during arm", async () => {
    const res = await request(failingApp()).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBeDefined();
  });

  it("returns 500 instead of hanging when the event log read fails", async () => {
    const res = await request(failingApp()).get("/api/automation/v1/autopilot/events");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBeDefined();
  });
});

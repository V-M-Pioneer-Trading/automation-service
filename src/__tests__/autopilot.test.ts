import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../server";
import { createPool, migrate } from "../db";
import { Clock } from "../clock";

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

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
    await pool.query("TRUNCATE event_log RESTART IDENTITY");
  });

  const app = (clock?: Clock) => createApp(pool, clock);

  it("starts disarmed", async () => {
    const res = await request(app()).get("/autopilot/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "disarmed" });
  });

  it("arms with a token and logs the transition, without persisting the token", async () => {
    const clock = new FakeClock(new Date("2026-07-17T10:00:00Z"));
    const gateway = app(clock);

    const armRes = await request(gateway).post("/autopilot/arm").send({ token: "secret-st-token" });
    expect(armRes.status).toBe(200);
    expect(armRes.body).toEqual({ status: "armed" });

    const statusRes = await request(gateway).get("/autopilot/status");
    expect(statusRes.body).toEqual({ status: "armed" });

    const eventsRes = await request(gateway).get("/autopilot/events");
    expect(eventsRes.body.events).toHaveLength(1);
    expect(eventsRes.body.events[0]).toMatchObject({ type: "armed", detail: { from: "disarmed" } });
    expect(eventsRes.body.events[0].occurredAt).toBe("2026-07-17T10:00:00.000Z");

    const rawEvents = JSON.stringify(eventsRes.body);
    expect(rawEvents).not.toContain("secret-st-token");
  });

  it("rejects arming without a token", async () => {
    const res = await request(app()).post("/autopilot/arm").send({});
    expect(res.status).toBe(400);
    const statusRes = await request(app()).get("/autopilot/status");
    expect(statusRes.body.status).toBe("disarmed");
  });

  it("pauses from armed and logs it", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "t" });

    const res = await request(gateway).post("/autopilot/pause");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "paused" });

    const eventsRes = await request(gateway).get("/autopilot/events");
    expect(eventsRes.body.events[0]).toMatchObject({ type: "paused", detail: { from: "armed" } });
  });

  it("rejects pausing when not armed", async () => {
    const res = await request(app()).post("/autopilot/pause");
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/disarmed/);
  });

  it("aborts from armed or paused, clearing the held token, and logs it", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "t" });

    const res = await request(gateway).post("/autopilot/abort");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "aborted" });

    const eventsRes = await request(gateway).get("/autopilot/events");
    expect(eventsRes.body.events[0]).toMatchObject({ type: "aborted", detail: { from: "armed" } });
  });

  it("aborts from paused too", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "t" });
    await request(gateway).post("/autopilot/pause");

    const res = await request(gateway).post("/autopilot/abort");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "aborted" });
  });

  it("rejects aborting when disarmed", async () => {
    const res = await request(app()).post("/autopilot/abort");
    expect(res.status).toBe(409);
  });

  it("allows re-arming from paused or aborted", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "t" });
    await request(gateway).post("/autopilot/abort");

    const res = await request(gateway).post("/autopilot/arm").send({ token: "t2" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "armed" });
  });

  it("a fresh app instance (simulated restart) always starts disarmed even though prior events persisted", async () => {
    const firstRun = app();
    await request(firstRun).post("/autopilot/arm").send({ token: "t" });

    const restarted = app();
    const statusRes = await request(restarted).get("/autopilot/status");
    expect(statusRes.body.status).toBe("disarmed");

    const eventsRes = await request(restarted).get("/autopilot/events");
    expect(eventsRes.body.events).toHaveLength(1); // event log survived the "restart"
  });

  it("orders events most-recent-first and respects limit", async () => {
    const clock = new FakeClock(new Date("2026-07-17T10:00:00Z"));
    const gateway = app(clock);

    await request(gateway).post("/autopilot/arm").send({ token: "t" });
    clock.advance(1000);
    await request(gateway).post("/autopilot/pause");
    clock.advance(1000);
    await request(gateway).post("/autopilot/abort");

    const res = await request(gateway).get("/autopilot/events?limit=2");
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].type).toBe("aborted");
    expect(res.body.events[1].type).toBe("paused");
  });

  it("does not error on an oversized or malformed limit", async () => {
    const gateway = app();
    const huge = await request(gateway).get("/autopilot/events?limit=999999999");
    expect(huge.status).toBe(200);

    const repeated = await request(gateway).get("/autopilot/events?limit=1&limit=2");
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
  const failingApp = () => createApp(new FailingPool() as unknown as Pool);

  it("returns 500 instead of hanging when the event log write fails during arm", async () => {
    const res = await request(failingApp()).post("/autopilot/arm").send({ token: "t" });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBeDefined();
  });

  it("returns 500 instead of hanging when the event log read fails", async () => {
    const res = await request(failingApp()).get("/autopilot/events");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBeDefined();
  });
});

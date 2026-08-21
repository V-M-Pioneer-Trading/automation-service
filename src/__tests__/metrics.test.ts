import request from "supertest";
import { Pool } from "pg";
import { createTestApp } from "../testSupport/createTestApp";
import { createPool, migrate } from "../db";
import { Clock } from "../clock";
import { resetDatabase } from "../testSupport/resetDatabase";

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe("automation-service metrics rollups (meta#14)", () => {
  let pool: Pool;
  let clock: FakeClock;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
  });

  let gateways: ReturnType<typeof createTestApp>[] = [];
  afterEach(async () => {
    // Otherwise a leaked MetricsScheduler keeps ticking against (and
    // polluting) the next test's freshly-truncated tables — see meta#15's
    // stopBackgroundSchedulers, added after this exact leak broke anomaly.test.ts.
    await Promise.all(gateways.map((g) => g.locals.stopBackgroundSchedulers?.()));
    gateways = [];
  });

  const app = (rollupIntervalMs = 15) => {
    const gateway = createTestApp(pool, clock, undefined, { rollupIntervalMs });
    gateways.push(gateway);
    return gateway;
  };

  // Seeds a zero-value rollup ending at clock.now(), so a freshly-started
  // scheduler's window boundary is exactly clock.now() on its very first tick —
  // deterministic, instead of racing that bootstrap tick against the test's
  // own clock.advance() call.
  const seedBaselineRollup = () =>
    pool.query(
      `INSERT INTO metrics_rollup (window_start, window_end, computed_at, credits_per_hour, extraction_units, error_rate)
       VALUES ($1, $1, $1, 0, 0, 0)`,
      [clock.now()]
    );

  it("has no /metrics/context route when metrics isn't configured", async () => {
    const gateway = createTestApp(pool, clock);
    const res = await request(gateway).get("/api/automation/v1/metrics/context");
    expect(res.status).toBe(404);
  });

  it("computes and persists a rollup on a schedule, driven by activity through the API", async () => {
    await seedBaselineRollup();
    await pool.query(
      `INSERT INTO event_log (occurred_at, type, detail) VALUES
        ($1, 'mining_sell', '{"totalPrice": 100}'),
        ($1, 'mining_sell', '{"totalPrice": 50}'),
        ($1, 'mining_extract', '{"units": 10}'),
        ($1, 'mining_tick_error', '{}')`,
      [clock.now()]
    );

    const gateway = app();
    clock.advance(60 * 60 * 1000); // one hour, so credits/hour reads directly off the seeded revenue

    const deadline = Date.now() + 2000;
    let rollups: { creditsPerHour: number; extractionUnits: number; errorRate: number }[] = [];
    while (Date.now() < deadline && rollups.length < 2) {
      const res = await request(gateway).get("/api/automation/v1/metrics/context");
      rollups = res.body.rollups;
      if (rollups.length < 2) await new Promise((r) => setTimeout(r, 10));
    }
    expect(rollups.length).toBeGreaterThanOrEqual(2); // the seeded baseline + the one just computed

    const rollup = rollups[0]; // most recent first
    expect(rollup.creditsPerHour).toBe(150); // (100 + 50) revenue over exactly one hour
    expect(rollup.extractionUnits).toBe(10);
    // 4 mining_* events total (2 sell + 1 extract + 1 error), 1 of them an error.
    expect(rollup.errorRate).toBe(0.25);
  }, 10_000);

  it("returns rollups and recent events together in one bounded response", async () => {
    await seedBaselineRollup();
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'armed', '{}')`, [clock.now()]);

    const gateway = app();
    clock.advance(1000);

    const deadline = Date.now() + 2000;
    let body: { rollups: unknown[]; events: unknown[] } = { rollups: [], events: [] };
    while (Date.now() < deadline && body.rollups.length < 2) {
      const res = await request(gateway).get("/api/automation/v1/metrics/context");
      body = res.body;
      if (body.rollups.length < 2) await new Promise((r) => setTimeout(r, 10));
    }
    expect(body.rollups.length).toBeGreaterThanOrEqual(2);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.length).toBeLessThanOrEqual(100); // bounded, per MAX_CONTEXT_EVENT_LIMIT
  }, 10_000);

  it("resumes rollup windows from the last persisted one after a restart, instead of double-counting", async () => {
    await seedBaselineRollup();

    const firstRun = app();
    clock.advance(1000);

    const deadline1 = Date.now() + 2000;
    let firstRollupCount = 0;
    while (Date.now() < deadline1 && firstRollupCount < 2) {
      const res = await request(firstRun).get("/api/automation/v1/metrics/context");
      firstRollupCount = res.body.rollups.length;
      if (firstRollupCount < 2) await new Promise((r) => setTimeout(r, 10));
    }
    expect(firstRollupCount).toBeGreaterThanOrEqual(2);

    const rollupsBeforeRestart = (await request(firstRun).get("/api/automation/v1/metrics/context")).body.rollups;
    const latestWindowEnd = rollupsBeforeRestart[0].windowEnd;

    // Simulated restart: a fresh app instance, same DB, same (unadvanced) clock.
    const restarted = app();
    await new Promise((r) => setTimeout(r, 60)); // give it a few ticks; no time has elapsed, so nothing new should compute

    const rollupsAfterRestart = (await request(restarted).get("/api/automation/v1/metrics/context")).body.rollups;
    // Same rollup count and same latest window_end as before the restart — no
    // new window opened until time actually elapses, and nothing was double-counted.
    expect(rollupsAfterRestart).toHaveLength(rollupsBeforeRestart.length);
    expect(rollupsAfterRestart[0].windowEnd).toBe(latestWindowEnd);
  }, 10_000);
});

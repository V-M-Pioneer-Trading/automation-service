import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { Pool } from "pg";
import { createTestApp } from "../testSupport/createTestApp";
import { bearer } from "../testSupport/authTokens";
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

function startStubServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const calls: { method: string; url: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", body });
      handler(req, body, res);
    });
  });
  return { server, calls };
}

const respondJson = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

describe("automation-service anomaly detection (meta#15)", () => {
  let pool: Pool;
  let clock: FakeClock;
  let webhook: ReturnType<typeof startStubServer>;
  let webhookUrl: string;
  let webhookStatus = 200;
  let credits = 100_000;

  let agent: ReturnType<typeof startStubServer>;
  let agentUrl: string;

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
    webhookStatus = 200;
    credits = 100_000;

    webhook = startStubServer((_req, _body, res) => {
      res.writeHead(webhookStatus);
      res.end();
    });
    agent = startStubServer((req, _body, res) => {
      if (req.url === "/agent" && req.method === "GET") {
        respondJson(res, 200, { credits });
        return;
      }
      respondJson(res, 404, { error: "not found" });
    });

    await Promise.all([
      new Promise<void>((r) => webhook.server.listen(0, r)),
      new Promise<void>((r) => agent.server.listen(0, r)),
    ]);
    webhookUrl = `http://127.0.0.1:${(webhook.server.address() as AddressInfo).port}`;
    agentUrl = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  });

  let gateways: ReturnType<typeof createTestApp>[] = [];
  afterEach(async () => {
    // Stop the background schedulers FIRST, before the (async, real-HTTP-round-
    // trip) abort call — every extra await here widens the window in which a
    // still-ticking interval can fire once more and write into what's about to
    // become the next test's freshly-truncated tables.
    await Promise.all(gateways.map((g) => g.locals.stopBackgroundSchedulers?.()));
    await Promise.all(gateways.map((g) => request(g).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer())));
    gateways = [];
    await Promise.all([
      new Promise<void>((r) => webhook.server.close(() => r())),
      new Promise<void>((r) => agent.server.close(() => r())),
    ]);
  });

  const app = (opts: { intervalMs?: number; withMining?: boolean } = {}) => {
    const mining = opts.withMining
      ? {
          agentServiceUrl: agentUrl,
          fleetServiceUrl: agentUrl, // unused by these tests, but required by MiningConfig
          navigationServiceUrl: agentUrl,
          miningShipSymbol: "MINING-1",
          schedulerIntervalMs: 100_000, // effectively never ticks — these tests drive state directly
          replanIntervalMs: 100_000,
        }
      : undefined;
    const gateway = createTestApp(pool, clock, mining, undefined, {
      webhookUrl,
      intervalMs: opts.intervalMs ?? 15,
    });
    gateways.push(gateway);
    return gateway;
  };

  const waitForAnomaly = async (gateway: ReturnType<typeof createTestApp>, type: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
      const found = res.body.anomalies.find((a: { type: string }) => a.type === type);
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for anomaly type ${type}`);
  };

  const expectNoAnomaly = async (gateway: ReturnType<typeof createTestApp>, type: string, settleMs = 100) => {
    await new Promise((r) => setTimeout(r, settleMs));
    const res = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
    expect(res.body.anomalies.some((a: { type: string }) => a.type === type)).toBe(false);
  };

  it("fires ship_idle when a mining task hasn't changed in over the knob threshold, only while armed and live", async () => {
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, updated_at) VALUES ($1, 'EXTRACT', $2)`,
      ["MINING-1", clock.now()]
    );
    const gateway = app({ withMining: true });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({ token: "t" });

    await expectNoAnomaly(gateway, "ship_idle"); // not idle yet (default threshold is 10 minutes)

    clock.advance(11 * 60 * 1000);
    const anomaly = await waitForAnomaly(gateway, "ship_idle");
    expect(anomaly.detail.shipSymbol).toBe("MINING-1");
    expect(anomaly.detail.idleMinutes).toBeGreaterThan(10);
  }, 10_000);

  it("does not fire ship_idle while disarmed, even with a stale task", async () => {
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, updated_at) VALUES ($1, 'EXTRACT', $2)`,
      ["MINING-1", clock.now()]
    );
    clock.advance(60 * 60 * 1000);
    const gateway = app({ withMining: true });
    await expectNoAnomaly(gateway, "ship_idle");
  }, 10_000);

  it("fires earnings_stalled (reason: profit_drop) when the latest rollup is well below the trailing 6h average", async () => {
    // Seed 6 hourly rollups averaging 1000 credits/hour, then one much lower.
    for (let i = 6; i >= 1; i--) {
      const windowEnd = new Date(clock.now().getTime() - i * 60 * 60 * 1000);
      const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO metrics_rollup (window_start, window_end, computed_at, credits_per_hour, extraction_units, error_rate)
         VALUES ($1, $2, $2, $3, 0, 0)`,
        [windowStart, windowEnd, 1000]
      );
    }
    await pool.query(
      `INSERT INTO metrics_rollup (window_start, window_end, computed_at, credits_per_hour, extraction_units, error_rate)
       VALUES ($1, $2, $2, $3, 0, 0)`,
      [new Date(clock.now().getTime() - 60_000), clock.now(), 100] // way under 50% of the 1000 average
    );

    const gateway = app();
    const anomaly = await waitForAnomaly(gateway, "earnings_stalled");
    expect(anomaly.detail.reasons).toContain("profit_drop");
    expect(anomaly.detail.latestCreditsPerHour).toBe(100);
    expect(anomaly.detail.avg6hCreditsPerHour).toBeCloseTo(1000, 5);
  }, 10_000);

  it("does not fire earnings_stalled on a profit drop when the latest rollup is healthy", async () => {
    for (let i = 6; i >= 0; i--) {
      const windowEnd = new Date(clock.now().getTime() - i * 60 * 60 * 1000);
      const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO metrics_rollup (window_start, window_end, computed_at, credits_per_hour, extraction_units, error_rate)
         VALUES ($1, $2, $2, $3, 0, 0)`,
        [windowStart, windowEnd, 1000]
      );
    }
    const gateway = app();
    await expectNoAnomaly(gateway, "earnings_stalled");
  }, 10_000);

  it("fires consecutive_failures once a ship's failure_count reaches the knob limit", async () => {
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, failure_count, updated_at) VALUES ($1, 'EXTRACT', $2, $3)`,
      ["MINING-1", 3, clock.now()]
    );
    const gateway = app({ withMining: true });
    const anomaly = await waitForAnomaly(gateway, "consecutive_failures");
    expect(anomaly.detail.shipSymbol).toBe("MINING-1");
    expect(anomaly.detail.failureCount).toBe(3);
  }, 10_000);

  it("does not fire consecutive_failures below the limit", async () => {
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, failure_count, updated_at) VALUES ($1, 'EXTRACT', $2, $3)`,
      ["MINING-1", 2, clock.now()]
    );
    const gateway = app({ withMining: true });
    await expectNoAnomaly(gateway, "consecutive_failures");
  }, 10_000);

  it("fires error_rate when over 10% of mining_* events in the trailing window are errors", async () => {
    const rows = [
      "mining_extract",
      "mining_extract",
      "mining_extract",
      "mining_extract",
      "mining_extract",
      "mining_extract",
      "mining_extract",
      "mining_extract",
      "mining_extract",
      "mining_tick_error",
      "mining_tick_error", // 2/11 > 10%
    ];
    for (const type of rows) {
      await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, $2, '{}')`, [clock.now(), type]);
    }
    const gateway = app();
    const anomaly = await waitForAnomaly(gateway, "error_rate");
    expect(anomaly.detail.rate).toBeCloseTo(2 / 11, 5);
  }, 10_000);

  it("does not fire error_rate when errors are under the threshold", async () => {
    for (let i = 0; i < 20; i++) {
      await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_extract', '{}')`, [clock.now()]);
    }
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_tick_error', '{}')`, [clock.now()]);
    const gateway = app();
    await expectNoAnomaly(gateway, "error_rate");
  }, 10_000);

  it("fires earnings_stalled (reason: credits_flat) when agent credits show no net increase across the window", async () => {
    const gateway = app({ withMining: true });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({ token: "t" });

    // Force ticks instead of racing the real setInterval against the fake
    // clock: forceAnomalyTick() drains any tick already in flight and then
    // runs exactly one to completion, so nothing can straddle the mutations
    // below and observe a stale credits value stamped with an already-
    // advanced timestamp (see anomalyScheduler.ts's forceTick doc comment).
    await gateway.locals.forceAnomalyTick(); // first snapshot, at window start
    clock.advance(2 * 60 * 60 * 1000 + 60_000); // just past the 2h default window
    credits = 90_000; // credits dropped, not increased
    await gateway.locals.forceAnomalyTick(); // snapshot + check in one deterministic tick
    const anomaly = await waitForAnomaly(gateway, "earnings_stalled");
    expect(anomaly.detail.reasons).toContain("credits_flat");
    expect(anomaly.detail.netChange).toBeLessThanOrEqual(0);
  }, 10_000);

  it("does not fire earnings_stalled on flat credits when credits have grown", async () => {
    const gateway = app({ withMining: true });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({ token: "t" });

    await gateway.locals.forceAnomalyTick(); // first snapshot, at window start
    clock.advance(2 * 60 * 60 * 1000 + 60_000);
    credits = 150_000; // grew
    await gateway.locals.forceAnomalyTick(); // snapshot + check in one deterministic tick
    await expectNoAnomaly(gateway, "earnings_stalled", 0); // state is already settled, no wait needed
  }, 10_000);

  it("fires market_stale for a market not repriced within the staleness window, while active markets stay quiet", async () => {
    await pool.query(
      `INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_market_selected', $2)`,
      [new Date(clock.now().getTime() - 45 * 60 * 1000), JSON.stringify({ market: "X1-TEST-STALE", marketsChecked: ["X1-TEST-STALE"] })]
    );
    await pool.query(
      `INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_market_selected', $2)`,
      [clock.now(), JSON.stringify({ market: "X1-TEST-FRESH", marketsChecked: ["X1-TEST-FRESH"] })]
    );
    const gateway = app();
    const anomaly = await waitForAnomaly(gateway, "market_stale");
    expect(anomaly.detail.market).toBe("X1-TEST-STALE");
    const digest = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
    expect(digest.body.anomalies.some((a: { detail: { market?: string } }) => a.detail.market === "X1-TEST-FRESH")).toBe(false);
  }, 10_000);

  it("persists an anomaly before delivering it, and retries the webhook with backoff on failure before succeeding", async () => {
    webhookStatus = 500;
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, failure_count, updated_at) VALUES ($1, 'EXTRACT', $2, $3)`,
      ["MINING-1", 5, clock.now()]
    );
    const gateway = app({ withMining: true });

    // Persisted as soon as it's detected, before delivery (which retries with
    // backoff — default 3 attempts, ~200ms + ~400ms of delay — has finished).
    await waitForAnomaly(gateway, "consecutive_failures");
    await new Promise((r) => setTimeout(r, 800)); // let the full retry/backoff sequence finish
    const attemptsAfterFailure = webhook.calls.length;
    expect(attemptsAfterFailure).toBeGreaterThanOrEqual(3); // default maxAttempts

    const digestBefore = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
    expect(digestBefore.body.anomalies[0].deliveredAt).toBeNull();

    // Once the webhook recovers, it should stay quiet — the dedupe cooldown
    // suppresses a re-fire of the same still-open condition.
    webhookStatus = 200;
    await new Promise((r) => setTimeout(r, 100));
    expect(webhook.calls.length).toBe(attemptsAfterFailure); // no new delivery attempt — still within cooldown
  }, 10_000);

  it("dedupes repeat firings of the same condition within the cooldown window", async () => {
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, failure_count, updated_at) VALUES ($1, 'EXTRACT', $2, $3)`,
      ["MINING-1", 5, clock.now()]
    );
    const gateway = app({ withMining: true, intervalMs: 15 });
    await waitForAnomaly(gateway, "consecutive_failures");
    await new Promise((r) => setTimeout(r, 100)); // several more ticks, condition still true

    const digest = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
    const matching = digest.body.anomalies.filter((a: { type: string }) => a.type === "consecutive_failures");
    expect(matching).toHaveLength(1); // only fired once despite the condition persisting across ticks
  }, 10_000);

  it("digest endpoint returns anomalies and notable events for the requested window, excluding routine mining ticks", async () => {
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'armed', '{}')`, [clock.now()]);
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_extract', '{}')`, [clock.now()]);
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_task_failed', '{}')`, [clock.now()]);
    // Outside the requested window.
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'armed', '{}')`, [
      new Date(clock.now().getTime() - 2 * 60 * 60 * 1000),
    ]);

    const gateway = app();
    const res = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=60");
    expect(res.status).toBe(200);
    const eventTypes = res.body.events.map((e: { type: string }) => e.type);
    expect(eventTypes).toContain("armed");
    expect(eventTypes).toContain("mining_task_failed");
    expect(eventTypes).not.toContain("mining_extract"); // routine tick event, not notable
    expect(eventTypes.filter((t: string) => t === "armed")).toHaveLength(1); // the out-of-window one is excluded
  }, 10_000);

  it("has no /anomalies/digest route when anomaly detection isn't configured", async () => {
    const gateway = createTestApp(pool, clock);
    const res = await request(gateway).get("/api/automation/v1/anomalies/digest");
    expect(res.status).toBe(404);
  });
});

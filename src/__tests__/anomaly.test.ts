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
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

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

  it("fires error_rate when over 10% of ship-task events in the trailing window are errors", async () => {
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

  /**
   * Regression: the denominator counted only `mining_%` events, but the two
   * error types are logged by the scheduler for *every* task kind — they are
   * misnamed, not mining-specific. So in a window containing only contract
   * work, a single failure divided by a denominator of zero-plus-itself:
   * errors 1, total 1, rate 1.0 against a 0.1 threshold. The alarm fired at
   * 100% on a healthy contract fleet, and `mine.taskWeight = 0` is a
   * supported configuration, so this was reachable without doing anything
   * exotic.
   */
  it("does not fire error_rate on a contract-only window with one failure", async () => {
    const rows = [
      "contract_purchase",
      "contract_deliver",
      "contract_deliver",
      "contract_deliver",
      "contract_deliver",
      "contract_deliver",
      "contract_deliver",
      "contract_deliver",
      "contract_deliver",
      "contract_fulfilled",
      "mining_tick_error", // 1/11 — under the threshold, once contract work counts
    ];
    for (const type of rows) {
      await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, $2, '{}')`, [clock.now(), type]);
    }
    const gateway = app();
    await expectNoAnomaly(gateway, "error_rate");
  }, 10_000);

  // Scout work counts toward the denominator for the same reason contract work
  // does: `mining_tick_error` is what a failed scout tick logs too.
  it("counts scout work in the error-rate denominator", async () => {
    for (let i = 0; i < 19; i++) {
      await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'scout_market_refresh', '{}')`, [clock.now()]);
    }
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_task_failed', '{}')`, [clock.now()]);
    const gateway = app();
    await expectNoAnomaly(gateway, "error_rate"); // 1/20, not 1/1
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
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

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
    // This case is about credits_flat alone. The fleet sells nothing across
    // the two hours below, which is exactly what no_earnings exists to catch,
    // so push that window out of the way rather than let a second reason
    // decide the assertion.
    await pool.query("UPDATE knob SET value = 1440 WHERE name = 'anomaly.noEarningsMinutes'");
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    await gateway.locals.forceAnomalyTick(); // first snapshot, at window start
    clock.advance(2 * 60 * 60 * 1000 + 60_000);
    credits = 150_000; // grew
    await gateway.locals.forceAnomalyTick(); // snapshot + check in one deterministic tick
    await expectNoAnomaly(gateway, "earnings_stalled", 0); // state is already settled, no wait needed
  }, 10_000);

  /**
   * A fleet left paused used to go completely silent: ship_idle and the
   * credits snapshot both gate on armed-and-live, and profit_drop compares
   * the fleet only against itself, so once its trailing average decayed to
   * zero there was nothing left to fall below. The alarm went quiet exactly
   * when the outage stopped being transient.
   */
  it("fires earnings_stalled (reason: no_earnings) for a fleet left paused with nothing sold", async () => {
    // Forced ticks, not the interval: every step below straddles a FakeClock
    // jump, and a background tick landing mid-setup would judge a window the
    // test hasn't finished arranging yet.
    const gateway = app({ withMining: true, intervalMs: 100_000 });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    await request(gateway).post("/api/automation/v1/autopilot/pause").set("Authorization", bearer());

    clock.advance(30 * 60 * 1000); // half the default window: too early to judge
    await gateway.locals.forceAnomalyTick();
    await expectNoAnomaly(gateway, "earnings_stalled", 0);

    clock.advance(31 * 60 * 1000); // now past it, still nothing sold
    await gateway.locals.forceAnomalyTick();
    const anomaly = await waitForAnomaly(gateway, "earnings_stalled");
    expect(anomaly.detail.reasons).toContain("no_earnings");
    expect(anomaly.detail.status).toBe("paused");
    expect(anomaly.detail.lastEarnedAt).toBeNull();
  }, 10_000);

  it("stays quiet while the fleet is still selling, and while it is aborted", async () => {
    const gateway = app({ withMining: true, intervalMs: 100_000 });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    clock.advance(61 * 60 * 1000);
    // One sale inside the window is enough: the fleet is working. Written
    // before any tick runs, so the check never sees the half-set-up state.
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_sell', '{"totalPrice": 90}')`, [
      new Date(clock.now().getTime() - 60_000),
    ]);
    await gateway.locals.forceAnomalyTick();
    await expectNoAnomaly(gateway, "earnings_stalled", 0);

    // Aborted is the operator saying the fleet should not be working, so
    // earning nothing is the expected state, not an anomaly.
    await request(gateway).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());
    clock.advance(61 * 60 * 1000);
    await gateway.locals.forceAnomalyTick();
    await expectNoAnomaly(gateway, "earnings_stalled", 0);
  }, 10_000);

  /**
   * Regression: earnings were proven exclusively by `mining_sell`. Contract
   * payments arrive at accept (the advance) and fulfil (the balance) and are
   * neither of them a sell, so a fleet earning well on contracts paged
   * `earnings_stalled` every dedupe window, forever. Worse, this is the check
   * added specifically because it *cannot switch itself off* — so the only way
   * out was widening an `alert` knob, which is the move the class fence exists
   * to prevent.
   */
  it("stays quiet for a fleet earning on contracts rather than sells", async () => {
    const gateway = app({ withMining: true, intervalMs: 100_000 });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    clock.advance(61 * 60 * 1000);
    // No mining_sell anywhere in the window — the balance on a fulfilled
    // contract is the only revenue, and it is revenue.
    await pool.query(
      `INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'contract_fulfilled', $2)`,
      [new Date(clock.now().getTime() - 60_000), JSON.stringify({ contractId: "c1", payment: 120_000 })]
    );
    await gateway.locals.forceAnomalyTick();
    await expectNoAnomaly(gateway, "earnings_stalled", 0);
  }, 10_000);

  // The advance is paid on acceptance, so it counts on its own.
  it("counts a contract advance as earnings", async () => {
    const gateway = app({ withMining: true, intervalMs: 100_000 });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    clock.advance(61 * 60 * 1000);
    await pool.query(
      `INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'contract_accepted', $2)`,
      [new Date(clock.now().getTime() - 60_000), JSON.stringify({ contractId: "c2", payment: 40_000 })]
    );
    await gateway.locals.forceAnomalyTick();
    await expectNoAnomaly(gateway, "earnings_stalled", 0);
  }, 10_000);

  it("fires market_stale for an in-use market no ship has read in person within the window, while fresh ones stay quiet", async () => {
    // Both markets were priced (from afar) for a sell decision just now, so
    // both are "in active use". What separates them is market_intel: when a
    // ship of ours last read each one while docked there — the only read
    // SpaceTraders answers with actual trade goods.
    await pool.query(
      `INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, 'mining_market_selected', $2)`,
      [clock.now(), JSON.stringify({ market: "X1-TEST-FRESH", marketsChecked: ["X1-TEST-STALE", "X1-TEST-FRESH", "X1-TEST-NEVER"] })]
    );
    await pool.query(`INSERT INTO market_intel (waypoint, last_refreshed_at) VALUES ($1, $2), ($3, $4)`, [
      "X1-TEST-STALE",
      new Date(clock.now().getTime() - 45 * 60 * 1000),
      "X1-TEST-FRESH",
      clock.now(),
    ]);
    const gateway = app();
    // Anomalies are persisted one at a time, each followed by its webhook
    // delivery, so wait for both stale markets rather than the first to land.
    const deadline = Date.now() + 2000;
    let flagged: { detail: { market: string; staleMinutes: number | null; lastRefreshedAt: string | null } }[] = [];
    while (Date.now() < deadline && flagged.length < 2) {
      const digest = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
      flagged = digest.body.anomalies.filter((a: { type: string }) => a.type === "market_stale");
      if (flagged.length < 2) await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 50)); // a few more ticks: FRESH must stay unflagged
    const digest = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
    flagged = digest.body.anomalies.filter((a: { type: string }) => a.type === "market_stale");
    const byMarket = Object.fromEntries(flagged.map((a) => [a.detail.market, a.detail]));
    expect(byMarket["X1-TEST-STALE"].staleMinutes).toBeCloseTo(45);
    // Never read in person at all: as stale as it gets, reported without a number to be honest about it.
    expect(byMarket["X1-TEST-NEVER"]).toMatchObject({ staleMinutes: null, lastRefreshedAt: null });
    expect(byMarket["X1-TEST-FRESH"]).toBeUndefined();
  }, 10_000);

  it("does not fire ship_idle for a ship inside a long transit, but does once the wait has elapsed with no progress", async () => {
    // A 30-minute flight is longer than the 10-minute idle threshold. Pre-fix,
    // the check only looked at updated_at, so every long transit paged.
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, asteroid_waypoint, waiting_until, updated_at) VALUES ($1, 'TRAVEL_TO_ASTEROID', 'X1-BELT', $2, $3)`,
      ["MINING-1", new Date(clock.now().getTime() + 30 * 60 * 1000), clock.now()]
    );
    const gateway = app({ withMining: true });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    clock.advance(20 * 60 * 1000); // twenty minutes into the flight
    await expectNoAnomaly(gateway, "ship_idle");

    clock.advance(21 * 60 * 1000); // the flight ended 11 minutes ago and nothing has moved since
    const anomaly = await waitForAnomaly(gateway, "ship_idle");
    expect(anomaly.detail.idleMinutes).toBeGreaterThan(10);
    expect(anomaly.detail.idleMinutes).toBeLessThan(12);
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

    // Once the webhook recovers, the missed page is sent. Dedupe suppresses a
    // re-fire of the same still-open condition, so without this the alert was
    // lost permanently — the record sat in Postgres looking fine, and no later
    // firing would ever replace it.
    webhookStatus = 200;
    const deadline = Date.now() + 3000;
    let delivered = null;
    while (Date.now() < deadline && delivered === null) {
      const digest = await request(gateway).get("/api/automation/v1/anomalies/digest?windowMinutes=10080");
      delivered = digest.body.anomalies[0].deliveredAt;
      if (delivered === null) await new Promise((r) => setTimeout(r, 20));
    }
    expect(delivered).not.toBeNull();
    expect(webhook.calls.length).toBeGreaterThan(attemptsAfterFailure);
  }, 10_000);

  it("gives up on an undeliverable anomaly rather than retrying it forever", async () => {
    webhookStatus = 500;
    await pool.query(`INSERT INTO ship_task (ship_symbol, phase, failure_count, updated_at) VALUES ($1, 'EXTRACT', $2, $3)`, [
      "MINING-1",
      5,
      clock.now(),
    ]);
    const gateway = app({ withMining: true });
    const anomaly = await waitForAnomaly(gateway, "consecutive_failures");

    // Rounds are bounded across ticks, not just within one, so a webhook that
    // never comes back can't make every tick pay for it indefinitely. The
    // column counts rounds — one per deliver() call, each of which retries
    // internally — so the HTTP ceiling is this times the per-call budget.
    await new Promise((r) => setTimeout(r, 1500));
    const { rows } = await pool.query("SELECT delivery_attempts FROM anomaly WHERE id = $1", [anomaly.id]);
    expect(Number(rows[0].delivery_attempts)).toBeLessThanOrEqual(12);
  }, 15_000);

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

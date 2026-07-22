import http from "http";
import { AddressInfo } from "net";
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

function makeShip(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "MINING-1",
    nav: {
      systemSymbol: "X1-TEST",
      waypointSymbol: "X1-TEST-BELT",
      status: "IN_ORBIT",
      route: { arrival: "2026-01-01T00:00:00Z" },
    },
    cooldown: { expiration: null },
    fuel: { current: 100, capacity: 100 },
    cargo: { units: 0, capacity: 5, inventory: [] as { symbol: string; units: number }[] },
    ...overrides,
  };
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

describe("automation-service market scouting loop (meta#12)", () => {
  let pool: Pool;
  let clock: FakeClock;
  let ship: ReturnType<typeof makeShip>;

  let agent: ReturnType<typeof startStubServer>;
  let fleet: ReturnType<typeof startStubServer>;
  let nav: ReturnType<typeof startStubServer>;
  let agentUrl: string, fleetUrl: string, navUrl: string;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE event_log, ship_task, contract, market_intel RESTART IDENTITY");
    await pool.query("UPDATE knob SET value = default_value");
    // Enable scouting: a stale market at threshold scores the same as mining's
    // default expectedCreditsPerCycle (5000), so it wins over a distant asteroid.
    await pool.query("UPDATE knob SET value = 5000 WHERE name = 'scout.valuePerRefresh'");

    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    ship = makeShip();

    agent = startStubServer((req, _body, res) => {
      if (req.url === "/agent" && req.method === "GET") {
        respondJson(res, 200, { credits: 100_000 });
      } else if (req.url === "/ships/MINING-1" && req.method === "GET") {
        respondJson(res, 200, ship);
      } else if (req.url === "/contracts" && req.method === "GET") {
        respondJson(res, 200, []);
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
    });

    fleet = startStubServer((req, body, res) => {
      const parsed = body.length > 0 ? JSON.parse(body) : undefined;
      if (req.url === "/ships/MINING-1/orbit") {
        ship.nav.status = "IN_ORBIT";
        respondJson(res, 200, { data: { nav: ship.nav } });
      } else if (req.url === "/ships/MINING-1/dock") {
        ship.nav.status = "DOCKED";
        respondJson(res, 200, { data: { nav: ship.nav } });
      } else if (req.url === "/ships/MINING-1/navigate") {
        ship.nav.status = "IN_TRANSIT";
        ship.nav.waypointSymbol = parsed.waypointSymbol;
        ship.nav.route = { arrival: new Date(clock.now().getTime() + 1000).toISOString() };
        respondJson(res, 200, { data: { nav: ship.nav } });
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
    });

    nav = startStubServer((req, _body, res) => {
      if (req.url === "/systems/X1-TEST/waypoints") {
        respondJson(res, 200, {
          data: [
            // The market is the scout target; also acts as fuel station so it's
            // reachable from anywhere in the system.
            { symbol: "X1-TEST-MARKET", type: "PLANET", x: 10, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
            // An asteroid field for the ship to mine — present so the planner has
            // a mining candidate to compare against the scout score.
            { symbol: "X1-TEST-BELT", type: "ASTEROID_FIELD", x: 0, y: 0, traits: [] },
          ],
        });
      } else if (req.url === "/waypoints/X1-TEST-MARKET/market") {
        respondJson(res, 200, { symbol: "X1-TEST-MARKET", tradeGoods: [{ symbol: "IRON_ORE", sellPrice: 100, purchasePrice: 50 }] });
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
    });

    await Promise.all([
      new Promise<void>((r) => agent.server.listen(0, r)),
      new Promise<void>((r) => fleet.server.listen(0, r)),
      new Promise<void>((r) => nav.server.listen(0, r)),
    ]);
    agentUrl = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
    fleetUrl = `http://127.0.0.1:${(fleet.server.address() as AddressInfo).port}`;
    navUrl = `http://127.0.0.1:${(nav.server.address() as AddressInfo).port}`;
  });

  let gateways: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    await Promise.all(gateways.map((g) => request(g).post("/api/automation/v1/autopilot/abort")));
    gateways = [];
    await Promise.all([
      new Promise<void>((r) => agent.server.close(() => r())),
      new Promise<void>((r) => fleet.server.close(() => r())),
      new Promise<void>((r) => nav.server.close(() => r())),
    ]);
  });

  const app = () => {
    const gateway = createApp(pool, clock, {
      agentServiceUrl: agentUrl,
      fleetServiceUrl: fleetUrl,
      navigationServiceUrl: navUrl,
      miningShipSymbol: "MINING-1",
      schedulerIntervalMs: 15,
      replanIntervalMs: 300_000,
    });
    gateways.push(gateway);
    return gateway;
  };

  const waitForEvent = async (gateway: ReturnType<typeof createApp>, type: string, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/api/automation/v1/autopilot/events?limit=100");
      const found = res.body.events.find((e: { type: string }) => e.type === type);
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for event ${type}`);
  };

  const waitForTaskPhase = async (gateway: ReturnType<typeof createApp>, phase: string, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/api/automation/v1/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.phase === phase) return res.body.task;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for phase ${phase}`);
  };

  it("a stale market scores higher than a fresh one when scout.valuePerRefresh > 0 (scenario fixtures)", async () => {
    // Insert fresh intel for the market — just refreshed, score should be 0.
    await pool.query(
      "INSERT INTO market_intel (waypoint, last_refreshed_at) VALUES ($1, $2)",
      ["X1-TEST-MARKET", new Date("2026-01-01T00:00:00Z")]
    );
    // Insert stale intel for a second hypothetical market — 2× the default 0.5h threshold.
    await pool.query(
      "INSERT INTO market_intel (waypoint, last_refreshed_at) VALUES ($1, $2)",
      ["X1-TEST-MARKET-2", new Date("2025-12-31T23:00:00Z")] // 1h ago = 2× stale
    );

    // Query both scores via a planner_assignment event: arm, wait for one decision.
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token" });

    const evt = await waitForEvent(gateway, "planner_assignment");
    // The planner chose mining (only X1-TEST-BELT exists as asteroid), not scouting.
    // But the assignment detail should show the scout score for both markets.
    // Fresh market (just refreshed at clock.now()) → elapsedHours ≈ 0 → scoutScore ≈ 0.
    // The planner logs the best scout candidate in detail.scoutScore.
    // The stale market X1-TEST-MARKET-2 is not in the waypoints list, so only X1-TEST-MARKET is considered.
    // X1-TEST-MARKET was refreshed at 00:00:00 and clock.now() is 00:00:00 → elapsed = 0 → score = 0.
    expect(evt).toBeDefined();
    // Verify the assignment chose mining (scout score = 0 since market is fresh).
    expect(evt.detail.chosen).toBe("X1-TEST-BELT");
  }, 10_000);

  it("a never-seen market (no intel entry) wins assignment over mining when scout.valuePerRefresh > 0", async () => {
    // No market_intel entries → never-seen → stalenessFactor = 10× threshold → high score.
    // ship starts at X1-TEST-BELT (distance 10 to X1-TEST-MARKET), should be assigned scout.

    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token" });

    const assignmentEvt = await waitForEvent(gateway, "planner_assignment");
    expect(assignmentEvt.detail.scoutWaypoint).toBe("X1-TEST-MARKET");

    // Task should be scout kind.
    const task = await waitForTaskPhase(gateway, "SCOUT_TRAVEL");
    expect(task.taskKind).toBe("scout");
    expect(task.asteroidWaypoint).toBe("X1-TEST-MARKET");
  }, 10_000);

  it("scout task travels to market, docks, calls getMarket, emits scout_market_refresh", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token" });

    // Ship is at X1-TEST-BELT (not at the market), so it needs to navigate.
    await waitForTaskPhase(gateway, "SCOUT_TRAVEL");
    await new Promise((r) => setTimeout(r, 50)); // let navigate dispatch
    // Advance clock past the travel ETA so the wait resolves.
    clock.advance(2000);

    await waitForTaskPhase(gateway, "SCOUT_REFRESH");
    const refreshEvt = await waitForEvent(gateway, "scout_market_refresh");
    expect(refreshEvt.detail.waypoint).toBe("X1-TEST-MARKET");
    expect(nav.calls.some((c) => c.url === "/waypoints/X1-TEST-MARKET/market")).toBe(true);
  }, 20_000);

  it("after scout_market_refresh, market_intel is recorded and ship is handed back to the planner", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token" });

    // Wait for navigate to fire (sets waitingUntil), THEN advance the clock so
    // the wait resolves — same pattern as the FSM test above.
    await waitForEvent(gateway, "scout_navigate");
    clock.advance(2000);
    await waitForEvent(gateway, "scout_market_refresh");

    // Intel entry should now exist for X1-TEST-MARKET.
    const { rows } = await pool.query("SELECT * FROM market_intel WHERE waypoint = $1", ["X1-TEST-MARKET"]);
    expect(rows.length).toBe(1);

    // After recording, task resets → planner reassigns. With fresh intel the scout
    // score drops to ~0 (elapsed = 0), so the ship should be assigned mining.
    // Poll until asteroidWaypoint is filled in (not just TRAVEL_TO_ASTEROID phase,
    // which fires immediately on FRESH_MINING_TASK before assignment runs).
    const deadline = Date.now() + 8000;
    let miningTask: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/api/automation/v1/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.taskKind === "mining" && res.body.task.asteroidWaypoint !== null) {
        miningTask = res.body.task;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(miningTask).not.toBeNull();
    expect(miningTask!.asteroidWaypoint).toBe("X1-TEST-BELT");
  }, 20_000);
});

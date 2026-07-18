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

/** Minimal mutable SpaceTraders-shaped ship the agent-service stub serves. */
function makeShip(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "MINING-1",
    nav: {
      systemSymbol: "X1-TEST",
      waypointSymbol: "X1-TEST-MARKET",
      status: "DOCKED",
      route: { arrival: "2026-01-01T00:00:00Z" },
    },
    cooldown: { expiration: null },
    fuel: { current: 60, capacity: 100 },
    cargo: { units: 0, capacity: 1, inventory: [] as { symbol: string; units: number }[] },
    ...overrides,
  };
}

/** Starts a stub for one of the three existing services; test mutates `state` to drive responses. */
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

describe("automation-service mining loop", () => {
  let pool: Pool;
  let clock: FakeClock;
  let ship: ReturnType<typeof makeShip>;

  let agent: ReturnType<typeof startStubServer>;
  let fleet: ReturnType<typeof startStubServer>;
  let nav: ReturnType<typeof startStubServer>;
  let agentUrl: string, fleetUrl: string, navUrl: string;
  let agentResponseDelayMs = 0;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE event_log, ship_task RESTART IDENTITY");
    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    ship = makeShip();
    agentResponseDelayMs = 0;

    agent = startStubServer((req, _body, res) => {
      if (req.url === "/agent" && req.method === "GET") {
        respondJson(res, 200, { credits: 100_000 });
        return;
      }
      if (req.url === "/ships/MINING-1" && req.method === "GET") {
        // Real SpaceTraders auto-flips IN_TRANSIT -> IN_ORBIT once the arrival
        // time passes, with no client action required. Mirror that here against
        // the same fake clock the test controls, instead of leaving nav.status
        // stuck at IN_TRANSIT forever (which would make later phases misread a
        // long-finished transit as still in flight).
        if (ship.nav.status === "IN_TRANSIT" && clock.now() >= new Date(ship.nav.route.arrival)) {
          ship.nav.status = "IN_ORBIT";
        }
        const respond = () => respondJson(res, 200, ship);
        if (agentResponseDelayMs > 0) setTimeout(respond, agentResponseDelayMs);
        else respond();
        return;
      }
      if (req.url === "/contracts" && req.method === "GET") {
        respondJson(res, 200, []); // no contracts in this suite — mining-only fixtures
        return;
      }
      respondJson(res, 404, { error: "not found" });
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
        const arrival = new Date(clock.now().getTime() + 1000).toISOString();
        ship.nav.route = { arrival };
        respondJson(res, 200, { data: { nav: ship.nav } });
      } else if (req.url === "/ships/MINING-1/survey") {
        const expiration = new Date(clock.now().getTime() + 500).toISOString();
        respondJson(res, 200, {
          data: {
            surveys: [
              { signature: "SIG-1", symbol: "X1-TEST-BELT", deposits: [{ symbol: "IRON_ORE" }], expiration: new Date(clock.now().getTime() + 60_000).toISOString(), size: "MODERATE" },
            ],
            cooldown: { expiration },
          },
        });
      } else if (req.url === "/ships/MINING-1/extract/survey") {
        const expiration = new Date(clock.now().getTime() + 500).toISOString();
        ship.cargo = { units: 1, capacity: 1, inventory: [{ symbol: "IRON_ORE", units: 1 }] };
        respondJson(res, 200, {
          data: { extraction: { yield: { symbol: "IRON_ORE", units: 1 } }, cooldown: { expiration } },
        });
      } else if (req.url === "/ships/MINING-1/sell") {
        ship.cargo = { units: 0, capacity: 1, inventory: [] };
        respondJson(res, 200, { data: { agent: {}, transaction: { totalPrice: 50 } } });
      } else if (req.url === "/ships/MINING-1/refuel") {
        ship.fuel.current = ship.fuel.capacity;
        respondJson(res, 200, { data: { agent: {} } });
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
    });

    nav = startStubServer((req, _body, res) => {
      if (req.url === "/systems/X1-TEST/waypoints") {
        respondJson(res, 200, {
          data: [
            { symbol: "X1-TEST-MARKET", type: "PLANET", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
            { symbol: "X1-TEST-BELT", type: "ASTEROID_FIELD", x: 10, y: 0, traits: [] },
          ],
        });
      } else if (req.url === "/waypoints/X1-TEST-MARKET/market") {
        respondJson(res, 200, { symbol: "X1-TEST-MARKET", tradeGoods: [{ symbol: "IRON_ORE", sellPrice: 50 }] });
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
    // Every scheduler runs a real (unref'd) setInterval; stop each one explicitly
    // so it doesn't keep firing — and hitting the now-closed stub servers or the
    // ended pool — after the test that created it has finished.
    await Promise.all(gateways.map((g) => request(g).post("/autopilot/abort")));
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

  const waitForPhase = async (gateway: ReturnType<typeof createApp>, phase: string, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.phase === phase) return res.body.task;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for phase ${phase}`);
  };

  const waitForWaiting = async (gateway: ReturnType<typeof createApp>, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.waitingUntil !== null) return res.body.task;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("timed out waiting for a wait to be set");
  };

  it("runs a full mining cycle: travel, survey, extract, sell, refuel, and loops back", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });

    // TRAVEL_TO_ASTEROID: ship starts DOCKED elsewhere -> orbit, then navigate.
    await waitForPhase(gateway, "TRAVEL_TO_ASTEROID");
    await waitForWaiting(gateway); // navigate dispatched, waitingUntil set to +1000ms
    clock.advance(1000);
    await waitForPhase(gateway, "SURVEY");

    // SURVEY: dispatches survey, waits out its cooldown.
    await waitForWaiting(gateway);
    clock.advance(500);
    await waitForPhase(gateway, "EXTRACT");

    // EXTRACT: cargo capacity is 1, so a single extract fills it.
    await waitForWaiting(gateway);
    clock.advance(500);
    await waitForPhase(gateway, "TRAVEL_TO_MARKET");

    // TRAVEL_TO_MARKET: resolves best market via navigation-service, then navigates to it.
    await waitForWaiting(gateway);
    clock.advance(1000);
    await waitForPhase(gateway, "SELL");

    // SELL: dock -> sell -> refuel -> cycle completes back to TRAVEL_TO_ASTEROID.
    await waitForPhase(gateway, "TRAVEL_TO_ASTEROID");

    const eventsRes = await request(gateway).get("/autopilot/events?limit=50");
    const eventTypes = eventsRes.body.events.map((e: { type: string }) => e.type).reverse();
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "mining_orbit",
        "mining_navigate",
        "mining_wait_resolved",
        "mining_survey",
        "mining_extract",
        "mining_cargo_full",
        "mining_market_selected",
        "mining_dock",
        "mining_sell",
        "mining_refuel",
        "mining_cycle_complete",
      ])
    );

    const finalTask = await request(gateway).get("/autopilot/ships/MINING-1").then((r) => r.body.task);
    expect(finalTask.marketWaypoint).toBeNull();
    expect(finalTask.tradeSymbol).toBeNull();
    expect(ship.fuel.current).toBe(ship.fuel.capacity);
    expect(ship.cargo.units).toBe(0);
  }, 20_000);

  it("lets the current wait finish on pause, then idles without dispatching the next action", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });

    await waitForWaiting(gateway); // mid navigate-to-asteroid
    await request(gateway).post("/autopilot/pause");

    clock.advance(1000); // let the in-flight wait elapse
    await waitForPhase(gateway, "SURVEY"); // pause still lets this one wait resolve

    const callsAfterResolve = fleet.calls.length;
    await new Promise((r) => setTimeout(r, 150)); // several scheduler ticks' worth of real time
    expect(fleet.calls.length).toBe(callsAfterResolve); // no new action dispatched while paused and idle

    await request(gateway).post("/autopilot/abort");
    const statusRes = await request(gateway).get("/autopilot/status");
    expect(statusRes.body.status).toBe("aborted");
  }, 10_000);

  it("resumes from the persisted phase after a restart instead of starting over", async () => {
    const firstRun = app();
    await request(firstRun).post("/autopilot/arm").send({ token: "test-token" });
    await waitForWaiting(firstRun); // navigate to asteroid dispatched
    clock.advance(1000);
    await waitForPhase(firstRun, "SURVEY");
    await request(firstRun).post("/autopilot/abort"); // simulates disarm-on-restart

    const callsBeforeRestart = fleet.calls.length;

    const restarted = app(); // fresh app instance == fresh process, same DB
    await request(restarted).post("/autopilot/arm").send({ token: "test-token" });

    const task = await request(restarted).get("/autopilot/ships/MINING-1").then((r) => r.body.task);
    expect(task.phase).toBe("SURVEY"); // resumed, not reset to TRAVEL_TO_ASTEROID

    await new Promise((r) => setTimeout(r, 60));
    // Never re-dispatches orbit/navigate (already-completed steps) on resume.
    const dispatchedAgain = fleet.calls
      .slice(callsBeforeRestart)
      .some((c) => c.url === "/ships/MINING-1/orbit" || c.url === "/ships/MINING-1/navigate");
    expect(dispatchedAgain).toBe(false);
  }, 10_000);

  it("discards a tick's result instead of persisting or logging it as a real action if abort lands mid-flight", async () => {
    // The dispatch itself can't be un-sent once the tick has awaited it — but
    // an abort that lands while that await is in flight must still stop the
    // result from being recorded as something the (now-aborted) autopilot did.
    agentResponseDelayMs = 250;
    // Pre-seed an already-assigned target so tick 1 goes straight to dispatch
    // (orbit) rather than spending its one atomic action on planning first —
    // this test is specifically about discarding an in-flight dispatch.
    await pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, asteroid_waypoint, updated_at) VALUES ($1, $2, $3, $4)`,
      ["MINING-1", "TRAVEL_TO_ASTEROID", "X1-TEST-BELT", clock.now()]
    );
    const gateway = app();

    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });
    await new Promise((r) => setTimeout(r, 30)); // let the first tick start (and block on the slow getShip call)
    await request(gateway).post("/autopilot/abort");

    await new Promise((r) => setTimeout(r, 400)); // let the delayed response land and the tick finish

    expect(fleet.calls.some((c) => c.url === "/ships/MINING-1/orbit")).toBe(true); // dispatch really happened

    const eventsRes = await request(gateway).get("/autopilot/events?limit=50");
    const eventTypes = eventsRes.body.events.map((e: { type: string }) => e.type);
    expect(eventTypes).not.toContain("mining_orbit"); // never recorded as a real, autopilot-owned action
    expect(eventTypes).toContain("mining_discarded_after_abort");
  }, 10_000);
});

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
      waypointSymbol: "X1-TEST-MARKET",
      status: "DOCKED",
      route: { arrival: "2026-01-01T00:00:00Z" },
    },
    cooldown: { expiration: null },
    fuel: { current: 100, capacity: 100 },
    cargo: { units: 0, capacity: 5, inventory: [] as { symbol: string; units: number }[] },
    ...overrides,
  };
}

function makeContract(overrides: Record<string, unknown> = {}) {
  return {
    id: "CONTRACT-1",
    factionSymbol: "COSMIC",
    type: "PROCUREMENT",
    terms: {
      deadline: "2026-06-01T00:00:00Z",
      payment: { onAccepted: 1000, onFulfilled: 19000 },
      deliver: [{ tradeSymbol: "IRON_ORE", destinationSymbol: "X1-TEST-DEST", unitsRequired: 2, unitsFulfilled: 0 }],
    },
    accepted: false,
    fulfilled: false,
    expiration: "2026-07-01T00:00:00Z",
    deadlineToAccept: "2026-02-01T00:00:00Z",
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

describe("automation-service contract loop (meta#11)", () => {
  let pool: Pool;
  let clock: FakeClock;
  let ship: ReturnType<typeof makeShip>;
  let contracts: ReturnType<typeof makeContract>[];
  let purchasePrice = 5;
  let includeAsteroidField = false;

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
    await pool.query("TRUNCATE event_log, ship_task, contract RESTART IDENTITY");
    await pool.query("UPDATE knob SET value = default_value");
    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    ship = makeShip();
    contracts = [makeContract()];
    purchasePrice = 5;
    includeAsteroidField = false;

    agent = startStubServer((req, body, res) => {
      const parsed = body.length > 0 ? JSON.parse(body) : undefined;
      if (req.url === "/agent" && req.method === "GET") {
        respondJson(res, 200, { credits: 100_000 });
      } else if (req.url === "/ships/MINING-1" && req.method === "GET") {
        if (ship.nav.status === "IN_TRANSIT" && clock.now() >= new Date(ship.nav.route.arrival)) {
          ship.nav.status = "IN_ORBIT";
        }
        respondJson(res, 200, ship);
      } else if (req.url === "/contracts" && req.method === "GET") {
        respondJson(res, 200, contracts);
      } else if (req.url?.match(/^\/contracts\/[\w-]+\/accept$/) && req.method === "POST") {
        const id = req.url.split("/")[2];
        const contract = contracts.find((c) => c.id === id)!;
        contract.accepted = true;
        respondJson(res, 200, { agent: { credits: 100_000 - contract.terms.payment.onAccepted }, contract });
      } else if (req.url?.match(/^\/contracts\/[\w-]+\/fulfill$/) && req.method === "POST") {
        const id = req.url.split("/")[2];
        const contract = contracts.find((c) => c.id === id)!;
        contract.fulfilled = true;
        respondJson(res, 200, { agent: { credits: 100_000 + contract.terms.payment.onFulfilled }, contract });
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
      void parsed;
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
      } else if (req.url === "/ships/MINING-1/purchase") {
        const existing = ship.cargo.inventory.find((i) => i.symbol === parsed.symbol);
        if (existing) existing.units += parsed.units;
        else ship.cargo.inventory.push({ symbol: parsed.symbol, units: parsed.units });
        ship.cargo.units += parsed.units;
        respondJson(res, 200, { data: { transaction: { totalPrice: parsed.units * purchasePrice } } });
      } else if (req.url?.match(/^\/contracts\/[\w-]+\/deliver$/)) {
        const item = ship.cargo.inventory.find((i) => i.symbol === parsed.tradeSymbol);
        if (item !== undefined) {
          item.units -= parsed.units;
          ship.cargo.units -= parsed.units;
        }
        respondJson(res, 200, { data: { contract: {} } });
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
    });

    nav = startStubServer((req, _body, res) => {
      if (req.url === "/systems/X1-TEST/waypoints") {
        const waypoints = [
          { symbol: "X1-TEST-MARKET", type: "PLANET", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
          { symbol: "X1-TEST-DEST", type: "PLANET", x: 20, y: 0, traits: [] },
        ];
        if (includeAsteroidField) {
          waypoints.push({ symbol: "X1-TEST-BELT", type: "ASTEROID_FIELD", x: 5, y: 0, traits: [] });
        }
        respondJson(res, 200, { data: waypoints });
      } else if (req.url === "/waypoints/X1-TEST-MARKET/market") {
        respondJson(res, 200, { symbol: "X1-TEST-MARKET", tradeGoods: [{ symbol: "IRON_ORE", sellPrice: 3, purchasePrice }] });
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

  const waitForEvent = async (gateway: ReturnType<typeof createApp>, type: string, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/autopilot/events?limit=100");
      const found = res.body.events.find((e: { type: string }) => e.type === type);
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for event ${type}`);
  };

  const waitForTaskPhase = async (gateway: ReturnType<typeof createApp>, phase: string, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.phase === phase) return res.body.task;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for phase ${phase}`);
  };

  const waitForWaiting = async (gateway: ReturnType<typeof createApp>, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.waitingUntil !== null) return res.body.task;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("timed out waiting for a wait to be set");
  };

  it("declines an unprofitable contract and logs the evaluation without accepting it", async () => {
    // Procurement dominates payment: 2 units * 5000/unit = 10000 >> 20000 total payment isn't
    // even close once travel is added — flip it: make the good absurdly expensive.
    purchasePrice = 50_000;

    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });

    const evaluated = await waitForEvent(gateway, "contract_evaluated");
    expect(evaluated.detail.accepted).toBe(false);
    expect(evaluated.detail.contractId).toBe("CONTRACT-1");
    expect(evaluated.detail.expectedProfit).toBeLessThan(0);

    await new Promise((r) => setTimeout(r, 100));
    expect(agent.calls.some((c) => c.url === "/contracts/CONTRACT-1/accept")).toBe(false);
  }, 20_000);

  it("accepts a profitable contract, procures, delivers, and fulfills it without operator input", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });

    const evaluated = await waitForEvent(gateway, "contract_evaluated");
    expect(evaluated.detail.accepted).toBe(true);
    await waitForEvent(gateway, "contract_accepted");
    expect(agent.calls.some((c) => c.url === "/contracts/CONTRACT-1/accept")).toBe(true);

    // Assignment: the only accepted contract should win (no mining field configured).
    // The ship starts at the procurement market, so CONTRACT_TRAVEL_TO_MARKET
    // resolves to "arrived" on its very first tick — too narrow a window to
    // reliably poll for — so wait straight through to CONTRACT_PURCHASE.
    await waitForTaskPhase(gateway, "CONTRACT_PURCHASE");
    await waitForEvent(gateway, "contract_purchase");
    expect(ship.cargo.inventory.find((i) => i.symbol === "IRON_ORE")?.units).toBe(2);

    await waitForTaskPhase(gateway, "CONTRACT_TRAVEL_TO_DESTINATION");
    await waitForWaiting(gateway);
    clock.advance(2000);
    await waitForTaskPhase(gateway, "CONTRACT_DELIVER");

    await waitForEvent(gateway, "contract_deliver");
    await waitForTaskPhase(gateway, "TRAVEL_TO_ASTEROID"); // fulfilled -> handed back to mining

    expect(agent.calls.some((c) => c.url === "/contracts/CONTRACT-1/fulfill")).toBe(true);

    const finalTask = await request(gateway).get("/autopilot/ships/MINING-1").then((r) => r.body.task);
    expect(finalTask.taskKind).toBe("mining");
    expect(finalTask.contractId).toBeNull();
  }, 20_000);

  it("a contract task wins assignment over mining when it scores higher", async () => {
    includeAsteroidField = true; // mining's flat mine.expectedCreditsPerCycle default is 5000/cycle
    // Contract's default fixture pays 20000 total for 2 cheap units — should trounce mining's flat estimate.

    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });

    await waitForEvent(gateway, "contract_accepted");
    // Waits until the assigned task is a contract — CONTRACT_TRAVEL_TO_MARKET
    // itself resolves within one tick (the ship starts at the procurement
    // market), too narrow a window to poll for reliably.
    const task = await waitForTaskPhase(gateway, "CONTRACT_PURCHASE");
    expect(task.taskKind).toBe("contract");
    expect(task.asteroidWaypoint).toBeNull();

    const assignmentEvent = await waitForEvent(gateway, "planner_assignment");
    expect(assignmentEvent.detail.contractId).toBe("CONTRACT-1");
    expect(assignmentEvent.detail.contractScore).toBeGreaterThan(assignmentEvent.detail.miningScore);
  }, 20_000);

  it("resumes a contract task from its persisted phase after a restart instead of restarting it", async () => {
    const firstRun = app();
    await request(firstRun).post("/autopilot/arm").send({ token: "test-token" });
    await waitForTaskPhase(firstRun, "CONTRACT_PURCHASE");
    await waitForEvent(firstRun, "contract_purchase");
    await waitForTaskPhase(firstRun, "CONTRACT_TRAVEL_TO_DESTINATION");
    await request(firstRun).post("/autopilot/abort");

    const callsBeforeRestart = fleet.calls.length;

    const restarted = app();
    await request(restarted).post("/autopilot/arm").send({ token: "test-token" });

    const task = await request(restarted).get("/autopilot/ships/MINING-1").then((r) => r.body.task);
    expect(task.phase).toBe("CONTRACT_TRAVEL_TO_DESTINATION"); // resumed, not reset to CONTRACT_TRAVEL_TO_MARKET

    await new Promise((r) => setTimeout(r, 60));
    const rePurchased = fleet.calls.slice(callsBeforeRestart).some((c) => c.url === "/ships/MINING-1/purchase");
    expect(rePurchased).toBe(false); // never re-buys what an earlier run already procured
  }, 20_000);
});

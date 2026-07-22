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
    cargo: { units: 0, capacity: 1, inventory: [] as { symbol: string; units: number }[] },
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

describe("automation-service fleet replan (meta#13)", () => {
  let pool: Pool;
  let clock: FakeClock;
  let includeAsteroidField: boolean;

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
    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    includeAsteroidField = true;

    agent = startStubServer((req, _body, res) => {
      if (req.url === "/agent" && req.method === "GET") {
        respondJson(res, 200, { credits: 100_000 });
      } else if (req.url === "/ships/MINING-1" && req.method === "GET") {
        respondJson(res, 200, makeShip());
      } else if (req.url === "/contracts" && req.method === "GET") {
        respondJson(res, 200, []);
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
    });

    fleet = startStubServer((_req, _body, res) => {
      respondJson(res, 404, { error: "unused in this suite" });
    });

    nav = startStubServer((req, _body, res) => {
      if (req.url === "/systems/X1-TEST/waypoints") {
        respondJson(res, 200, {
          data: [
            { symbol: "X1-TEST-MARKET", type: "PLANET", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
            ...(includeAsteroidField
              ? [{ symbol: "X1-TEST-BELT", type: "ASTEROID_FIELD", x: 10, y: 0, traits: [] }]
              : []),
          ],
        });
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

  const app = (replanIntervalMs = 300_000, schedulerIntervalMs = 15) => {
    const gateway = createApp(pool, clock, {
      agentServiceUrl: agentUrl,
      fleetServiceUrl: fleetUrl,
      navigationServiceUrl: navUrl,
      miningShipSymbol: "MINING-1",
      schedulerIntervalMs,
      replanIntervalMs,
    });
    gateways.push(gateway);
    return gateway;
  };

  const waitForAssignment = async (gateway: ReturnType<typeof createApp>, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.asteroidWaypoint !== null) return res.body.task;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out waiting for a planner assignment");
  };

  const countReplans = async (gateway: ReturnType<typeof createApp>): Promise<number> => {
    const res = await request(gateway).get("/autopilot/events?limit=1000");
    return res.body.events.filter((e: { type: string }) => e.type === "replan_executed").length;
  };

  const waitForReplanCount = async (
    gateway: ReturnType<typeof createApp>,
    count: number,
    timeoutMs = 2000
  ): Promise<{ type: string; detail: Record<string, unknown> }[]> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(gateway).get("/autopilot/events?limit=1000");
      const replans = res.body.events.filter((e: { type: string }) => e.type === "replan_executed");
      if (replans.length >= count) return replans;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${count} replan_executed events`);
  };

  it("a manual replan request logs a replan_executed event", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });
    await waitForAssignment(gateway);

    const res = await request(gateway).post("/planner/replan");
    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(true);

    const replans = await waitForReplanCount(gateway, 1);
    expect(replans[0].detail.reason).toBe("manual");
  }, 10_000);

  it("a knob change triggers a replan", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });
    await waitForAssignment(gateway);

    await request(gateway).put("/planner/knobs/credit.reserveFloor").send({ value: 500 });

    const replans = await waitForReplanCount(gateway, 1);
    expect(replans[0].detail.reason).toBe("knob_change");
  }, 10_000);

  it("two replan requests inside the debounce window coalesce into one replan", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });
    await waitForAssignment(gateway);

    // First trigger: runs right away (nothing has ever replanned yet).
    await request(gateway).post("/planner/replan");
    await waitForReplanCount(gateway, 1);

    // Second trigger, well inside the default 30s debounce window: must NOT
    // produce a second replan_executed while the clock hasn't moved.
    await request(gateway).post("/planner/replan");
    await new Promise((r) => setTimeout(r, 200));
    expect(await countReplans(gateway)).toBe(1);

    // Advance the clock past the debounce window and trigger again — now it runs.
    clock.advance(31_000);
    await request(gateway).post("/planner/replan");
    await waitForReplanCount(gateway, 2);
  }, 10_000);

  it("the periodic interval triggers a replan with no external trigger", async () => {
    const gateway = app(2000); // 2s replan interval for this test
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });
    await waitForAssignment(gateway);

    expect(await countReplans(gateway)).toBe(0); // not due yet, right after arm

    clock.advance(2001);
    const replans = await waitForReplanCount(gateway, 1);
    expect(replans[0].detail.reason).toBe("interval");
  }, 10_000);

  it("a ship mid-task keeps its task through a replan; only idle ships are reassigned", async () => {
    const gateway = app();
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });
    const assigned = await waitForAssignment(gateway);
    expect(assigned.asteroidWaypoint).toBe("X1-TEST-BELT");

    await request(gateway).post("/planner/replan");
    const replans = await waitForReplanCount(gateway, 1);
    // The ship was already assigned (not idle) by the time the replan ran, so
    // the replan had no idle ships to reassign.
    expect(replans[0].detail.shipsConsidered).toBe(0);

    const after = await request(gateway).get("/autopilot/ships/MINING-1");
    expect(after.body.task.asteroidWaypoint).toBe("X1-TEST-BELT");
    expect(after.body.task.phase).toBe(assigned.phase);
  }, 10_000);

  it("a replan that finds no viable target doesn't double-dispatch the ship's assignment in the same tick", async () => {
    // No asteroid field and no contracts in this fixture -> assignment always
    // resolves to "none", so the ship stays idle forever. A slow scheduler
    // interval lets the test pin down exactly which tick a replan lands on.
    includeAsteroidField = false;
    const gateway = app(300_000, 1500);
    await request(gateway).post("/autopilot/arm").send({ token: "test-token" });

    // Wait for the first natural tick: it creates the ship_task row via
    // getOrCreate and calls assignTarget once through the normal per-ship path
    // (no replan has been requested yet).
    const deadline1 = Date.now() + 5000;
    while (Date.now() < deadline1 && agent.calls.filter((c) => c.url === "/contracts").length < 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(agent.calls.filter((c) => c.url === "/contracts").length).toBe(1);

    // Request a replan between tick 1 and tick 2. The next tick (tick 2) will
    // run the replan, which considers the still-idle ship. With the fix, that
    // replan's own assignTarget call is tick 2's one atomic action for this
    // ship — the normal per-ship dispatch must NOT also fire for it this tick.
    await request(gateway).post("/planner/replan");
    const replans = await waitForReplanCount(gateway, 1, 5000);
    expect(replans[0].detail.shipsConsidered).toBe(1);

    // Exactly one more contract-discovery round-trip should have happened
    // (tick 2's replan-driven assignTarget) — not two, which is what the bug
    // would produce (replan's call plus a second, duplicate normal-path call
    // in the same tick). Checked promptly, well before tick 3 (~4500ms) could
    // add a third call of its own.
    expect(agent.calls.filter((c) => c.url === "/contracts").length).toBe(2);
  }, 10_000);
});

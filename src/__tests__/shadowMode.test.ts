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

describe("automation-service shadow mode (meta#21)", () => {
  let pool: Pool;
  let clock: FakeClock;

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
    await pool.query("TRUNCATE event_log, ship_task RESTART IDENTITY");
    await pool.query("UPDATE knob SET value = default_value");
    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));

    agent = startStubServer((req, _body, res) => {
      if (req.url === "/agent" && req.method === "GET") {
        respondJson(res, 200, { credits: 100_000 });
        return;
      }
      if (req.url === "/ships/MINING-1" && req.method === "GET") {
        respondJson(res, 200, makeShip());
        return;
      }
      if (req.url === "/contracts" && req.method === "GET") {
        respondJson(res, 200, []); // no contracts in this suite — mining-only fixtures
        return;
      }
      respondJson(res, 404, { error: "not found" });
    });

    fleet = startStubServer((_req, _body, res) => respondJson(res, 200, { data: { agent: {} } }));

    nav = startStubServer((req, _body, res) => {
      if (req.url === "/systems/X1-TEST/waypoints") {
        respondJson(res, 200, {
          data: [
            { symbol: "X1-TEST-MARKET", type: "PLANET", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
            { symbol: "X1-TEST-BELT", type: "ASTEROID_FIELD", x: 10, y: 0, traits: [] },
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

  it("rejects an arm with an unrecognized mode", async () => {
    const gateway = app();
    const res = await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "t", mode: "sneaky" });
    expect(res.status).toBe(400);
  });

  it("arms in shadow mode, reports it on status, and logs planner decisions without any fleet-service call", async () => {
    const gateway = app();
    const armRes = await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token", mode: "shadow" });
    expect(armRes.body).toEqual({ status: "armed", mode: "shadow" });

    const statusRes = await request(gateway).get("/api/automation/v1/autopilot/status");
    expect(statusRes.body).toEqual({ status: "armed", mode: "shadow" });

    const armedEventRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=1");
    expect(armedEventRes.body.events[0]).toMatchObject({ type: "armed", detail: { mode: "shadow" } }); // persisted, not just echoed in the HTTP response

    const deadline = Date.now() + 2000;
    let shadowEvents = 0;
    while (Date.now() < deadline && shadowEvents < 2) {
      const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=100");
      shadowEvents = eventsRes.body.events.filter((e: { type: string }) => e.type === "planner_shadow_assignment").length;
      if (shadowEvents < 2) await new Promise((r) => setTimeout(r, 5));
    }
    expect(shadowEvents).toBeGreaterThanOrEqual(2); // the cycle replays every tick, not just once

    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=100");
    const shadowEvent = eventsRes.body.events.find((e: { type: string }) => e.type === "planner_shadow_assignment");
    expect(shadowEvent.detail.chosen).toBe("X1-TEST-BELT"); // full scoring inputs, same shape as live's planner_assignment

    // No ship_task row was ever created or mutated — shadow mode never assigns for real.
    const taskRes = await request(gateway).get("/api/automation/v1/autopilot/ships/MINING-1");
    expect(taskRes.status).toBe(404);

    // Never any ship-action call to fleet-service.
    expect(fleet.calls).toHaveLength(0);
  }, 10_000);

  it("dispatches for real once switched from shadow to live via an explicit re-arm", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token", mode: "shadow" });

    await new Promise((r) => setTimeout(r, 60)); // a few shadow cycles
    expect(fleet.calls).toHaveLength(0);

    const reArmRes = await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token", mode: "live" });
    expect(reArmRes.body).toEqual({ status: "armed", mode: "live" });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && fleet.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Live mode really does dispatch a ship-action call — specifically the
    // orbit dispatch toward the newly (live-)assigned target, not just any
    // request landing on the fleet stub.
    expect(fleet.calls[0]).toMatchObject({ method: "POST", url: "/ships/MINING-1/orbit" });
  }, 10_000);

  it("defaults to live mode when no mode is specified, preserving pre-meta#21 behavior", async () => {
    const gateway = app();
    const armRes = await request(gateway).post("/api/automation/v1/autopilot/arm").send({ token: "test-token" });
    expect(armRes.body.mode).toBe("live");
  });
});

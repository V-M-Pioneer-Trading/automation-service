import type { Pool } from "pg";
import request from "supertest";
import { createPool, migrate } from "../db";
import { describeFailure } from "../failureDetail";
import { ShipTaskRepo } from "../shipTaskRepo";
import { forceFleetTick } from "../testSupport/appHooks";
import { bearer } from "../testSupport/authTokens";
import { createTestApp } from "../testSupport/createTestApp";
import { databaseUrl } from "../testSupport/databaseUrl";
import { FakeClock } from "../testSupport/fakeClock";
import { resetDatabase } from "../testSupport/resetDatabase";
import { startStub, type Recorded, type Stub } from "../testSupport/stubServers";

/**
 * automation-service#45: `GET /autopilot/events` is public, and failure events
 * used to store `String(err)` — the internal host of the service we called,
 * and the upstream's whole response body, which can name more internal URLs.
 * They now carry the same trimmed `request` the #43 webhook does, and the full
 * text goes to the container log only.
 *
 * Driven end to end: real HTTP upstreams, the real game clients, the real
 * scheduler, read back through the public route with no credential.
 */

const SHIP = "MINING-1";
const NOW = new Date("2026-01-01T00:00:00Z");
// What an upstream might say about its own upstream, verbatim.
const INTERNAL_URL = "http://st-gateway.internal:8080/v2/my/ships/MINING-1";
const LEAKY_BODY = {
  error: { message: `st-gateway: GET ${INTERNAL_URL} failed; status page https://status.internal.example/incidents/7` },
};

const ship = () => ({
  symbol: SHIP,
  nav: { systemSymbol: "X1", waypointSymbol: "X1-MARKET", status: "DOCKED", route: { arrival: NOW.toISOString() } },
  cooldown: { expiration: null },
  fuel: { current: 100, capacity: 100 },
  cargo: { units: 0, capacity: 10, inventory: [] },
});

describe("public event detail never names a URL (#45)", () => {
  let pool: Pool;
  let upstream: Stub;
  let deadUrl: string;
  let shipAnswers = false;
  let gateway: ReturnType<typeof createTestApp> | null = null;
  let consoleError: jest.SpyInstance<void, unknown[]>;

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
    // A port nothing listens on: fetch fails before any response, and the
    // error names the host it could not reach.
    const closed = await startStub(() => ({ status: 200, body: {} }));
    deadUrl = closed.url;
    await closed.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    shipAnswers = false;
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    // Agent- and navigation-service: everything is a 500 carrying internal
    // URLs, except the ship read once a test lets it answer.
    upstream = await startStub((req: Recorded) =>
      shipAnswers && req.method === "GET" && req.url === `/ships/${SHIP}`
        ? { status: 200, body: ship() }
        : { status: 500, body: LEAKY_BODY }
    );
  });

  afterEach(async () => {
    if (gateway !== null) await request(gateway).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());
    gateway = null;
    await upstream.close();
    consoleError.mockRestore();
  });

  const arm = async () => {
    gateway = createTestApp(pool, new FakeClock(NOW), {
      agentServiceUrl: upstream.url,
      navigationServiceUrl: upstream.url,
      fleetServiceUrl: deadUrl,
      miningShipSymbol: SHIP,
      schedulerIntervalMs: 100_000, // never fires on its own
      replanIntervalMs: 300_000,
    });
    const armed = await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    expect(armed.status).toBe(200);
    return gateway;
  };

  /** Exactly what an anonymous reader gets. */
  const publicEvents = async (g: ReturnType<typeof createTestApp>) => {
    const res = await request(g).get("/api/automation/v1/autopilot/events?limit=200");
    expect(res.status).toBe(200);
    return (res.body as { events: { type: string; detail: Record<string, unknown> }[] }).events;
  };

  const expectNoUrls = (events: { detail: Record<string, unknown> }[]) => {
    for (const e of events) {
      const detail = JSON.stringify(e.detail);
      expect(detail).not.toContain("http://");
      expect(detail).not.toContain("https://");
      expect(detail).not.toContain("127.0.0.1");
      expect(detail).not.toContain("st-gateway.internal");
    }
  };

  /** The container log got the full text: every logged failure still names the URL the event dropped. */
  const loggedFailures = (): unknown[][] =>
    consoleError.mock.calls.filter((args) => args.some((a) => String(a).includes(INTERNAL_URL) || String(a).includes(deadUrl)));

  it("a pre-FSM failure (the loop's own error handler)", async () => {
    const g = await arm();
    await forceFleetTick(g); // idle ship → getShip → 500 with a leaky body

    const events = await publicEvents(g);
    const errors = events.filter((e) => e.type === "mining_tick_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].detail.request).toMatch(new RegExp(`^GET /ships/${SHIP}: 500 `));
    expect(errors[0].detail).not.toHaveProperty("message");
    expectNoUrls(events);
    expect(loggedFailures()).toHaveLength(1);
  });

  it("contract discovery failing", async () => {
    shipAnswers = true; // getShip answers; /contracts and the planner's reads 500
    const g = await arm();
    await forceFleetTick(g);

    const events = await publicEvents(g);
    const discovery = events.filter((e) => e.type === "contract_discovery_error");
    expect(discovery).toHaveLength(1);
    expect(discovery[0].detail.request).toMatch(/^GET \/contracts: 500 /);
    expect(discovery[0].detail.failureKind).toBe("unavailable");
    expectNoUrls(events);
    // Once per failure event: discovery, then the planner's failed read.
    expect(loggedFailures()).toHaveLength(events.filter((e) => e.type.endsWith("_error")).length);
  });

  it("a dispatch to an unreachable upstream (handleTickFailure)", async () => {
    shipAnswers = true;
    const tasks = new ShipTaskRepo(pool, new FakeClock(NOW));
    const base = await tasks.getOrCreate(SHIP);
    await tasks.save({ ...base, taskKind: "mining", phase: "TRAVEL_TO_ASTEROID", asteroidWaypoint: "X1-BELT" });

    const g = await arm();
    await forceFleetTick(g);

    const events = await publicEvents(g);
    const errors = events.filter((e) => e.type === "mining_tick_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].detail.failureKind).toBe("unavailable");
    expect(typeof errors[0].detail.unrelatedFailureCount).toBe("number"); // the FSM path, not the loop's
    expectNoUrls(events);
    expect(loggedFailures()).toHaveLength(1);
  });
});

describe("describeFailure", () => {
  it("drops every origin, in the request line and inside the body", () => {
    const err = new Error(`POST http://fleet.internal:3000/ships/X/orbit: 502 {"upstream":"${INTERNAL_URL}","see":"HTTPS://Docs.Internal/x"}`);
    const out = describeFailure(err);
    expect(out.startsWith("POST /ships/X/orbit: 502 ")).toBe(true);
    expect(out).toContain("/v2/my/ships/MINING-1"); // the path is kept; only the host goes
    expect(out.toLowerCase()).not.toContain("http");
  });

  it("drops origins from text that is not a request line at all", () => {
    expect(describeFailure(new Error(`connect to https://db.internal:5432/x refused`))).toBe("Error: connect to /x refused");
  });
});

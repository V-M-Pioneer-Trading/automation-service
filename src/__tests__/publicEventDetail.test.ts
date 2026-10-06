import type { Pool } from "pg";
import request from "supertest";
import { createPool, migrate } from "../db";
import { describeFailure } from "../failureDetail";
import { PUBLIC_REQUEST_PATTERN } from "../fleetEvents";
import { createGameClients } from "../gameClients";
import { ShipTaskRepo } from "../shipTaskRepo";
import { forceAnomalyTick, forceFleetTick, stopBackgroundSchedulers } from "../testSupport/appHooks";
import { bearer } from "../testSupport/authTokens";
import { createTestApp } from "../testSupport/createTestApp";
import { databaseUrl } from "../testSupport/databaseUrl";
import { FakeClock } from "../testSupport/fakeClock";
import { makeFlakyPool } from "../testSupport/flakyPool";
import { resetDatabase } from "../testSupport/resetDatabase";
import { startStub, type Recorded, type Stub } from "../testSupport/stubServers";

/**
 * automation-service#45: `GET /autopilot/events` is public, and failure events
 * used to store `String(err)` — the internal host of the service we called,
 * the upstream's whole response body, a database's connection string. They
 * now carry a `request` built only from values this service chose or that
 * parse as numbers or identifiers (see failureDetail.ts), and the full text
 * goes to the container log only.
 *
 * Driven end to end where it can be: real HTTP upstreams, the real game
 * clients, the real scheduler and anomaly loop, read back through the public
 * route with no credential.
 */

const SHIP = "MINING-1";
const MARKET = "X1-MARKET";
const NOW = new Date("2026-01-01T00:00:00Z");

/**
 * Every way an internal address has been seen to arrive, and each must be
 * absent from public detail. The first ones are what a reviewer found passing
 * straight through a scheme-only scrubber.
 */
const LEAKS = [
  "connect ECONNREFUSED 10.0.3.7:5432",
  "getaddrinfo ENOTFOUND automation-postgres",
  "127.0.0.1:8080",
  "localhost:80",
  "//st-gateway.internal/x",
  "ws://fleet-service:3000/socket",
  "postgres://user:pw@db.internal:5432/automation",
  "http%3A%2F%2Fagent-service%3A80%2Fapi",
  "http:\\/\\/navigation-service\\/waypoints",
  "st-gateway did not answer within 10000ms",
  "http://st-gateway.internal:8080/v2/my/ships/MINING-1",
  "https://status.internal.example/incidents/7",
  "[fd00::7]:443",
];
/** Substrings no public detail may contain, whatever form the leak took. */
const FORBIDDEN = [
  "http", "//", "10.0.3.7", "127.0.0.1", "localhost", ".internal", "postgres", "st-gateway",
  "agent-service", "fleet-service", "navigation-service", "fd00", "ENOTFOUND automation",
];
const LEAKY_TEXT = LEAKS.join(" | ");
/** SpaceTraders' envelope shape, carrying every leak in its message. */
const LEAKY_BODY = { error: { message: LEAKY_TEXT, code: 4000 } };

const expectClean = (detail: unknown) => {
  const text = JSON.stringify(detail);
  for (const f of FORBIDDEN) expect(text).not.toContain(f);
};

/** A lone UTF-16 surrogate: what node-pg sends and Postgres jsonb refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const ship = () => ({
  symbol: SHIP,
  nav: { systemSymbol: "X1", waypointSymbol: MARKET, status: "DOCKED", route: { arrival: NOW.toISOString() } },
  cooldown: { expiration: null },
  fuel: { current: 100, capacity: 100 },
  cargo: { units: 0, capacity: 10, inventory: [] },
});

/** A port nothing listens on: fetch fails before any response. */
async function deadUrl(): Promise<string> {
  const closed = await startStub(() => ({ status: 200, body: {} }));
  await closed.close();
  return closed.url;
}

describe("public event detail never names an internal address (#45)", () => {
  let pool: Pool;
  let upstream: Stub;
  let dead: string;
  let shipAnswers = false;
  let marketReply: { status: number; body: unknown } = { status: 500, body: LEAKY_BODY };
  let gateway: ReturnType<typeof createTestApp> | null = null;
  let consoleError: jest.SpyInstance<void, unknown[]>;

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
    dead = await deadUrl();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    shipAnswers = false;
    marketReply = { status: 500, body: LEAKY_BODY };
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    // Agent- and navigation-service: everything is a 500 carrying every leak,
    // except what a test lets answer.
    upstream = await startStub((req: Recorded) => {
      if (shipAnswers && req.method === "GET" && req.url === `/ships/${SHIP}`) return { status: 200, body: ship() };
      if (req.method === "GET" && req.url === `/waypoints/${MARKET}/market`) return marketReply;
      return { status: 500, body: LEAKY_BODY };
    });
  });

  afterEach(async () => {
    if (gateway !== null) {
      await stopBackgroundSchedulers(gateway);
      await request(gateway).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer());
    }
    gateway = null;
    await upstream.close();
    consoleError.mockRestore();
  });

  const build = (p: Pool = pool, anomalyLoop = false) => {
    gateway = createTestApp(
      p,
      new FakeClock(NOW),
      {
        agentServiceUrl: upstream.url,
        navigationServiceUrl: upstream.url,
        fleetServiceUrl: dead,
        miningShipSymbol: SHIP,
        schedulerIntervalMs: 100_000, // never fires on its own
        replanIntervalMs: 300_000,
      },
      undefined,
      anomalyLoop ? { intervalMs: 100_000 } : undefined
    );
    return gateway;
  };

  const arm = async (p: Pool = pool) => {
    const g = build(p);
    const armed = await request(g).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    expect(armed.status).toBe(200);
    return g;
  };

  const seedTask = async (fields: Record<string, unknown>) => {
    const tasks = new ShipTaskRepo(pool, new FakeClock(NOW));
    const base = await tasks.getOrCreate(SHIP);
    await tasks.save({ ...base, ...fields });
  };

  /** Exactly what an anonymous reader gets. */
  const publicEvents = async (g: ReturnType<typeof createTestApp>) => {
    const res = await request(g).get("/api/automation/v1/autopilot/events?limit=200");
    expect(res.status).toBe(200);
    const { events } = res.body as { events: { type: string; detail: Record<string, unknown> }[] };
    for (const e of events) expectClean(e.detail);
    return events;
  };

  const errorEvents = (events: { type: string }[]) => events.filter((e) => e.type.endsWith("_error"));

  /** The full text still reached the container log: one line per failure event, naming what the event dropped. */
  const loggedFailures = (needle: string): unknown[][] =>
    consoleError.mock.calls.filter((args) => args.some((a) => String(a).includes(needle)));

  it("a pre-FSM failure (the fleet loop's own error handler)", async () => {
    const g = await arm();
    await forceFleetTick(g); // idle ship → getShip → 500 carrying every leak

    const events = await publicEvents(g);
    const errors = events.filter((e) => e.type === "mining_tick_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].detail.request).toBe(`GET /ships/${SHIP}: 500 (code 4000)`);
    expect(errors[0].detail).not.toHaveProperty("message");
    expect(loggedFailures(LEAKS[0])).toHaveLength(1);
  });

  it("contract discovery failing", async () => {
    shipAnswers = true; // getShip answers; /contracts and the planner's reads 500
    const g = await arm();
    await forceFleetTick(g);

    const events = await publicEvents(g);
    const discovery = events.filter((e) => e.type === "contract_discovery_error");
    expect(discovery).toHaveLength(1);
    expect(discovery[0].detail.request).toBe("GET /contracts: 500 (code 4000)");
    expect(discovery[0].detail.failureKind).toBe("unavailable");
    // Once per failure event: discovery, then the planner's failed read.
    expect(errorEvents(events).length).toBeGreaterThanOrEqual(2);
    expect(loggedFailures(LEAKS[0])).toHaveLength(errorEvents(events).length);
  });

  it("a dispatch to an unreachable upstream (handleTickFailure)", async () => {
    shipAnswers = true;
    await seedTask({ taskKind: "scout", phase: "SCOUT_TRAVEL", asteroidWaypoint: "X1-ELSEWHERE" });
    marketReply = { status: 500, body: LEAKY_BODY };

    const g = await arm();
    await forceFleetTick(g); // the scout orbits first: fleet-service is a dead port

    const events = await publicEvents(g);
    const errors = events.filter((e) => e.type === "mining_tick_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].detail.failureKind).toBe("unavailable");
    expect(errors[0].detail.request).toBe(`POST /ships/${SHIP}/orbit: no response (ECONNREFUSED)`);
    expect(typeof errors[0].detail.unrelatedFailureCount).toBe("number"); // the FSM path, not the loop's
    expect(loggedFailures(dead)).toHaveLength(1);
  });

  it("an upstream body cut mid-emoji is still stored, and the failure still counted", async () => {
    // The old 200-character prefix split this emoji in half; Postgres refused
    // the lone surrogate, the event insert threw before the failure count was
    // saved, and the same tick repeated forever with no budget spent.
    shipAnswers = true;
    await seedTask({ taskKind: "scout", phase: "SCOUT_REFRESH", asteroidWaypoint: MARKET });
    marketReply = { status: 400, body: `${"x".repeat(195)}\u{1F680} refused` };

    const g = await arm();
    await forceFleetTick(g);

    const errors = (await publicEvents(g)).filter((e) => e.type === "mining_tick_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].detail.failureKind).toBe("rejected");
    expect(errors[0].detail.request).toBe(`GET /waypoints/${MARKET}/market: 400`);
    expect((await new ShipTaskRepo(pool, new FakeClock(NOW)).get(SHIP))?.failureCount).toBe(1);
  });

  it("an observation write failing (observation_write_error)", async () => {
    shipAnswers = true;
    marketReply = { status: 200, body: { symbol: MARKET, tradeGoods: [] } };
    await seedTask({ taskKind: "scout", phase: "SCOUT_REFRESH", asteroidWaypoint: MARKET });
    const flaky = makeFlakyPool(
      pool,
      (sql) => sql.includes("INSERT INTO market_intel"),
      () => Object.assign(new Error(`write failed: ${LEAKY_TEXT}`), { code: "ECONNREFUSED" })
    );

    const g = await arm(flaky);
    await forceFleetTick(g); // the scout refreshes the market; recording it fails

    const events = await publicEvents(g);
    const errors = events.filter((e) => e.type === "observation_write_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].detail.request).toBe("ECONNREFUSED");
    expect(events.map((e) => e.type)).toContain("scout_market_refresh"); // best-effort: the tick still succeeded
    expect(loggedFailures(LEAKS[0])).toHaveLength(1);
  });

  it("the anomaly loop's own error handler", async () => {
    const flaky = makeFlakyPool(
      pool,
      (sql) => sql === "SELECT name, value FROM knob",
      () => new Error(`knob read failed: ${LEAKY_TEXT}`)
    );
    const g = build(flaky, true);
    await forceAnomalyTick(g);

    const errors = (await publicEvents(g)).filter((e) => e.type === "mining_tick_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].detail).toEqual({ request: "Error", failureKind: "internal", source: "anomaly" });
    expect(loggedFailures(LEAKS[0])).toHaveLength(1);
  });
});

describe("describeFailure", () => {
  let upstream: Stub | null = null;
  afterEach(async () => {
    await upstream?.close();
    upstream = null;
  });

  /** The real client's error for one upstream answer. */
  const upstreamFailure = async (status: number, body: unknown): Promise<unknown> => {
    upstream = await startStub(() => ({ status, body }));
    const clients = createGameClients({
      navigationServiceUrl: upstream.url,
      agentServiceUrl: upstream.url,
      fleetServiceUrl: upstream.url,
      authTokenSource: { getToken: () => Promise.resolve("machine-token") },
    });
    const err = await clients.getShip(SHIP).then(
      () => null,
      (e: unknown) => e
    );
    await upstream.close();
    upstream = null;
    return err;
  };

  it.each(LEAKS)("an upstream body naming %s says only method, path and status", async (leak) => {
    for (const body of [leak, { error: { message: leak } }, { error: { message: leak, code: 4214 } }]) {
      const err = await upstreamFailure(504, body);
      if (body === leak) expect(String(err)).toContain(leak); // the full text is still there, for the log
      const out = describeFailure(err);
      expect(out).toMatch(new RegExp(`^GET /ships/${SHIP}: 504( \\(code 4214\\))?$`));
      expect(out).toMatch(new RegExp(PUBLIC_REQUEST_PATTERN)); // so the read-side guard keeps it
      expectClean(out);
    }
  });

  it.each(LEAKS)("any other error naming %s says only its code or class", (leak) => {
    expect(describeFailure(new Error(leak))).toBe("Error");
    expect(describeFailure(new TypeError(`failed: ${leak}`))).toBe("TypeError");
    expect(describeFailure(Object.assign(new Error(leak), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
    expect(describeFailure(Object.assign(new Error(leak), { code: leak }))).toBe("Error"); // a code that is prose is not a code
    expect(describeFailure(leak)).toBe("Error");
  });

  it("an unreachable upstream says which Node error, never where", async () => {
    const err = await (async () => {
      const clients = createGameClients({
        navigationServiceUrl: await deadUrl(),
        agentServiceUrl: await deadUrl(),
        fleetServiceUrl: await deadUrl(),
        authTokenSource: { getToken: () => Promise.resolve("machine-token") },
      });
      return clients.getShip(SHIP).then(
        () => null,
        (e: unknown) => e
      );
    })();
    expect(describeFailure(err)).toBe(`GET /ships/${SHIP}: no response (ECONNREFUSED)`);
    expect(describeFailure(err)).toMatch(new RegExp(PUBLIC_REQUEST_PATTERN));
  });

  it("never splits a surrogate pair, whatever sits at the old 200-character cut", () => {
    for (let pad = 190; pad < 205; pad++) {
      const text = `${"x".repeat(pad)}\u{1F680}\u{1F680}`;
      for (const err of [new Error(text), Object.assign(new Error(text), { code: text })]) {
        expect(describeFailure(err)).not.toMatch(LONE_SURROGATE);
      }
    }
  });

  it("a SpaceTraders code survives; its message does not", async () => {
    const err = await upstreamFailure(403, { error: { message: "Agent does not own or cannot access ship MINING-1.", code: 4225 } });
    expect(describeFailure(err)).toBe(`GET /ships/${SHIP}: 403 (code 4225)`);
  });
});

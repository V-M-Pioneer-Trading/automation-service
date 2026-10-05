import type { Pool } from "pg";
import { AutopilotState } from "../autopilotState";
import { ContractRepo } from "../contractRepo";
import { createPool, migrate } from "../db";
import { EventLog } from "../eventLog";
import type { GameClients, ShipSnapshot } from "../gameClients";
import { createGameClients, UpstreamCallError } from "../gameClients";
import { KnobRepo } from "../knobs";
import { MarketIntelRepo } from "../marketIntelRepo";
import { ObservationRepo } from "../observations";
import { Planner } from "../planner";
import { FleetScheduler, REPEATED_DENIED_THRESHOLD } from "../scheduler";
import { ShipTaskRepo } from "../shipTaskRepo";
import { FakeClock } from "../testSupport/fakeClock";
import { fakeGameClients } from "../testSupport/fakeGameClients";
import { resetDatabase } from "../testSupport/resetDatabase";
import { databaseUrl } from "../testSupport/databaseUrl";
import { startStub, type Stub } from "../testSupport/stubServers";

/**
 * automation-service#40: a leftover ship_task row for a ship the service no
 * longer owns (RADOMSKY-TEST-1 after a universe reset) was picked up by every
 * replan, the game answered 403, the replan failed before assigning anything,
 * and the error was stamped with the configured ship. Nothing ever said so.
 */

const SHIP = "MINING-1";
const STALE = "OLD-SHIP-1";
const NOW = new Date("2026-01-01T00:00:00Z");
const DENIED = (symbol: string) =>
  `GET http://agent/ships/${symbol}: 403 Agent does not own or cannot access ship ${symbol}.`;

describe("stale ship_task rows and repeated denied (#40)", () => {
  let pool: Pool;
  let clock: FakeClock;
  let scheduler: FleetScheduler | null = null;
  let stub: Stub | null = null;

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FakeClock(NOW);
  });
  afterEach(async () => {
    await scheduler?.stop(); // releases the dispatch lock's pooled connection
    scheduler = null;
    await stub?.close();
    stub = null;
  });

  const ship = (symbol: string): ShipSnapshot => ({
    symbol,
    nav: { systemSymbol: "X1", waypointSymbol: "X1-MARKET", status: "DOCKED", route: { arrival: NOW.toISOString() } },
    cooldown: { expiration: null },
    fuel: { current: 100, capacity: 100 },
    cargo: { units: 0, capacity: 10, inventory: [] },
  });

  const build = (clients: GameClients, replanIntervalMs: number) => {
    const tasks = new ShipTaskRepo(pool, clock);
    const events = new EventLog(pool, clock);
    const knobs = new KnobRepo(pool);
    const state = new AutopilotState();
    state.arm();
    const s = new FleetScheduler({
      state,
      tasks,
      events,
      clients,
      clock,
      planner: new Planner(clients, knobs, new ObservationRepo(pool, clock), new ContractRepo(pool, clock), new MarketIntelRepo(pool, clock)),
      knobs,
      contracts: new ContractRepo(pool, clock),
      marketIntel: new MarketIntelRepo(pool, clock),
      observations: new ObservationRepo(pool, clock),
      pool,
      shipSymbol: SHIP,
      intervalMs: 100_000,
      replanIntervalMs,
    });
    scheduler = s;
    s.start();
    return { tasks, events, s };
  };

  /** The configured ship is mid-wait, so a tick on it is clean and makes no upstream call but getShip. */
  const seedWaiting = async (tasks: ShipTaskRepo): Promise<void> => {
    const base = await tasks.getOrCreate(SHIP);
    await tasks.save({
      ...base,
      taskKind: "mining",
      phase: "EXTRACT",
      asteroidWaypoint: "X1-BELT",
      waitingUntil: new Date(NOW.getTime() + 3_600_000),
    });
  };

  const errorDetails = async (events: EventLog) =>
    (await events.list(200)).filter((e) => e.type === "mining_tick_error").map((e) => e.detail);
  const anomalyCount = async (): Promise<number> =>
    Number((await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM anomaly WHERE type = 'repeated_denied'")).rows[0].n);

  it("a stale idle row for another ship does not block the replan, and is left in place", async () => {
    const asked: string[] = [];
    const clients = fakeGameClients({
      getShip: (symbol: string) => {
        asked.push(symbol);
        return symbol === SHIP ? Promise.resolve(ship(symbol)) : Promise.reject(new UpstreamCallError(DENIED(symbol), "denied"));
      },
    });
    const { tasks, events, s } = build(clients, 0); // every tick is due a replan
    await seedWaiting(tasks);
    await tasks.getOrCreate(STALE); // idle: the row the old code picked up

    await s.forceTick();

    expect(asked).not.toContain(STALE);
    expect(await errorDetails(events)).toEqual([]);
    const executed = (await events.list(50)).filter((e) => e.type === "replan_executed");
    expect(executed).toHaveLength(1);
    expect(executed[0].detail.shipsConsidered).toBe(0);
    expect(await tasks.get(STALE)).not.toBeNull(); // ignored, never deleted
  });

  it("listIdle only returns the ships asked for", async () => {
    const tasks = new ShipTaskRepo(pool, clock);
    await tasks.getOrCreate(SHIP);
    await tasks.getOrCreate(STALE);

    expect((await tasks.listIdle([SHIP])).map((t) => t.shipSymbol)).toEqual([SHIP]);
    expect(await tasks.listOtherShipSymbols([SHIP])).toEqual([STALE]);
  });

  it("mining_tick_error names the ship that was actually requested", async () => {
    const err = new UpstreamCallError(DENIED(STALE), "denied");
    err.requestedShip = STALE;
    const clients = fakeGameClients({ getShip: () => Promise.reject(err) });
    const { events, s } = build(clients, 100_000);

    await s.forceTick();

    expect((await errorDetails(events))[0].shipSymbol).toBe(STALE);
  });

  it("a failure that names no ship falls back to the configured one", async () => {
    const clients = fakeGameClients({ getShip: () => Promise.reject(new Error("boom")) });
    const { events, s } = build(clients, 100_000);

    await s.forceTick();

    expect((await errorDetails(events))[0].shipSymbol).toBe(SHIP);
  });

  it("the real getShip tags its failure with the symbol it was asked for", async () => {
    stub = await startStub(() => ({ status: 403, body: "Agent does not own or cannot access ship X." }));
    const clients = createGameClients({
      navigationServiceUrl: stub.url,
      agentServiceUrl: stub.url,
      fleetServiceUrl: stub.url,
      authTokenSource: { getToken: () => Promise.resolve("machine-token") },
    });

    const err = await clients.getShip(STALE).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(UpstreamCallError);
    expect((err as UpstreamCallError).requestedShip).toBe(STALE);
  });

  describe("repeated identical denied", () => {
    it("raises exactly one anomaly, however long it keeps failing", async () => {
      const clients = fakeGameClients({ getShip: () => Promise.reject(new UpstreamCallError(DENIED(SHIP), "denied")) });
      const { s } = build(clients, 100_000);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s.forceTick();
      expect(await anomalyCount()).toBe(0); // not yet: a couple in a row is a blip

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD * 3; i++) await s.forceTick();
      expect(await anomalyCount()).toBe(1);

      const { rows } = await pool.query<{ detail: Record<string, unknown>; delivered_at: Date | null }>(
        "SELECT detail, delivered_at FROM anomaly WHERE type = 'repeated_denied'"
      );
      expect(rows[0].detail.shipSymbol).toBe(SHIP);
      expect(rows[0].detail.consecutiveFailures).toBe(REPEATED_DENIED_THRESHOLD);
      expect(rows[0].delivered_at).toBeNull(); // the anomaly scheduler delivers it
    });

    it("does not count a run broken up by another failure", async () => {
      let n = 0;
      const clients = fakeGameClients({
        getShip: () => {
          const i = n++;
          // every fifth call is a different failure, so no run reaches the threshold
          return Promise.reject(
            i % REPEATED_DENIED_THRESHOLD === REPEATED_DENIED_THRESHOLD - 1
              ? new UpstreamCallError("fleet-service down", "unavailable")
              : new UpstreamCallError(DENIED(SHIP), "denied")
          );
        },
      });
      const { s } = build(clients, 100_000);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD * 4; i++) await s.forceTick();

      expect(await anomalyCount()).toBe(0);
    });

    it("does not count denials that are not identical", async () => {
      let n = 0;
      const clients = fakeGameClients({
        getShip: () => {
          const symbol = n++ % 2 === 0 ? SHIP : STALE; // alternating subjects: never N of the same one
          const err = new UpstreamCallError(DENIED(symbol), "denied");
          err.requestedShip = symbol;
          return Promise.reject(err);
        },
      });
      const { s } = build(clients, 100_000);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD * 4; i++) await s.forceTick();

      expect(await anomalyCount()).toBe(0);
    });

    it("recovery re-arms it: a clean tick resets the count, and the next run raises a second anomaly", async () => {
      let healthy = false;
      const clients = fakeGameClients({
        getShip: (symbol: string) =>
          healthy ? Promise.resolve(ship(symbol)) : Promise.reject(new UpstreamCallError(DENIED(symbol), "denied")),
      });
      const { tasks, s } = build(clients, 100_000);
      await seedWaiting(tasks);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD; i++) await s.forceTick();
      expect(await anomalyCount()).toBe(1);

      healthy = true;
      await s.forceTick(); // clean: still waiting, no failure
      healthy = false;

      // one short of the threshold again: the earlier run must not carry over
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s.forceTick();
      expect(await anomalyCount()).toBe(1);

      await s.forceTick();
      expect(await anomalyCount()).toBe(2);
    });
  });
});

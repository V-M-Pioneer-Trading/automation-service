import type { Pool } from "pg";
import type { Anomaly } from "../anomaly";
import { AnomalyChecker, AnomalyRepo } from "../anomaly";
import { AnomalyScheduler } from "../anomalyScheduler";
import { MetricsRepo } from "../metrics";
import type { WebhookDelivery } from "../webhookDelivery";
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
import { describeDenied, FleetScheduler, REPEATED_DENIED_THRESHOLD } from "../scheduler";
import { idleTask, ShipTaskRepo } from "../shipTaskRepo";
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
  let state: AutopilotState;
  let anomalySchedulers: AnomalyScheduler[] = [];
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
    state = new AutopilotState();
    anomalySchedulers = [];
  });
  afterEach(async () => {
    await scheduler?.stop(); // releases the dispatch lock's pooled connection
    scheduler = null;
    await Promise.all(anomalySchedulers.map((a) => a.stop()));
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
    const deniedFor = (symbol: string) => new UpstreamCallError(DENIED(symbol), "denied");
    const trippedCount = async (events: EventLog): Promise<number> =>
      (await events.list(500)).filter((e) => e.type === "repeated_denied_tripped").length;

    /** The real anomaly scheduler and checker over the same database, so dedupe, delivery and stop guards are the production ones. */
    const startAnomalyScheduler = (events: EventLog) => {
      const deliver = jest.fn<Promise<boolean>, [Anomaly]>(() => Promise.resolve(true));
      const a = new AnomalyScheduler({
        state,
        repo: new AnomalyRepo(pool, clock),
        checker: new AnomalyChecker(clock, state, new MarketIntelRepo(pool, clock), events, new MetricsRepo(pool, clock)),
        webhook: { deliver } as unknown as WebhookDelivery,
        events,
        clock,
        knobs: new KnobRepo(pool),
        tasks: new ShipTaskRepo(pool, clock),
        gameClients: null,
        shipSymbol: SHIP,
        intervalMs: 3_600_000,
      });
      anomalySchedulers.push(a);
      return { a, deliver };
    };

    it("raises exactly one anomaly, delivered on its first attempt, however long it keeps failing", async () => {
      const clients = fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) });
      const { s, events } = build(clients, 100_000);
      const { a, deliver } = startAnomalyScheduler(events);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s.forceTick();
      await a.forceTick();
      expect(await anomalyCount()).toBe(0); // not yet: a couple in a row is a blip

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD * 3; i++) {
        await s.forceTick();
        await a.forceTick();
      }
      expect(await anomalyCount()).toBe(1);
      expect(deliver.mock.calls.filter(([an]) => an.type === "repeated_denied")).toHaveLength(1);

      const { rows } = await pool.query<{ detail: Record<string, unknown>; delivered_at: Date | null }>(
        "SELECT detail, delivered_at FROM anomaly WHERE type = 'repeated_denied'"
      );
      expect(rows[0].detail.shipSymbol).toBe(SHIP);
      expect(rows[0].detail.consecutiveFailures).toBe(REPEATED_DENIED_THRESHOLD);
      expect(rows[0].delivered_at).not.toBeNull();
    });

    it("only the request path, status and a short prefix of the text leave the process", async () => {
      expect(describeDenied(new UpstreamCallError("GET http://agent.internal:80/api/agent/v1/ships/X: 403 nope", "denied"))).toBe(
        "GET /api/agent/v1/ships/X: 403 nope"
      );
      const long = describeDenied(new UpstreamCallError(`GET http://h/p: 403 ${"x".repeat(5000)}`, "denied"));
      expect(long).not.toContain("http://h");
      expect(long.length).toBeLessThan(230);
      expect(describeDenied(new Error("y".repeat(1000))).length).toBe(200);

      const { s, events } = build(fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) }), 100_000);
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD; i++) await s.forceTick();
      const tripped = (await events.list(500)).find((e) => e.type === "repeated_denied_tripped");
      expect(tripped?.detail.request).toBe(`GET /ships/${SHIP}: 403 Agent does not own or cannot access ship ${SHIP}.`);
      expect(JSON.stringify(tripped?.detail)).not.toContain("http://");
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
              : deniedFor(SHIP)
          );
        },
      });
      const { s, events } = build(clients, 100_000);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD * 4; i++) await s.forceTick();

      expect(await trippedCount(events)).toBe(0);
    });

    it("does not count denials that are not identical", async () => {
      let n = 0;
      const clients = fakeGameClients({
        getShip: () => {
          const symbol = n++ % 2 === 0 ? SHIP : STALE; // alternating subjects: never N of the same one
          const err = deniedFor(symbol);
          err.requestedShip = symbol;
          return Promise.reject(err);
        },
      });
      const { s, events } = build(clients, 100_000);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD * 4; i++) await s.forceTick();

      expect(await trippedCount(events)).toBe(0);
    });

    it("the production pattern: one denied replan every 60th tick, clean ticks between, still pages after 5 replans", async () => {
      const TICKS_PER_REPLAN = 60;
      const TICK_MS = 1000;
      let denyNext = false;
      const clients = fakeGameClients({
        getShip: (symbol: string) => (denyNext ? Promise.reject(deniedFor(symbol)) : Promise.resolve(ship(symbol))),
      });
      const { tasks, s, events } = build(clients, TICKS_PER_REPLAN * TICK_MS);
      const { a } = startAnomalyScheduler(events);

      for (let i = 1; i <= TICKS_PER_REPLAN * REPEATED_DENIED_THRESHOLD; i++) {
        clock.advance(TICK_MS);
        const replanDue = i % TICKS_PER_REPLAN === 0;
        // Idle only on the replan tick, so only the replan asks the game about the ship.
        if (replanDue) await tasks.save(idleTask(await tasks.getOrCreate(SHIP)));
        else await seedWaiting(tasks);
        denyNext = replanDue;
        await s.forceTick();
        if (i < TICKS_PER_REPLAN * REPEATED_DENIED_THRESHOLD) expect(await trippedCount(events)).toBe(0);
      }

      expect(await trippedCount(events)).toBe(1);
      await a.forceTick();
      expect(await anomalyCount()).toBe(1);
      expect(await errorDetails(events)).toHaveLength(REPEATED_DENIED_THRESHOLD); // one per replan; the clean ticks logged nothing
    });

    it("a replan that completes ends the replan run: 4 denied replans, 1 good, 1 denied does not page", async () => {
      const TICKS_PER_REPLAN = 5;
      const TICK_MS = 1000;
      let denyNext = false;
      const clients = fakeGameClients({
        getShip: (symbol: string) => (denyNext ? Promise.reject(deniedFor(symbol)) : Promise.resolve(ship(symbol))),
        getContracts: () => Promise.resolve([]),
      });
      const { tasks, s, events } = build(clients, TICKS_PER_REPLAN * TICK_MS);

      // Outcome of each successive replan: denied x4, then an empty fleet (no ship idle: it completes), then denied.
      const outcomes = ["denied", "denied", "denied", "denied", "ok", "denied"];
      for (const outcome of outcomes) {
        for (let i = 1; i <= TICKS_PER_REPLAN; i++) {
          clock.advance(TICK_MS);
          const replanTick = i === TICKS_PER_REPLAN;
          if (replanTick && outcome === "denied") await tasks.save(idleTask(await tasks.getOrCreate(SHIP)));
          else await seedWaiting(tasks);
          denyNext = replanTick && outcome === "denied";
          await s.forceTick();
        }
      }

      expect(await errorDetails(events)).toHaveLength(5);
      expect(await trippedCount(events)).toBe(0);
    });

    it("one tripped run pages once: the same event does not page again after the cooldown", async () => {
      const clients = fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) });
      const { s, events } = build(clients, 100_000);
      const { a } = startAnomalyScheduler(events);
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD; i++) await s.forceTick();
      await a.forceTick();
      expect(await anomalyCount()).toBe(1);

      clock.advance(60 * 60_000); // an hour: far past anomaly.dedupeCooldownMinutes, no new run
      await a.forceTick();

      expect(await anomalyCount()).toBe(1);
    });

    it("writes one tripped event per run, however long the failure continues, and again every threshold repeats", async () => {
      const { s, events } = build(fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) }), 100_000);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD * 2 - 1; i++) await s.forceTick();
      expect(await trippedCount(events)).toBe(1);

      await s.forceTick(); // the tenth: a continuing failure trips again for the next cooldown
      expect(await trippedCount(events)).toBe(2);
    });

    it("abort then re-arm ends the run, through the real stop() and start()", async () => {
      const { s, events } = build(fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) }), 100_000);
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s.forceTick();

      await s.stop(); // what the abort route does
      s.start(); // what re-arming does; the fleet reads armed throughout
      await s.forceTick();

      expect(await trippedCount(events)).toBe(0);
    });

    it("re-arming a fleet that is already running (start() with no stop()) also ends the run", async () => {
      const { s, events } = build(fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) }), 100_000);
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s.forceTick();

      s.start();
      await s.forceTick();

      expect(await trippedCount(events)).toBe(0);
    });

    it("a re-arm after a trip starts counting afresh, so a failure that was not fixed pages again", async () => {
      const { s, events } = build(fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) }), 100_000);
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD; i++) await s.forceTick();
      expect(await trippedCount(events)).toBe(1);

      await s.stop();
      s.start();
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD; i++) await s.forceTick();

      expect(await trippedCount(events)).toBe(2);
    });

    it("the checker's event window closes at the cooldown: seen just inside it, gone just past it", async () => {
      const events = new EventLog(pool, clock);
      await events.append("repeated_denied_tripped", { shipSymbol: SHIP });
      const checker = new AnomalyChecker(clock, state, new MarketIntelRepo(pool, clock), events, new MetricsRepo(pool, clock));
      const knobs = await new KnobRepo(pool).getValues();
      const cooldownMs = knobs["anomaly.dedupeCooldownMinutes"] * 60_000;
      const types = async () => (await checker.runChecks(SHIP, null, knobs)).filter((c) => c.type === "repeated_denied");

      clock.advance(cooldownMs - 60_000);
      expect(await types()).toHaveLength(1);

      clock.advance(120_000); // cooldown + 1 minute
      expect(await types()).toHaveLength(0);
    });

    it("a flapping ship (5 denied, 1 clean, repeatedly) pages at most once per cooldown", async () => {
      let healthy = false;
      const clients = fakeGameClients({
        getShip: (symbol: string) => (healthy ? Promise.resolve(ship(symbol)) : Promise.reject(deniedFor(symbol))),
      });
      const { tasks, s, events } = build(clients, 100_000);
      await seedWaiting(tasks);
      const { a, deliver } = startAnomalyScheduler(events);

      const cycle = async () => {
        healthy = false;
        for (let i = 0; i < REPEATED_DENIED_THRESHOLD; i++) await s.forceTick();
        healthy = true;
        await s.forceTick();
        clock.advance(10_000);
        await a.forceTick();
      };
      for (let i = 0; i < 6; i++) await cycle();

      expect(await trippedCount(events)).toBe(6); // every run tripped...
      expect(await anomalyCount()).toBe(1); // ...but one page for the cooldown
      expect(deliver.mock.calls.filter(([an]) => an.type === "repeated_denied")).toHaveLength(1);

      clock.advance(16 * 60_000); // past anomaly.dedupeCooldownMinutes (15)
      await cycle();
      expect(await anomalyCount()).toBe(2);
    });

    it("records nothing once the loop is stopping, or the fleet aborted", async () => {
      let release!: () => void;
      let hold = false;
      const gate = new Promise<void>((r) => (release = r));
      const clients = fakeGameClients({
        getShip: async () => {
          if (hold) await gate;
          throw deniedFor(SHIP);
        },
      });
      const { s, events } = build(clients, 100_000);
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s.forceTick();

      hold = true;
      const inFlight = s.forceTick(); // the fifth, parked at getShip
      const stopping = s.stop();
      release();
      await Promise.all([inFlight, stopping]);
      expect(await trippedCount(events)).toBe(0);

      // Same for an abort landing before the fifth completes.
      hold = false;
      const { s: s2, events: events2 } = build(clients, 100_000);
      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s2.forceTick();
      state.abort();
      await s2.forceTick();
      expect(await trippedCount(events2)).toBe(0);
    });

    it("pause, abort and re-arm end the run: 4 denied, pause, clean, re-arm, 1 denied does not page", async () => {
      let healthy = false;
      const clients = fakeGameClients({
        getShip: (symbol: string) => (healthy ? Promise.resolve(ship(symbol)) : Promise.reject(deniedFor(symbol))),
      });
      const { tasks, s, events } = build(clients, 100_000);
      await seedWaiting(tasks);

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD - 1; i++) await s.forceTick();
      state.pause();
      healthy = true;
      await s.forceTick(); // clean, paused
      state.arm();
      healthy = false;
      await s.forceTick(); // the first denial of a new run

      expect(await trippedCount(events)).toBe(0);
    });

    it("shadow mode counts: a denied in shadow is still a real problem", async () => {
      const clients = fakeGameClients({ getShip: () => Promise.reject(deniedFor(SHIP)) });
      const { s, events } = build(clients, 100_000);
      state.arm("shadow");

      for (let i = 0; i < REPEATED_DENIED_THRESHOLD; i++) await s.forceTick();

      expect(await trippedCount(events)).toBe(1);
    });
  });
});

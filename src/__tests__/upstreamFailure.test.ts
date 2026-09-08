import { Pool } from "pg";
import { AutopilotState } from "../autopilotState";
import { ContractRepo } from "../contractRepo";
import { createPool, migrate } from "../db";
import { EventLog } from "../eventLog";
import { classifyUpstreamStatus, ShipSnapshot, UpstreamCallError, UpstreamFailureKind } from "../gameClients";
import { KnobRepo } from "../knobs";
import { MarketIntelRepo } from "../marketIntelRepo";
import { ObservationRepo } from "../observations";
import { Planner } from "../planner";
import { FleetScheduler } from "../scheduler";
import { ShipTask, ShipTaskRepo } from "../shipTaskRepo";
import { FakeClock } from "../testSupport/fakeClock";
import { fakeGameClients } from "../testSupport/fakeGameClients";
import { resetDatabase } from "../testSupport/resetDatabase";

/**
 * Upstream failures are classified once, at the call, and the scheduler
 * branches on the verdict.
 *
 * The behaviour under test is the one auth-design decision 19 warns about: an
 * upstream failure that has nothing to do with where the ship was sent used to
 * spend the target's retry budget anyway, so a fleet-service outage or a
 * rejected M2M token abandoned every task in the fleet and re-planned them onto
 * targets that were never the problem.
 *
 * Driven by constructing `FleetScheduler` directly rather than through the HTTP
 * loop: what matters here is which failure reaches `handleTickFailure`, and
 * three stub servers in between only make that harder to say precisely.
 */

const SHIP = "MINING-1";
const NOW = new Date("2026-01-01T00:00:00Z");

describe("classifyUpstreamStatus", () => {
  const cases: [number, string, UpstreamFailureKind][] = [
    [401, "", "credentials"], // our M2M token was rejected outright
    [403, "", "credentials"], // ...or lacks the scope the route wants
    [503, '{"error":{"message":"SpaceTraders credential not configured"}}', "credentials"],
    [503, '{"error":{"message":"auth-service unavailable: cannot obtain a SpaceTraders credential"}}', "unavailable"],
    [502, "", "unavailable"],
    [504, "", "unavailable"],
    [429, "", "unavailable"], // the gateway's token bucket, not a refusal
    [400, '{"error":{"message":"Ship is not currently docked."}}', "rejected"],
    [409, "", "rejected"], // cooldown
    [422, "", "rejected"],
    [400, '{"error":{"message":"bad request","fields":{"units":["required"]}}}', "malformed"],
    [404, "", "malformed"], // we named a ship or waypoint that does not exist
    [405, "", "malformed"],
    [400, "not json at all", "rejected"], // no envelope to read; fall back to the status
  ];

  it.each(cases)("%i %s -> %s", (status, body, expected) => {
    expect(classifyUpstreamStatus(status, body)).toBe(expected);
  });

  it("keeps the two 503s apart on the only signal the gateway gives", () => {
    // st-gateway answers 503 both for "no agent token yet" and for
    // "auth-service is down", and says which only in the message. One needs an
    // operator; the other fixes itself. Collapsing them was how a missing
    // credential looked like a transient outage for as long as it lasted.
    expect(classifyUpstreamStatus(503, "SpaceTraders credential not configured")).toBe("credentials");
    expect(classifyUpstreamStatus(503, "auth-service unavailable")).toBe("unavailable");
  });
});

describe("the scheduler branches on the verdict, not the status code", () => {
  let pool: Pool;
  let clock: FakeClock;
  let scheduler: FleetScheduler | null = null;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FakeClock(NOW);
    scheduler = null;
  });

  afterEach(async () => {
    // Releases the dispatch lock's pooled connection; without it `pool.end()`
    // in afterAll waits forever.
    await scheduler?.stop();
  });

  const ship = (): ShipSnapshot => ({
    symbol: SHIP,
    nav: { systemSymbol: "X1", waypointSymbol: "X1-MARKET", status: "DOCKED", route: { arrival: NOW.toISOString() } },
    cooldown: { expiration: null },
    fuel: { current: 100, capacity: 100 },
    cargo: { units: 0, capacity: 10, inventory: [] },
  });

  /**
   * A ship already working a mining target, so a tick goes straight to the FSM
   * and the very first upstream call it makes is the one that fails.
   */
  const seedTask = async (tasks: ShipTaskRepo, overrides: Partial<ShipTask> = {}): Promise<void> => {
    const base = await tasks.getOrCreate(SHIP);
    await tasks.save({ ...base, taskKind: "mining", phase: "TRAVEL_TO_ASTEROID", asteroidWaypoint: "X1-BELT", ...overrides });
  };

  /** Every tick's first dispatch (`orbit`, on the way to the belt) fails with `err`. */
  const arrange = (err: unknown) => {
    const clients = fakeGameClients({
      getShip: async () => ship(),
      orbit: async () => {
        throw err;
      },
    });
    const tasks = new ShipTaskRepo(pool, clock);
    const events = new EventLog(pool, clock);
    const knobs = new KnobRepo(pool);
    const contracts = new ContractRepo(pool, clock);
    const marketIntel = new MarketIntelRepo(pool, clock);
    const observations = new ObservationRepo(pool, clock);
    const state = new AutopilotState();
    state.arm();
    const s = new FleetScheduler({
      state,
      tasks,
      events,
      clients,
      clock,
      planner: new Planner(clients, knobs, observations, contracts, marketIntel),
      knobs,
      contracts,
      marketIntel,
      observations,
      pool,
      shipSymbol: SHIP,
      // Long enough never to fire on its own; every tick here is forced.
      intervalMs: 100_000,
      replanIntervalMs: 100_000,
    });
    scheduler = s;
    s.start();
    return { tasks, events, knobs, scheduler: s };
  };

  const tick = async (s: FleetScheduler, times: number): Promise<void> => {
    for (let t = 0; t < times; t++) await s.forceTick();
  };

  const eventTypes = async (events: EventLog): Promise<string[]> => (await events.list(200)).map((e) => e.type);
  const detailsOf = async (events: EventLog, type: string): Promise<Record<string, unknown>[]> =>
    (await events.list(200)).filter((e) => e.type === type).map((e) => e.detail as Record<string, unknown>);

  it("an unreachable upstream never spends the target's retry budget", async () => {
    // fleet-service is down. Nothing about X1-BELT is wrong, and no
    // reassignment reaches a service that is not answering.
    const { tasks, events, scheduler: s } = arrange(
      new UpstreamCallError("fleet-service: connect ECONNREFUSED", 502, "unavailable")
    );
    await seedTask(tasks);

    await tick(s, 10); // well past mine.failureRetryLimit (3)

    const task = await tasks.get(SHIP);
    expect(task?.asteroidWaypoint).toBe("X1-BELT"); // still working the same target
    expect(task?.failureCount).toBe(0);
    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    // Still audible: the error-rate alarm reads these, so an outage is loud
    // without also being destructive.
    const errors = await detailsOf(events, "mining_tick_error");
    expect(errors.length).toBeGreaterThanOrEqual(10);
    expect(errors[0].failureKind).toBe("unavailable");
  });

  it("a rejected credential never spends it either, and says so", async () => {
    const { tasks, events, scheduler: s } = arrange(
      new UpstreamCallError("fleet-service: 401 unauthorized", 401, "credentials")
    );
    await seedTask(tasks);

    await tick(s, 10);

    const task = await tasks.get(SHIP);
    expect(task?.asteroidWaypoint).toBe("X1-BELT");
    expect(task?.failureCount).toBe(0);
    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    expect((await detailsOf(events, "mining_tick_error"))[0].failureKind).toBe("credentials");
  });

  it("the game refusing the action still counts against the target, and abandons it at the limit", async () => {
    // The pre-existing policy, unchanged: this is the failure the retry limit
    // was designed for, and the one verdict that is evidence about the target.
    const { tasks, events, scheduler: s } = arrange(
      new UpstreamCallError('POST /ships/MINING-1/orbit: 400 {"error":{"message":"Ship is in transit."}}', 400, "rejected")
    );
    await seedTask(tasks);

    await tick(s, 2); // retry limit is 3
    expect((await tasks.get(SHIP))?.failureCount).toBe(2);
    expect(await eventTypes(events)).not.toContain("mining_task_failed");

    await tick(s, 1);
    expect(await eventTypes(events)).toContain("mining_task_failed");
    const task = await tasks.get(SHIP);
    expect(task?.asteroidWaypoint).toBeNull(); // reassigned on the next tick
    expect((await detailsOf(events, "mining_task_failed"))[0].failureKind).toBe("rejected");
  });

  it("a malformed request reassigns on the first failure instead of retrying a deterministic bug", async () => {
    const { tasks, events, scheduler: s } = arrange(
      new UpstreamCallError("POST /ships/MINING-1/orbit: 404 not found", 404, "malformed")
    );
    await seedTask(tasks);

    await tick(s, 1);

    expect(await eventTypes(events)).toContain("mining_task_failed");
    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBeNull();
  });

  it("cargo in the hold still outranks every verdict", async () => {
    // Abandoning a target mid-cycle strands whatever is already aboard, with
    // no code path back to selling it - true whoever's fault the failure was.
    const { tasks, events, scheduler: s } = arrange(
      new UpstreamCallError("POST /ships/MINING-1/orbit: 404 not found", 404, "malformed")
    );
    await seedTask(tasks, { tradeSymbol: "IRON_ORE" });

    await tick(s, 6);

    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBe("X1-BELT");
  });

  it("a failure off the upstream seam keeps the old retry-then-reassign path", async () => {
    // A corrupt row or a vanished contract throws a plain Error. FSMs are
    // DB-free, so there is no transient third case to protect, and the
    // foreign-phase throw was written expecting exactly this.
    const { tasks, events, scheduler: s } = arrange(new Error("advanceMiningTask called on a SCOUT_ phase"));
    await seedTask(tasks);

    await tick(s, 2);
    expect((await tasks.get(SHIP))?.failureCount).toBe(2);

    await tick(s, 1);
    expect(await eventTypes(events)).toContain("mining_task_failed");
  });
});

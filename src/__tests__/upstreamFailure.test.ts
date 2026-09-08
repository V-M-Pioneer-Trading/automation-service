import { Pool } from "pg";
import { AutopilotState } from "../autopilotState";
import { ContractRepo } from "../contractRepo";
import { createPool, migrate } from "../db";
import { EventLog } from "../eventLog";
import { classifyUpstreamStatus, GameClients, ShipSnapshot, UpstreamCallError, UpstreamFailureKind } from "../gameClients";
import { KnobRepo } from "../knobs";
import { MarketIntelRepo } from "../marketIntelRepo";
import { ObservationRepo } from "../observations";
import { Planner } from "../planner";
import { FleetScheduler, UNRELATED_FAILURE_RETRY_MULTIPLIER } from "../scheduler";
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
    [408, "", "unavailable"], // a proxy talking about the connection, not the game
    [425, "", "unavailable"],
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

  /**
   * Every tick's first dispatch (`orbit`, on the way to the belt) fails. `err`
   * is either the one failure to throw every time, or a function of the tick
   * number for the cases about a run of failures changing character.
   */
  const arrange = (err: unknown | ((tick: number) => unknown), override?: GameClients) => {
    let n = 0;
    const clients =
      override ??
      fakeGameClients({
        getShip: async () => ship(),
        orbit: async () => {
          throw typeof err === "function" ? (err as (tick: number) => unknown)(n++) : err;
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

  it("an unreachable upstream does not spend the target's retry budget", async () => {
    // fleet-service is down. Nothing about X1-BELT is wrong, and no
    // reassignment reaches a service that is not answering.
    const { tasks, events, scheduler: s } = arrange(new UpstreamCallError("fleet-service: connect ECONNREFUSED", "unavailable"));
    await seedTask(tasks);

    await tick(s, 10); // well past mine.failureRetryLimit (3)

    const task = await tasks.get(SHIP);
    expect(task?.asteroidWaypoint).toBe("X1-BELT"); // still working the same target
    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    // It still counts - that is what lets the consecutive-failures alarm name
    // this ship - but on its own counter, against a budget a hundred times
    // longer. The target's own budget is untouched.
    expect(task?.unrelatedFailureCount).toBe(10);
    expect(task?.failureCount).toBe(0);
    const errors = await detailsOf(events, "mining_tick_error");
    expect(errors.length).toBeGreaterThanOrEqual(10);
    expect(errors[0].failureKind).toBe("unavailable");
  });

  it("...but does eventually spend a much longer one, so nothing is pinned forever", async () => {
    // navigation-service serves a deterministic 500 for a corrupt cached
    // market until an operator clears it. With no exit at all, a scout
    // assigned there would retry that one waypoint for the rest of the run
    // with no cargo at stake and nothing to show for it.
    const { tasks, events, knobs, scheduler: s } = arrange(new UpstreamCallError("nav: 500 corrupt cached data", "unavailable"));
    await knobs.set("mine.failureRetryLimit", 1);
    await seedTask(tasks);

    const budget = UNRELATED_FAILURE_RETRY_MULTIPLIER; // x a retry limit of 1
    await tick(s, budget - 1);
    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBe("X1-BELT"); // still hanging on

    await tick(s, 1);
    expect(await eventTypes(events)).toContain("mining_task_failed");
    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBeNull();
  }, 30_000);

  it("a rejected credential is treated the same way, and says so", async () => {
    const { tasks, events, scheduler: s } = arrange(new UpstreamCallError("fleet-service: 401 unauthorized", "credentials"));
    await seedTask(tasks);

    await tick(s, 10);

    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBe("X1-BELT");
    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    expect((await detailsOf(events, "mining_tick_error"))[0].failureKind).toBe("credentials");
  });

  it("the game refusing the action spends the target's budget, and abandons it at the limit", async () => {
    // The pre-existing policy, unchanged: this is the failure the retry limit
    // was designed for, and the clearest evidence about the target.
    const { tasks, events, scheduler: s } = arrange(
      new UpstreamCallError("POST /ships/MINING-1/orbit: 400 Ship is in transit.", "rejected")
    );
    await seedTask(tasks);

    await tick(s, 2); // retry limit is 3
    expect((await tasks.get(SHIP))?.failureCount).toBe(2);
    expect(await eventTypes(events)).not.toContain("mining_task_failed");

    await tick(s, 1);
    expect(await eventTypes(events)).toContain("mining_task_failed");
    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBeNull(); // reassigned on the next tick
    expect((await detailsOf(events, "mining_task_failed"))[0].failureKind).toBe("rejected");
  });

  it("a malformed request spends the same budget as a refusal, not a shorter one", async () => {
    // Tempting to reassign immediately, since an identical request fails
    // identically forever. But fleet-service and agent-service answer 404 for
    // any unrouted path, so a rolling deploy produces one, and it is
    // indistinguishable from a permanently wrong request at every layer.
    // Zero retries would abandon the whole fleet on a single bad tick - the
    // failure this taxonomy exists to prevent, reached a different way.
    const { tasks, events, scheduler: s } = arrange(new UpstreamCallError("POST /ships/MINING-1/orbit: 404 not found", "malformed"));
    await seedTask(tasks);

    await tick(s, 1);
    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBe("X1-BELT");

    await tick(s, 2);
    expect(await eventTypes(events)).toContain("mining_task_failed");
    expect((await detailsOf(events, "mining_task_failed"))[0].failureKind).toBe("malformed");
  });

  it("an outage does not eat into the budget the next real refusal needs", async () => {
    // The whole reason there are two counters. One number spent against two
    // budgets abandons the target on the *first* refusal after an outage, which
    // is exactly the shape of a recovery: the ship comes back to a game state
    // that has moved on, and fleet-service's first answer is "ship is in
    // transit". After a long enough outage every ship in the fleet would
    // abandon its target on the same tick - the storm this all exists to stop.
    const outage = new UpstreamCallError("fleet-service: connect ECONNREFUSED", "unavailable");
    const refusal = new UpstreamCallError("POST /ships/MINING-1/orbit: 400 Ship is in transit.", "rejected");
    const { tasks, events, scheduler: s } = arrange((t: number) => (t < 5 ? outage : refusal));
    await seedTask(tasks);

    await tick(s, 5 + 2); // five ticks of outage, then two refusals, limit 3
    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    expect((await tasks.get(SHIP))?.failureCount).toBe(2); // the outage cost the target nothing

    await tick(s, 1);
    expect(await eventTypes(events)).toContain("mining_task_failed");
  });

  it("a failed tick does not look like progress to the ship-idle check", async () => {
    // `ship_idle` measures from `updated_at`, so stamping it on every failed
    // tick hid the longest stuck state the service can enter behind the one
    // check whose job is to notice it.
    const { tasks, scheduler: s } = arrange(new UpstreamCallError("fleet-service: connect ECONNREFUSED", "unavailable"));
    await seedTask(tasks);
    const before = (await tasks.get(SHIP))!.updatedAt;

    clock.advance(20 * 60_000);
    await tick(s, 3);

    const after = await tasks.get(SHIP);
    expect(after?.updatedAt).toEqual(before); // twenty minutes of failing is not an update
    expect(after?.unrelatedFailureCount).toBe(3); // ...but the counters still moved
  });

  it("cargo in the hold still outranks every verdict", async () => {
    // Abandoning a target mid-cycle strands whatever is already aboard, with
    // no code path back to selling it - true whoever's fault the failure was.
    const { tasks, events, scheduler: s } = arrange(new UpstreamCallError("POST /ships/MINING-1/orbit: 404 not found", "malformed"));
    await seedTask(tasks, { tradeSymbol: "IRON_ORE" });

    await tick(s, 6);

    expect(await eventTypes(events)).not.toContain("mining_task_failed");
    expect((await tasks.get(SHIP))?.asteroidWaypoint).toBe("X1-BELT");
  });

  it("our own code throwing is `internal`, and stays on the target's budget", async () => {
    // A foreign phase, or a contract row that vanished. FSMs are DB-free, so
    // there is no transient third case to protect, and the foreign-phase throw
    // was written expecting exactly this treatment.
    const { tasks, events, scheduler: s } = arrange(new Error("advanceMiningTask called on a SCOUT_ phase"));
    await seedTask(tasks);

    await tick(s, 2);
    expect((await tasks.get(SHIP))?.failureCount).toBe(2);

    await tick(s, 1);
    expect(await eventTypes(events)).toContain("mining_task_failed");
    expect((await detailsOf(events, "mining_task_failed"))[0].failureKind).toBe("internal");
  });

  it("a failure before the FSM runs carries a verdict too", async () => {
    // `getShip` and the planner fail through the loop's error handler, not
    // through handleTickFailure, and during an outage those are most of the
    // failures there are. A digest filtering on failureKind saw none of them.
    const clients = fakeGameClients({
      getShip: async () => {
        throw new UpstreamCallError("agent-service: connect ETIMEDOUT", "unavailable");
      },
    });
    const { tasks, events, scheduler: s } = arrange(new Error("unused"), clients);
    await seedTask(tasks);

    await tick(s, 1);

    const errors = await detailsOf(events, "mining_tick_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].failureKind).toBe("unavailable");
    expect((await tasks.get(SHIP))?.failureCount).toBe(0); // no target was acted on
  });
});

import { Pool } from "pg";
import { AutopilotState } from "./autopilotState";
import { Clock } from "./clock";
import { discoverAndEvaluateContracts } from "./contractDiscovery";
import { ContractRepo } from "./contractRepo";
import { DispatchLock } from "./dispatchLock";
import { advanceContractTask, contractCargoAtStake, startContractTask } from "./contractTask";
import { EventLog } from "./eventLog";
import { GameClients, ShipSnapshot, UpstreamCallError, UpstreamFailureKind } from "./gameClients";
import { IntervalLoop } from "./intervalLoop";
import { KnobRepo } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { advanceMiningTask, miningCargoAtStake, startMiningTask } from "./miningTask";
import { ObservationRepo } from "./observations";
import { Planner } from "./planner";
import { advanceScoutTask, scoutCargoAtStake, startScoutTask } from "./scoutTask";
import { idleTask, isIdle, ShipTask, ShipTaskRepo } from "./shipTaskRepo";
import { TickObservations, TickResult } from "./taskFsm";
import { withTransaction } from "./transaction";

/**
 * What the scheduler decides a failure was. `UpstreamFailureKind` plus the one
 * case that never touched an upstream: our own code threw. FSMs are DB-free,
 * so an `internal` failure is a foreign phase, a contract row that vanished,
 * or a bug — deterministic, and about this task.
 */
export type FailureVerdict = UpstreamFailureKind | "internal";

export const verdictOf = (err: unknown): FailureVerdict =>
  err instanceof UpstreamCallError ? err.kind : "internal";

/**
 * `rejected`, `malformed` and `internal` are evidence about the target, and
 * spend `mine.failureRetryLimit` directly. `unavailable` and `credentials` are
 * evidence about the fleet's plumbing and get this multiple of it instead,
 * counted separately on `ship_task.unrelated_failure_count`.
 *
 * Not infinity, and that is the point of the number rather than a boolean. A
 * permanently broken upstream answer is real — navigation-service serves a
 * deterministic 500 for a market whose cached row it cannot parse, and this
 * service never asks for a forced refresh, so a scout pinned to that waypoint
 * with no failure budget would retry it forever with nothing at stake and
 * nothing to show for it.
 *
 * It is a tick count, not a duration, and the two are not the same here: a
 * timer fire during an in-flight tick is dropped, and the failure this budget
 * is for is often a *hung* upstream costing the full 15s call timeout. At the
 * default 5s tick and a retry limit of 3 that is 300 ticks — at least 25
 * minutes, nearer 75 against a hung service, and proportionally more if the
 * knob is raised (its maximum, 20, gives hours). Every one of those comfortably
 * outlasts a deploy, a restart or a credential refresh, which is all the number
 * has to do.
 */
export const UNRELATED_FAILURE_RETRY_MULTIPLIER = 100;

export interface FleetSchedulerDeps {
  state: AutopilotState;
  tasks: ShipTaskRepo;
  events: EventLog;
  clients: GameClients;
  clock: Clock;
  planner: Planner;
  knobs: KnobRepo;
  contracts: ContractRepo;
  marketIntel: MarketIntelRepo;
  observations: ObservationRepo;
  pool: Pool;
  shipSymbol: string;
  intervalMs: number;
  replanIntervalMs: number;
}

/**
 * Drives the configured ship's task — mining, contract or scout, whichever the
 * planner assigned — on a fixed interval.
 *
 * Runs while armed (full progression) or paused (only finishes an
 * already-dispatched wait, never starts a new action — that's what makes pause
 * take effect between steps instead of aborting mid-cycle). Stops entirely on
 * abort, and picks up again on re-arm.
 *
 * Every tick performs at most one atomic action for the ship: get a planner
 * assignment, dispatch one command, or resolve one elapsed wait. A ship with
 * no target gets one as its own tick's action, so a task whose cycle just
 * completed is re-targeted on its very next tick with no separate sweep.
 */
export class FleetScheduler {
  private readonly loop: IntervalLoop;
  // Fleet-wide replan (meta#13) state: lastReplanAt gates every trigger source
  // (knob change, anomaly, manual, periodic) behind one shared debounce clock,
  // so triggers inside the window coalesce into one run whatever fired them.
  private lastReplanAt: Date | null = null;
  // Anchors the periodic fallback so a fresh arm doesn't read as "infinitely
  // overdue" and fire a replan on its very first live tick.
  private startedAt: Date | null = null;
  private replanRequested = false;
  private replanReason: string | null = null;
  // Cross-process guard on ship dispatch; the loop's own guard only covers
  // this process overlapping itself. See dispatchLock.ts.
  private readonly dispatchLock: DispatchLock;
  // So standing by logs once per spell, not once per tick.
  private standbyLogged = false;

  constructor(private readonly deps: FleetSchedulerDeps) {
    this.dispatchLock = new DispatchLock(deps.pool, `dispatch:${deps.shipSymbol}`);
    // Pre-FSM failures (getShip, the planner, a replan) land here rather than
    // in handleTickFailure, and during an outage they are most of them. They
    // carry the same verdict so nothing filtering on `failureKind` sees a
    // partial picture — they just never touch a target's retry budget,
    // because no target has been acted on yet.
    this.loop = new IntervalLoop(deps.intervalMs, () => this.tick(), (err) =>
      deps.events.append("mining_tick_error", { shipSymbol: deps.shipSymbol, message: String(err), failureKind: verdictOf(err) })
    );
  }

  start(): void {
    this.startedAt = this.deps.clock.now();
    this.loop.start();
  }

  /** Resolves only once any in-flight tick has finished, so an abort's response means nothing is still running. */
  async stop(): Promise<void> {
    // Drain first, then hand the lock over: releasing while a tick is still
    // dispatching would let another instance start driving the same ship
    // alongside it, which is the thing the lock exists to prevent.
    await this.loop.stop();
    await this.dispatchLock.release();
    this.standbyLogged = false;
  }

  /**
   * Run exactly one tick, to completion. The anomaly loop has had this since
   * its own flake was fixed properly; the fleet loop did not, which is why
   * every test of mining, contracts, scouting, replan and shadow mode was
   * still racing a real timer against a FakeClock and polling a wall clock to
   * find out what happened.
   */
  forceTick(): Promise<void> {
    return this.loop.runOnce();
  }

  /**
   * Requests a fleet replan (meta#13): a knob change, a newly-recorded anomaly,
   * or the manual /planner/replan endpoint. Acted on once
   * replan.debounceSeconds has elapsed since the last replan of any kind.
   */
  requestReplan(reason: string): void {
    this.replanRequested = true;
    this.replanReason = reason;
  }

  /**
   * True unless the operator has since aborted, or switched to shadow mode —
   * the two ways an already-in-flight live dispatch's result must be discarded
   * instead of persisted. Deliberately NOT status === "armed": pausing mid-flight
   * still lets that one in-flight result land (that's the whole point of pause
   * letting the current wait finish), so "paused" must stay a pass here too.
   */
  private isStillLive(): boolean {
    const { state } = this.deps;
    return state.getStatus() !== "aborted" && state.getMode() === "live";
  }

  private isArmedLive(): boolean {
    const { state } = this.deps;
    return state.getStatus() === "armed" && state.getMode() === "live";
  }

  async tick(): Promise<void> {
    const { state, tasks, clients, events, shipSymbol } = this.deps;
    const status = state.getStatus();
    if (status !== "armed" && status !== "paused") return;

    // Only one process may drive a ship. Another replica holding the lock
    // means this one stands by rather than double-dispatching alongside it.
    if (!(await this.dispatchLock.acquire())) {
      if (!this.standbyLogged) {
        this.standbyLogged = true;
        await events.append("dispatch_standby", { shipSymbol, reason: "another instance holds the dispatch lock" });
      }
      return;
    }
    this.standbyLogged = false;

    // Shadow mode (meta#21): run the planner's scoring cycle and log every
    // decision, but never touch ship_task or dispatch a ship action. Nothing is
    // ever "assigned", so the same cycle replays every tick — a continuous
    // preview of what live mode would do. Paused shadow does nothing, same as
    // paused live starts nothing new.
    if (state.getMode() === "shadow") {
      if (status === "armed") await this.runShadowCycle();
      return;
    }

    // A replan that considered this ship already spent its one action for
    // this tick (even a "no viable target" outcome); running the normal
    // dispatch as well would double-fire contract discovery's upstream calls.
    // A replan that didn't touch this ship must not block it, hence the set.
    if (status === "armed") {
      const replanned = await this.maybeReplan();
      if (replanned?.has(shipSymbol)) return;
    }

    const task = await tasks.getOrCreate(shipSymbol);
    if (isIdle(task)) {
      if (status === "paused") return; // never start a new assignment while paused
      const idleShip = await clients.getShip(shipSymbol);
      await this.discoverContracts(idleShip);
      await this.assignTarget(task, idleShip);
      return;
    }
    if (status === "paused" && task.waitingUntil === null) return; // idle between steps

    const ship = await clients.getShip(shipSymbol);
    let result: TickResult | null;
    try {
      result = await this.advance(task, ship);
    } catch (err) {
      await this.handleTickFailure(task, err);
      return;
    }
    if (result === null) return; // still waiting

    // The dispatch already happened — it can't be un-sent — but an abort, or a
    // re-arm into shadow mode, during those awaits must still stop it from
    // taking further effect: no persisted phase transition, no event claiming
    // the (now shadow, or now stopped) autopilot did this.
    if (!this.isStillLive()) {
      await events.append("mining_discarded_after_abort", { shipSymbol, event: result.event });
      return;
    }

    if (result.event === "contract_fulfilled" && task.contractId !== null) {
      await this.deps.contracts.setStatus(task.contractId, "fulfilled");
    }
    // Any successful action clears both consecutive-failure counts.
    await tasks.save({ ...result.task, failureCount: 0, unrelatedFailureCount: 0 });
    // Observations and the event land after the task write, so anything
    // reading them can trust the state they describe is already visible.
    await this.recordObservations(result.observations);
    await events.append(result.event, result.detail);
  }

  /**
   * Whether abandoning this target would strand cargo, asked of the task kind
   * rather than worked out here.
   *
   * The three kinds mean different things by the same columns — `tradeSymbol`
   * is the extracted good for mining and the deliverable for a contract, set at
   * different moments — so this used to be a conditional in the scheduler
   * enumerating contract phase names, which is the scheduler reading FSM
   * internals to make a decision the FSMs own. Same shape as `advance` below:
   * one switch, three modules, and adding a kind fails to compile until it
   * answers (meta#75 B7).
   */
  private cargoAtStake(task: ShipTask): boolean {
    switch (task.taskKind) {
      case "mining":
        return miningCargoAtStake(task);
      case "contract":
        return contractCargoAtStake(task);
      case "scout":
        return scoutCargoAtStake(task);
    }
  }

  /** One FSM step for whatever kind of task the ship is running. */
  private async advance(task: ShipTask, ship: ShipSnapshot): Promise<TickResult | null> {
    const { clients, clock, contracts } = this.deps;
    const ctx = { task, ship, clients, clock};
    switch (task.taskKind) {
      case "mining":
        return advanceMiningTask(ctx);
      case "scout":
        return advanceScoutTask(ctx);
      case "contract": {
        const contract = task.contractId === null ? null : await contracts.get(task.contractId);
        if (contract === null) throw new Error(`contract ${task.contractId} not found for ship ${task.shipSymbol}`);
        return advanceContractTask({ ...ctx, contract });
      }
    }
  }

  /**
   * Persists whatever this tick taught the fleet. Deliberately best-effort: a
   * failure here costs one data point for future calibration, and must never
   * turn a successful ship action into a failed tick.
   */
  private async recordObservations(observations: TickObservations | undefined): Promise<void> {
    if (observations === undefined) return;
    const { observations: repo, marketIntel, events, shipSymbol } = this.deps;
    try {
      if (observations.travel !== undefined) await repo.recordTravel(observations.travel);
      if (observations.refuel !== undefined) await repo.recordTravel(observations.refuel);
      if (observations.miningCycle !== undefined) await repo.recordMiningCycle({ shipSymbol, ...observations.miningCycle });
      if (observations.marketsRefreshed !== undefined) await marketIntel.record(observations.marketsRefreshed);
    } catch (err) {
      await events.append("observation_write_error", { message: String(err) });
    }
  }

  /**
   * Gates every replan trigger behind one shared debounce/interval clock. A
   * requested replan runs once replan.debounceSeconds has elapsed since the
   * last replan of any kind; the periodic fallback runs on replanIntervalMs
   * regardless, so a replan still happens even if nobody asks for one.
   */
  private async maybeReplan(): Promise<Set<string> | null> {
    const { clock, knobs, replanIntervalMs } = this.deps;
    const now = clock.now();
    const debounceMs = (await knobs.get("replan.debounceSeconds")) * 1000;

    // Infinity until the very first replan ever runs, so an early request
    // isn't held back waiting on a run that hasn't happened yet.
    const sinceLastReplan = this.lastReplanAt === null ? Infinity : now.getTime() - this.lastReplanAt.getTime();
    const requestReady = this.replanRequested && sinceLastReplan >= debounceMs;

    // Due replanIntervalMs after the last replan of any kind, or after arm if
    // none has run yet — never immediately at arm time.
    const baseline = this.lastReplanAt ?? this.startedAt;
    const sinceBaseline = baseline === null ? Infinity : now.getTime() - baseline.getTime();
    const intervalReady = sinceBaseline >= replanIntervalMs;

    if (!requestReady && !intervalReady) return null;

    const reason = requestReady ? (this.replanReason ?? "requested") : "interval";
    this.replanRequested = false;
    this.replanReason = null;
    this.lastReplanAt = now;

    // Re-scores every ship with no assigned target. A ship mid-task never
    // matches that predicate, so running work is never preempted.
    const idle = await this.deps.tasks.listIdle();
    if (idle.length > 0) {
      // One discovery pass for the whole replan, not one per ship.
      const ship = await this.deps.clients.getShip(idle[0].shipSymbol);
      await this.discoverContracts(ship);
    }
    for (const task of idle) await this.assignTarget(task);
    await this.deps.events.append("replan_executed", { reason, shipsConsidered: idle.length });
    return new Set(idle.map((t) => t.shipSymbol));
  }

  private async runShadowCycle(): Promise<void> {
    const { clients, planner, clock, state, events, shipSymbol } = this.deps;
    const ship = await clients.getShip(shipSymbol);
    const assignment = await planner.assignTarget({ ship, now: clock.now() });
    // A switch back to live, a pause, or an abort mid-flight all mean this
    // decision is stale — fine to have computed (it's read-only), just not
    // worth logging as "what shadow just decided".
    if (state.getStatus() !== "armed" || state.getMode() !== "shadow") return;
    await events.append("planner_shadow_assignment", assignment.detail);
  }

  /**
   * Catches up on any contract SpaceTraders has on offer that this agent
   * hasn't seen yet — otherwise a fresh, higher-scoring contract could still
   * be unevaluated when a tick locks a ship into a mining target instead
   * (meta#11).
   *
   * Runs **once per tick**, before any assignment, rather than once per ship.
   * What is on offer is a property of the agent, not of whichever ship happens
   * to be idle, so N idle ships used to pay for N identical discovery passes
   * back to back inside a single tick — with the tick guard holding all other
   * dispatch until the last one finished.
   *
   * A failure here must not block mining: contracts are additive, never a
   * dependency.
   */
  private async discoverContracts(ship: ShipSnapshot): Promise<void> {
    const { clients, planner, events, contracts } = this.deps;
    try {
      await discoverAndEvaluateContracts({ contracts, events, clients, planner, ship});
    } catch (err) {
      await events.append("contract_discovery_error", { message: String(err), failureKind: verdictOf(err) });
    }
  }

  /** `ship` is passed in wherever the caller already read it, so one assignment costs one ship read. */
  private async assignTarget(task: ShipTask, preloadedShip?: ShipSnapshot): Promise<void> {
    const { clients, planner, clock, state, events, tasks, contracts, pool } = this.deps;
    const ship = preloadedShip ?? (await clients.getShip(task.shipSymbol));

    const assignment = await planner.assignTarget({ ship, now: clock.now() });

    // "Don't start anything new while paused" applies here too: a pause,
    // abort, or switch to shadow landing during these awaits must stop the
    // in-flight decision from being persisted as a new live assignment.
    if (!this.isArmedLive()) {
      await events.append("planner_discarded_after_abort_or_pause", {
        shipSymbol: task.shipSymbol,
        status: state.getStatus(),
        mode: state.getMode(),
      });
      return;
    }

    await events.append("planner_assignment", assignment.detail);
    switch (assignment.kind) {
      case "none":
        await events.append("planner_no_viable_target", { shipSymbol: task.shipSymbol });
        return;
      case "mine":
        await tasks.save(startMiningTask(task, assignment.asteroidWaypoint));
        return;
      case "scout":
        await tasks.save(startScoutTask(task, assignment.scoutWaypoint));
        return;
      case "contract": {
        const { contract } = assignment;
        // Both writes must land together (meta#30) — a crash between them would
        // otherwise leave the contract "assigned" with no ship_task pointing at
        // it, and assigned contracts are never re-offered to the planner.
        await withTransaction(pool, async (client) => {
          await new ContractRepo(client, clock).setStatus(contract.contractId, "assigned");
          await new ShipTaskRepo(client, clock).save(startContractTask(task, contract));
        });
        return;
      }
      default: {
        // Unlike `advance` and `cargoAtStake`, this switch returns void, so
        // TypeScript is content to let a missing arm fall straight through: a
        // new task kind would be planned, match nothing, save nothing, and
        // leave the ship idle to be replanned every tick with no event and no
        // error. This makes the omission a compile error instead.
        const unreachable: never = assignment;
        throw new Error(`planner returned an unknown assignment kind: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /**
   * A real failure while working a target (not a planner/infra error — those
   * are caught by the loop's error handler).
   *
   * How much patience the target gets depends on *why* it failed.
   * `mine.failureRetryLimit` answers exactly one question — "is this target
   * not working out?" — and an unreachable service or a rejected credential is
   * no answer to it. Counting those against the target abandons good targets
   * across the whole fleet for a reason no reassignment can fix, which is the
   * failure auth-design decision 19 describes. They still count, a hundred
   * times more slowly, so nothing can be pinned forever on an upstream that is
   * never coming back.
   */
  private async handleTickFailure(task: ShipTask, err: unknown): Promise<void> {
    const { events, knobs, tasks, contracts, shipSymbol } = this.deps;
    const kind = verdictOf(err);
    // Which budget this failure is spent against. Both counters keep moving —
    // their sum is what lets the `consecutive_failures` alarm name a stuck
    // ship, whatever is stucking it — but they are separate numbers, because
    // one number cannot be spent against two budgets: three ticks of an outage
    // would otherwise leave the next genuine refusal one strike away from
    // abandoning a target it had never once failed against.
    const blamesTarget = kind !== "unavailable" && kind !== "credentials";
    const counted: ShipTask = {
      ...task,
      failureCount: task.failureCount + (blamesTarget ? 1 : 0),
      unrelatedFailureCount: task.unrelatedFailureCount + (blamesTarget ? 0 : 1),
    };
    await events.append("mining_tick_error", {
      shipSymbol,
      message: String(err),
      failureKind: kind,
      failureCount: counted.failureCount,
      unrelatedFailureCount: counted.unrelatedFailureCount,
    });

    // Same discard invariant as the success path: an abort or a switch to
    // shadow mode mid-flight must stop this failure from mutating ship_task.
    if (!this.isStillLive()) return;

    // Cargo already in the hold but not yet disposed of (extracted but not
    // sold, or purchased but not delivered) — abandoning the target now would
    // strand it with no code path back to selling or delivering it. Keep
    // retrying the same target instead while cargo is at stake.
    const cargoAtStake = this.cargoAtStake(task);

    // The whole branch: a failure that says nothing about the target buys the
    // ship a far longer budget on it, rather than none at all.
    const retryLimit =
      (await knobs.get("mine.failureRetryLimit")) * (blamesTarget ? 1 : UNRELATED_FAILURE_RETRY_MULTIPLIER);
    const spent = blamesTarget ? counted.failureCount : counted.unrelatedFailureCount;
    if (spent < retryLimit || cargoAtStake) {
      await tasks.recordFailure(counted);
      return;
    }
    // Release an abandoned contract back to the pool rather than leaving it
    // permanently "assigned" to a ship that's given up on it.
    if (task.taskKind === "contract" && task.contractId !== null) {
      await contracts.setStatus(task.contractId, "accepted");
    }
    await tasks.save(idleTask(task));
    await events.append("mining_task_failed", {
      shipSymbol,
      asteroidWaypoint: task.asteroidWaypoint,
      contractId: task.contractId,
      failureCount: counted.failureCount,
      unrelatedFailureCount: counted.unrelatedFailureCount,
      failureKind: kind,
    });
  }
}

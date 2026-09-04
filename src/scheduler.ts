import { Pool } from "pg";
import { AutopilotState } from "./autopilotState";
import { Clock } from "./clock";
import { discoverAndEvaluateContracts } from "./contractDiscovery";
import { ContractRepo } from "./contractRepo";
import { advanceContractTask } from "./contractTask";
import { EventLog } from "./eventLog";
import { GameClients, ShipSnapshot } from "./gameClients";
import { IntervalLoop } from "./intervalLoop";
import { KnobRepo } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { advanceMiningTask } from "./miningTask";
import { ObservationRepo } from "./observations";
import { Planner } from "./planner";
import { advanceScoutTask } from "./scoutTask";
import { idleTask, isIdle, ShipTask, ShipTaskRepo } from "./shipTaskRepo";
import { TickObservations, TickResult } from "./taskFsm";
import { withTransaction } from "./transaction";

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

  constructor(private readonly deps: FleetSchedulerDeps) {
    this.loop = new IntervalLoop(deps.intervalMs, () => this.tick(), (err) =>
      deps.events.append("mining_tick_error", { shipSymbol: deps.shipSymbol, message: String(err) })
    );
  }

  start(): void {
    this.startedAt = this.deps.clock.now();
    this.loop.start();
  }

  /** Resolves only once any in-flight tick has finished, so an abort's response means nothing is still running. */
  stop(): Promise<void> {
    return this.loop.stop();
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
   * The raw game token the operator armed with, threaded to gameClients for
   * `X-SpaceTraders-Token`. Not an Authorization value: that header carries
   * this service's own M2M token, minted by gameClients itself (decision 19).
   */
  private spaceTradersToken(): string | null {
    return this.deps.state.getToken();
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
    const spaceTradersToken = this.spaceTradersToken();
    if (spaceTradersToken === null) return;

    // Shadow mode (meta#21): run the planner's scoring cycle and log every
    // decision, but never touch ship_task or dispatch a ship action. Nothing is
    // ever "assigned", so the same cycle replays every tick — a continuous
    // preview of what live mode would do. Paused shadow does nothing, same as
    // paused live starts nothing new.
    if (state.getMode() === "shadow") {
      if (status === "armed") await this.runShadowCycle(spaceTradersToken);
      return;
    }

    // A replan that considered this ship already spent its one action for
    // this tick (even a "no viable target" outcome); running the normal
    // dispatch as well would double-fire contract discovery's upstream calls.
    // A replan that didn't touch this ship must not block it, hence the set.
    if (status === "armed") {
      const replanned = await this.maybeReplan(spaceTradersToken);
      if (replanned?.has(shipSymbol)) return;
    }

    const task = await tasks.getOrCreate(shipSymbol);
    if (isIdle(task)) {
      if (status === "paused") return; // never start a new assignment while paused
      await this.assignTarget(task, spaceTradersToken);
      return;
    }
    if (status === "paused" && task.waitingUntil === null) return; // idle between steps

    const ship = await clients.getShip(shipSymbol, spaceTradersToken);
    let result: TickResult | null;
    try {
      result = await this.advance(task, ship, spaceTradersToken);
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
    // Any successful action clears the consecutive-failure count.
    await tasks.save({ ...result.task, failureCount: 0 });
    // Observations and the event land after the task write, so anything
    // reading them can trust the state they describe is already visible.
    await this.recordObservations(result.observations);
    await events.append(result.event, result.detail);
  }

  /** One FSM step for whatever kind of task the ship is running. */
  private async advance(task: ShipTask, ship: ShipSnapshot, spaceTradersToken: string): Promise<TickResult | null> {
    const { clients, clock, contracts } = this.deps;
    const ctx = { task, ship, clients, clock, spaceTradersToken };
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
  private async maybeReplan(spaceTradersToken: string): Promise<Set<string> | null> {
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
    for (const task of idle) await this.assignTarget(task, spaceTradersToken);
    await this.deps.events.append("replan_executed", { reason, shipsConsidered: idle.length });
    return new Set(idle.map((t) => t.shipSymbol));
  }

  private async runShadowCycle(spaceTradersToken: string): Promise<void> {
    const { clients, planner, clock, state, events, shipSymbol } = this.deps;
    const ship = await clients.getShip(shipSymbol, spaceTradersToken);
    const assignment = await planner.assignTarget({ ship, spaceTradersToken, now: clock.now() });
    // A switch back to live, a pause, or an abort mid-flight all mean this
    // decision is stale — fine to have computed (it's read-only), just not
    // worth logging as "what shadow just decided".
    if (state.getStatus() !== "armed" || state.getMode() !== "shadow") return;
    await events.append("planner_shadow_assignment", assignment.detail);
  }

  private async assignTarget(task: ShipTask, spaceTradersToken: string): Promise<void> {
    const { clients, planner, clock, state, events, tasks, contracts, pool } = this.deps;
    const ship = await clients.getShip(task.shipSymbol, spaceTradersToken);

    // Catch up on any contract SpaceTraders has on offer that this agent
    // hasn't seen yet before scoring — otherwise a fresh, higher-scoring
    // contract could still be unevaluated when this tick locks the ship into a
    // mining target instead (meta#11). A failure here must not block mining:
    // contracts are additive, never a dependency.
    try {
      await discoverAndEvaluateContracts({ contracts, events, clients, planner, ship, spaceTradersToken });
    } catch (err) {
      await events.append("contract_discovery_error", { message: String(err) });
    }

    const assignment = await planner.assignTarget({ ship, spaceTradersToken, now: clock.now() });

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
        await tasks.save({ ...idleTask(task), asteroidWaypoint: assignment.asteroidWaypoint });
        return;
      case "scout":
        await tasks.save({ ...idleTask(task), taskKind: "scout", phase: "SCOUT_TRAVEL", asteroidWaypoint: assignment.scoutWaypoint });
        return;
      case "contract": {
        const { contract } = assignment;
        // Both writes must land together (meta#30) — a crash between them would
        // otherwise leave the contract "assigned" with no ship_task pointing at
        // it, and assigned contracts are never re-offered to the planner.
        await withTransaction(pool, async (client) => {
          await new ContractRepo(client, clock).setStatus(contract.contractId, "assigned");
          await new ShipTaskRepo(client, clock).save({
            ...idleTask(task),
            taskKind: "contract",
            phase: "CONTRACT_TRAVEL_TO_MARKET",
            tradeSymbol: contract.tradeSymbol,
            marketWaypoint: contract.procurementMarket,
            contractId: contract.contractId,
            destinationWaypoint: contract.destinationWaypoint,
          });
        });
        return;
      }
    }
  }

  /**
   * A real upstream failure while working a target (not a planner/infra error —
   * those are caught by the loop's error handler). After `mine.failureRetryLimit`
   * consecutive failures on the same target, the planner reassigns on the
   * ship's next tick instead of retrying the same target forever.
   */
  private async handleTickFailure(task: ShipTask, err: unknown): Promise<void> {
    const { events, knobs, tasks, contracts, shipSymbol } = this.deps;
    const failureCount = task.failureCount + 1;
    const retryLimit = await knobs.get("mine.failureRetryLimit");
    await events.append("mining_tick_error", { shipSymbol, message: String(err), failureCount });

    // Same discard invariant as the success path: an abort or a switch to
    // shadow mode mid-flight must stop this failure from mutating ship_task.
    if (!this.isStillLive()) return;

    // Cargo already in the hold but not yet disposed of (extracted but not
    // sold, or purchased but not delivered) — abandoning the target now would
    // strand it with no code path back to selling or delivering it. Keep
    // retrying the same target instead while cargo is at stake.
    //
    // For contract tasks, tradeSymbol is set at assignment time, not after a
    // purchase — so cargo is only at stake once a purchase has been dispatched
    // (meta#27), i.e. CONTRACT_TRAVEL_TO_DESTINATION or later.
    const cargoAtStake =
      task.taskKind === "contract"
        ? task.phase === "CONTRACT_TRAVEL_TO_DESTINATION" || task.phase === "CONTRACT_DELIVER" || task.phase === "CONTRACT_FULFILL"
        : task.tradeSymbol !== null;

    if (failureCount < retryLimit || cargoAtStake) {
      await tasks.save({ ...task, failureCount });
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
      failureCount,
    });
  }
}

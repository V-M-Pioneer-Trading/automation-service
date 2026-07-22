import { Pool } from "pg";
import { AutopilotState, AutopilotStatus } from "./autopilotState";
import { Clock } from "./clock";
import { ContractRepo } from "./contractRepo";
import { discoverAndEvaluateContracts } from "./contractScheduler";
import { advanceContractTask } from "./contractTask";
import { withTransaction } from "./db";
import { EventLog } from "./eventLog";
import { GameClients } from "./gameClients";
import { KnobRepo } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { advanceMiningTask, TickResult } from "./miningTask";
import { Planner } from "./planner";
import { advanceScoutTask } from "./scoutTask";
import { ShipTask, ShipTaskRepo } from "./shipTaskRepo";

const FRESH_MINING_TASK: Pick<
  ShipTask,
  "taskKind" | "phase" | "waitingUntil" | "survey" | "tradeSymbol" | "marketWaypoint" | "asteroidWaypoint" | "contractId" | "destinationWaypoint" | "unitsDelivered" | "failureCount"
> = {
  taskKind: "mining",
  phase: "TRAVEL_TO_ASTEROID",
  waitingUntil: null,
  survey: null,
  tradeSymbol: null,
  marketWaypoint: null,
  asteroidWaypoint: null,
  contractId: null,
  destinationWaypoint: null,
  unitsDelivered: 0,
  failureCount: 0,
};

/**
 * Polls the configured ship's task — mining or contract (meta#11), whichever
 * the planner assigned — on a fixed interval. Runs while armed (full
 * progression) or paused (only finishes an already-dispatched wait, never
 * starts a new action — that's what makes pause take effect between steps
 * instead of aborting mid-cycle). Stops entirely on disarm/abort.
 *
 * A ship with no assigned target gets one from the planner (meta#10/#11) as
 * its own tick's one atomic action, before any FSM dispatch — so a brand new
 * task, and a task whose cycle just completed, both get a target on their very
 * next tick rather than waiting on any separate periodic process.
 */
export class MiningScheduler {
  private timer: NodeJS.Timeout | null = null;
  // A tick awaits several HTTP calls, so it can easily outlast one interval
  // period; without this guard, setInterval fires again mid-tick and two ticks
  // race on the same ship_task row, double-dispatching an action.
  private ticking = false;
  // Tracks the in-flight tick so stop() can await it, and a hard flag checked
  // at tick() entry so a timer callback already queued when stop() runs can't
  // still start a new tick afterward — assignTarget() (meta#11's contract
  // discovery folded in) can now run several sequential HTTP calls, widening
  // the window a leftover tick could otherwise still be running in when the
  // next test's TRUNCATE (or a real re-arm) lands.
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  // Fleet-wide replan (meta#13) state: lastReplanAt gates every trigger source
  // (knob change, anomaly, manual, periodic) behind one shared debounce/interval
  // clock, so "two triggers within the debounce window" coalesce into one run
  // regardless of which sources fired them.
  private lastReplanAt: Date | null = null;
  // Anchors the periodic fallback so a fresh arm doesn't read as "infinitely
  // overdue" and fire a replan on its very first live tick.
  private schedulerStartedAt: Date | null = null;
  private replanRequested = false;
  private replanReason: string | null = null;

  constructor(
    private state: AutopilotState,
    private repo: ShipTaskRepo,
    private events: EventLog,
    private clients: GameClients,
    private clock: Clock,
    private planner: Planner,
    private knobs: KnobRepo,
    private contracts: ContractRepo,
    private marketIntel: MarketIntelRepo,
    private pool: Pool,
    private config: { shipSymbol: string; intervalMs: number; replanIntervalMs: number }
  ) {}

  /**
   * Requests a fleet replan (meta#13): a knob change, a newly-recorded anomaly,
   * or the manual /planner/replan endpoint all call this. The request is only
   * acted on once replan.debounceSeconds has elapsed since the last replan (of
   * any kind) — a burst of triggers inside that window coalesces into the one
   * replan that runs once the debounce clears.
   */
  requestReplan(reason: string): void {
    this.replanRequested = true;
    this.replanReason = reason;
  }

  start(): void {
    if (this.timer !== null) return;
    this.schedulerStartedAt = this.clock.now();
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.inFlight = this.tick()
        .catch((err) => this.events.append("mining_tick_error", { message: String(err) }))
        .finally(() => {
          this.ticking = false;
          this.inFlight = null;
        });
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight !== null) await this.inFlight;
  }

  /**
   * True unless the operator has since aborted, or switched to shadow mode —
   * the two ways an already-in-flight live dispatch's result must be discarded
   * instead of persisted. Deliberately NOT status === "armed": pausing mid-flight
   * still lets that one in-flight result land (that's the whole point of pause
   * letting the current wait finish), so "paused" must stay a pass here too.
   */
  private isStillLive(): boolean {
    return this.state.getStatus() !== "aborted" && this.state.getMode() === "live";
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const status: AutopilotStatus = this.state.getStatus();
    if (status !== "armed" && status !== "paused") return;

    // Fleet replan (meta#13): only meaningful in live mode — shadow never
    // assigns anything, so there's nothing for a replan to preempt or refresh.
    // Runs before the per-ship dispatch below. If the replan considered this
    // tick's configured ship, that's this tick's one atomic action for it —
    // even a "no viable target" outcome leaves the ship idle, and re-running
    // the normal dispatch below for the same ship in the same tick would
    // double-fire discoverAndEvaluateContracts's real upstream calls. A replan
    // that didn't touch this ship (it wasn't idle) must NOT block the ship's
    // normal dispatch this tick — only skip when it actually overlaps.
    let replannedShips: Set<string> | null = null;
    if (status === "armed" && this.state.getMode() === "live") {
      replannedShips = await this.maybeReplan();
    }
    if (replannedShips?.has(this.config.shipSymbol)) return;

    // Shadow mode (meta#21): run the planner's scoring/assignment cycle and log
    // every decision, but never touch ship_task or advance*Task — that's
    // where every ship-action call to fleet-service lives. Nothing is ever
    // "assigned" in shadow, so the same cycle replays and re-logs every tick,
    // which is the point: it's a continuous preview of what live mode would do.
    if (this.state.getMode() === "shadow") {
      if (status !== "armed") return; // same "nothing new while paused" rule as live
      await this.runShadowCycle();
      return;
    }

    const task = await this.repo.getOrCreate(this.config.shipSymbol);

    if (task.asteroidWaypoint === null && task.contractId === null) {
      if (status === "paused") return; // don't start a new assignment while paused
      await this.assignTarget(task);
      return; // assignment is this tick's one atomic action; dispatch starts next tick
    }

    if (status === "paused" && task.waitingUntil === null) return; // idle between steps

    const token = this.state.getToken();
    if (token === null) return; // disarmed between the status check above and here
    const authHeader = `Bearer ${token}`;

    const ship = await this.clients.getShip(this.config.shipSymbol, authHeader);

    let result: TickResult | null;
    try {
      let contractRecord = null;
      if (task.taskKind === "contract") {
        // The contract row's unitsRequired is the total this ship must
        // deliver (fixed at assignment); task.unitsDelivered tracks
        // progress against that same total across possibly several trips.
        contractRecord = await this.contracts.get(task.contractId!);
        if (contractRecord === null) {
          throw new Error(`contract ${task.contractId} not found for ship ${task.shipSymbol}`);
        }
      }
      result =
        task.taskKind === "contract"
          ? await advanceContractTask({
              task,
              ship,
              contractId: task.contractId!,
              tradeSymbol: task.tradeSymbol!,
              procurementMarket: task.marketWaypoint!,
              destinationWaypoint: task.destinationWaypoint!,
              unitsRequired: contractRecord!.unitsRequired,
              clients: this.clients,
              clock: this.clock,
              authHeader,
            })
          : task.taskKind === "scout"
            ? await advanceScoutTask({
                task,
                ship,
                scoutWaypoint: task.asteroidWaypoint!, // reused: the planner's assigned target
                clients: this.clients,
                clock: this.clock,
                authHeader,
              })
            : await advanceMiningTask({
                task,
                ship,
                systemSymbol: ship.nav.systemSymbol,
                asteroidWaypoint: task.asteroidWaypoint!,
                clients: this.clients,
                clock: this.clock,
                authHeader,
              });
    } catch (err) {
      await this.handleTickFailure(task, err);
      return;
    }
    if (result === null) return; // still waiting

    // The dispatch above already happened — it can't be un-sent — but an abort,
    // or a re-arm into shadow mode, during those awaits must still stop it from
    // taking further effect: no persisted phase transition, no event claiming
    // the (now shadow, or now stopped) autopilot did this.
    if (!this.isStillLive()) {
      await this.events.append("mining_discarded_after_abort", { shipSymbol: this.config.shipSymbol, event: result.event });
      return;
    }

    let finalTask: ShipTask = task.failureCount > 0 ? { ...result.task, failureCount: 0 } : result.task;

    // A contract just fulfilled: hand the ship back to the planner (mining or
    // the next accepted contract) on its very next tick, same pattern as
    // mining_cycle_complete handing an exhausted asteroid field back.
    if (result.event === "contract_fulfilled") {
      await this.contracts.setStatus(task.contractId!, "fulfilled");
      finalTask = { ...finalTask, ...FRESH_MINING_TASK };
    }

    // A scout just refreshed a market: record the fresh timestamp and hand
    // the ship back to the planner for its next assignment.
    if (result.event === "scout_market_refresh") {
      await this.marketIntel.record(task.asteroidWaypoint!);
      finalTask = { ...finalTask, ...FRESH_MINING_TASK };
    }

    await this.repo.save(finalTask);
    await this.events.append(result.event, result.detail);
  }

  /**
   * Gates every replan trigger behind one shared debounce/interval clock.
   * A requested replan (knob change, anomaly, manual) only runs once
   * replan.debounceSeconds has elapsed since the last replan of any kind; the
   * periodic fallback runs on replanIntervalMs regardless of whether anything
   * was explicitly requested, so a replan still happens even if no operator or
   * anomaly triggers one for a while.
   */
  private async maybeReplan(): Promise<Set<string> | null> {
    const now = this.clock.now();
    const debounceMs = (await this.knobs.get("replan.debounceSeconds")) * 1000;

    // Debounce gate for requested replans (knob change / anomaly / manual):
    // Infinity until the very first replan ever runs, so an early request
    // isn't held back waiting on a run that hasn't happened yet.
    const elapsedSinceLastReplan = this.lastReplanAt === null ? Infinity : now.getTime() - this.lastReplanAt.getTime();
    const requestReady = this.replanRequested && elapsedSinceLastReplan >= debounceMs;

    // Periodic fallback: due replanIntervalMs after the last replan of any
    // kind, or after arm if none has run yet — never immediately at arm time.
    const baseline = this.lastReplanAt ?? this.schedulerStartedAt;
    const elapsedSinceBaseline = baseline === null ? Infinity : now.getTime() - baseline.getTime();
    const intervalReady = elapsedSinceBaseline >= this.config.replanIntervalMs;

    if (!requestReady && !intervalReady) return null;

    const reason = requestReady ? this.replanReason ?? "requested" : "interval";
    this.replanRequested = false;
    this.replanReason = null;
    this.lastReplanAt = now;

    return await this.runReplan(reason);
  }

  /**
   * Re-scores every ship with no assigned target (meta#10's idle predicate) —
   * a brand new task, or one whose cycle just completed. A ship mid-task never
   * matches that predicate, so it's never touched by a replan: running work is
   * never preempted, only idle/completing ships are (re)assigned. Returns the
   * set of ships considered, so the caller can avoid double-dispatching one of
   * them again as this same tick's "normal" per-ship action.
   */
  private async runReplan(reason: string): Promise<Set<string>> {
    const idleTasks = await this.repo.listIdle();
    for (const idleTask of idleTasks) {
      await this.assignTarget(idleTask);
    }
    await this.events.append("replan_executed", { reason, shipsConsidered: idleTasks.length });
    return new Set(idleTasks.map((t) => t.shipSymbol));
  }

  private async runShadowCycle(): Promise<void> {
    const token = this.state.getToken();
    if (token === null) return; // disarmed between the status check above and here
    const authHeader = `Bearer ${token}`;

    const [ship, acceptedContracts, marketIntel] = await Promise.all([
      this.clients.getShip(this.config.shipSymbol, authHeader),
      this.contracts.listAccepted(),
      this.marketIntel.getAll(),
    ]);
    const assignment = await this.planner.assignTarget({
      ship,
      systemSymbol: ship.nav.systemSymbol,
      authHeader,
      acceptedContracts,
      marketIntel,
      now: this.clock.now(),
    });

    // A switch back to live (re-arm), a pause, or an abort mid-flight all mean
    // this particular decision is stale — still fine to have computed it (it's
    // read-only), just not worth logging as "what shadow just decided".
    if (this.state.getStatus() !== "armed" || this.state.getMode() !== "shadow") return;

    await this.events.append("planner_shadow_assignment", assignment.detail);
  }

  private async assignTarget(task: ShipTask): Promise<void> {
    const token = this.state.getToken();
    if (token === null) return; // disarmed between the status check above and here
    const authHeader = `Bearer ${token}`;

    // Catch up on any contract SpaceTraders has on offer that this agent
    // hasn't seen yet before scoring — otherwise a fresh, higher-scoring
    // contract could still be mid-evaluation when this same tick locks the
    // ship into a mining target instead (meta#11). A failure here (agent-service
    // hiccup, no contracts endpoint configured, etc.) must not block mining —
    // contracts are additive on top of mining, never a hard dependency of it.
    try {
      await discoverAndEvaluateContracts({
        repo: this.contracts,
        events: this.events,
        clients: this.clients,
        knobs: this.knobs,
        planner: this.planner,
        shipSymbol: task.shipSymbol,
        authHeader,
      });
    } catch (err) {
      await this.events.append("contract_discovery_error", { message: String(err) });
    }

    const [ship, acceptedContracts, marketIntel] = await Promise.all([
      this.clients.getShip(task.shipSymbol, authHeader),
      this.contracts.listAccepted(),
      this.marketIntel.getAll(),
    ]);
    const assignment = await this.planner.assignTarget({
      ship,
      systemSymbol: ship.nav.systemSymbol,
      authHeader,
      acceptedContracts,
      marketIntel,
      now: this.clock.now(),
    });

    // "Don't start anything new while paused" applies here too, not just at the
    // top-of-tick check — a pause, abort, or switch to shadow mode landing during
    // these awaits must still stop the in-flight decision from being persisted
    // as a new live assignment.
    const statusAfterAssignment = this.state.getStatus();
    if (statusAfterAssignment !== "armed" || this.state.getMode() !== "live") {
      await this.events.append("planner_discarded_after_abort_or_pause", {
        shipSymbol: task.shipSymbol,
        status: statusAfterAssignment,
        mode: this.state.getMode(),
      });
      return;
    }

    await this.events.append("planner_assignment", assignment.detail);

    if (assignment.kind === "none") {
      await this.events.append("planner_no_viable_target", { shipSymbol: task.shipSymbol });
      return;
    }

    if (assignment.kind === "mine") {
      await this.repo.save({ ...task, ...FRESH_MINING_TASK, asteroidWaypoint: assignment.asteroidWaypoint });
      return;
    }

    if (assignment.kind === "scout") {
      await this.repo.save({
        ...task,
        taskKind: "scout",
        phase: "SCOUT_TRAVEL",
        waitingUntil: null,
        survey: null,
        tradeSymbol: null,
        marketWaypoint: null,
        asteroidWaypoint: assignment.scoutWaypoint,
        contractId: null,
        destinationWaypoint: null,
        unitsDelivered: 0,
        failureCount: 0,
      });
      return;
    }

    // Both writes must land together (meta#30) — a crash between them would
    // otherwise leave the contract "assigned" with no ship_task pointing at it,
    // and contracts in "assigned" state are never re-offered to the planner.
    await withTransaction(this.pool, async (client) => {
      await new ContractRepo(client, this.clock).setStatus(assignment.contractId, "assigned");
      await new ShipTaskRepo(client, this.clock).save({
        ...task,
        taskKind: "contract",
        phase: "CONTRACT_TRAVEL_TO_MARKET",
        waitingUntil: null,
        survey: null,
        tradeSymbol: assignment.tradeSymbol,
        marketWaypoint: assignment.procurementMarket,
        asteroidWaypoint: null,
        contractId: assignment.contractId,
        destinationWaypoint: assignment.destinationWaypoint,
        unitsDelivered: 0,
        failureCount: 0,
      });
    });
  }

  /**
   * A real upstream failure while working a target (not a planner/infra error —
   * those are caught by start()'s outer .catch()). After `mine.failureRetryLimit`
   * consecutive failures on the same target, the planner reassigns immediately on
   * the ship's next tick instead of retrying the same target forever.
   */
  private async handleTickFailure(task: ShipTask, err: unknown): Promise<void> {
    const failureCount = task.failureCount + 1;
    const retryLimit = await this.knobs.get("mine.failureRetryLimit");
    await this.events.append("mining_tick_error", {
      shipSymbol: this.config.shipSymbol,
      message: String(err),
      failureCount,
    });

    // An abort, or a switch to shadow mode, landing while the failed dispatch
    // was in flight must still stop this failure from mutating ship_task —
    // same discard invariant as the success path above, just for the error path.
    if (!this.isStillLive()) return;

    // A trade good already sits in the cargo hold uncommitted (extracted but not
    // sold, or purchased but not delivered) — abandoning the target here would
    // strand that cargo with no code path back to selling/delivering it. Keep
    // retrying the same target indefinitely rather than reassigning away from
    // it while cargo is at stake.
    //
    // For contract tasks, tradeSymbol is set at assignment time (the good the
    // contract requires), not after a purchase — so it can't be used as the
    // cargo signal there (meta#27). Cargo is only actually at stake once a
    // purchase has been dispatched, i.e. CONTRACT_TRAVEL_TO_DESTINATION or later.
    const cargoAtStake =
      task.taskKind === "contract"
        ? task.phase === "CONTRACT_TRAVEL_TO_DESTINATION" || task.phase === "CONTRACT_DELIVER" || task.phase === "CONTRACT_FULFILL"
        : task.tradeSymbol !== null;

    if (failureCount < retryLimit || cargoAtStake) {
      await this.repo.save({ ...task, failureCount });
      return;
    }
    await this.events.append("mining_task_failed", {
      shipSymbol: this.config.shipSymbol,
      asteroidWaypoint: task.asteroidWaypoint,
      contractId: task.contractId,
      failureCount,
    });
    // Release an abandoned contract back to the pool rather than leaving it
    // permanently "assigned" to a ship that's given up on it.
    if (task.taskKind === "contract" && task.contractId !== null) {
      await this.contracts.setStatus(task.contractId, "accepted");
    }
    await this.repo.save({ ...task, ...FRESH_MINING_TASK });
  }
}

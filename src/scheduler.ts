import { AutopilotState, AutopilotStatus } from "./autopilotState";
import { Clock } from "./clock";
import { EventLog } from "./eventLog";
import { GameClients } from "./gameClients";
import { KnobRepo } from "./knobs";
import { advanceMiningTask } from "./miningTask";
import { Planner } from "./planner";
import { ShipTask, ShipTaskRepo } from "./shipTaskRepo";

/**
 * Polls the configured ship's mining task on a fixed interval. Runs while armed
 * (full progression) or paused (only finishes an already-dispatched wait, never
 * starts a new action — that's what makes pause take effect between steps
 * instead of aborting mid-cycle). Stops entirely on disarm/abort.
 *
 * A ship with no assigned asteroidWaypoint gets one from the planner (meta#10)
 * as its own tick's one atomic action, before any FSM dispatch — so a brand new
 * task, and a task whose cycle just completed, both get a target on their very
 * next tick rather than waiting on any separate periodic process.
 */
export class MiningScheduler {
  private timer: NodeJS.Timeout | null = null;
  // A tick awaits several HTTP calls, so it can easily outlast one interval
  // period; without this guard, setInterval fires again mid-tick and two ticks
  // race on the same ship_task row, double-dispatching an action.
  private ticking = false;

  constructor(
    private state: AutopilotState,
    private repo: ShipTaskRepo,
    private events: EventLog,
    private clients: GameClients,
    private clock: Clock,
    private planner: Planner,
    private knobs: KnobRepo,
    private config: { shipSymbol: string; intervalMs: number }
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch((err) => this.events.append("mining_tick_error", { message: String(err) }))
        .finally(() => {
          this.ticking = false;
        });
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
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
    const status: AutopilotStatus = this.state.getStatus();
    if (status !== "armed" && status !== "paused") return;

    // Shadow mode (meta#21): run the planner's scoring/assignment cycle and log
    // every decision, but never touch ship_task or advanceMiningTask — that's
    // where every ship-action call to fleet-service lives. Nothing is ever
    // "assigned" in shadow, so the same cycle replays and re-logs every tick,
    // which is the point: it's a continuous preview of what live mode would do.
    if (this.state.getMode() === "shadow") {
      if (status !== "armed") return; // same "nothing new while paused" rule as live
      await this.runShadowCycle();
      return;
    }

    const task = await this.repo.getOrCreate(this.config.shipSymbol);

    if (task.asteroidWaypoint === null) {
      if (status === "paused") return; // don't start a new assignment while paused
      await this.assignTarget(task);
      return; // assignment is this tick's one atomic action; dispatch starts next tick
    }

    if (status === "paused" && task.waitingUntil === null) return; // idle between steps

    const token = this.state.getToken();
    if (token === null) return; // disarmed between the status check above and here
    const authHeader = `Bearer ${token}`;

    const ship = await this.clients.getShip(this.config.shipSymbol, authHeader);

    let result;
    try {
      result = await advanceMiningTask({
        task,
        ship,
        systemSymbol: ship.nav.systemSymbol,
        asteroidWaypoint: task.asteroidWaypoint,
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

    const finalTask: ShipTask = task.failureCount > 0 ? { ...result.task, failureCount: 0 } : result.task;
    await this.repo.save(finalTask);
    await this.events.append(result.event, result.detail);
  }

  private async runShadowCycle(): Promise<void> {
    const token = this.state.getToken();
    if (token === null) return; // disarmed between the status check above and here
    const authHeader = `Bearer ${token}`;

    const ship = await this.clients.getShip(this.config.shipSymbol, authHeader);
    const assignment = await this.planner.assignMiningTarget({
      ship,
      systemSymbol: ship.nav.systemSymbol,
      authHeader,
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

    const ship = await this.clients.getShip(this.config.shipSymbol, authHeader);
    const assignment = await this.planner.assignMiningTarget({
      ship,
      systemSymbol: ship.nav.systemSymbol,
      authHeader,
    });

    // "Don't start anything new while paused" applies here too, not just at the
    // top-of-tick check — a pause, abort, or switch to shadow mode landing during
    // these awaits must still stop the in-flight decision from being persisted
    // as a new live assignment.
    const statusAfterAssignment = this.state.getStatus();
    if (statusAfterAssignment !== "armed" || this.state.getMode() !== "live") {
      await this.events.append("planner_discarded_after_abort_or_pause", {
        shipSymbol: this.config.shipSymbol,
        status: statusAfterAssignment,
        mode: this.state.getMode(),
      });
      return;
    }

    await this.events.append("planner_assignment", assignment.detail);
    if (assignment.asteroidWaypoint === null) {
      await this.events.append("planner_no_viable_target", { shipSymbol: this.config.shipSymbol });
      return;
    }
    await this.repo.save({ ...task, asteroidWaypoint: assignment.asteroidWaypoint, failureCount: 0 });
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

    // A trade good already sits in the cargo hold uncommitted to any sale (it was
    // extracted but the market/sell leg is what's failing) — abandoning the
    // target here would strand that cargo with no code path back to selling it.
    // Keep retrying the same target indefinitely rather than reassigning away
    // from it while cargo is at stake.
    const cargoAtStake = task.tradeSymbol !== null;

    if (failureCount < retryLimit || cargoAtStake) {
      await this.repo.save({ ...task, failureCount });
      return;
    }
    await this.events.append("mining_task_failed", {
      shipSymbol: this.config.shipSymbol,
      asteroidWaypoint: task.asteroidWaypoint,
      failureCount,
    });
    await this.repo.save({
      ...task,
      phase: "TRAVEL_TO_ASTEROID",
      waitingUntil: null,
      survey: null,
      tradeSymbol: null,
      marketWaypoint: null,
      asteroidWaypoint: null,
      failureCount: 0,
    });
  }
}

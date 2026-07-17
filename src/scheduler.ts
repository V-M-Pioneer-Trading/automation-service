import { AutopilotState, AutopilotStatus } from "./autopilotState";
import { Clock } from "./clock";
import { EventLog } from "./eventLog";
import { GameClients } from "./gameClients";
import { advanceMiningTask } from "./miningTask";
import { ShipTaskRepo } from "./shipTaskRepo";

/**
 * Polls the configured ship's mining task on a fixed interval. Runs while armed
 * (full progression) or paused (only finishes an already-dispatched wait, never
 * starts a new action — that's what makes pause take effect between steps
 * instead of aborting mid-cycle). Stops entirely on disarm/abort.
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
    private config: { shipSymbol: string; asteroidWaypoint: string; intervalMs: number }
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

  async tick(): Promise<void> {
    const status: AutopilotStatus = this.state.getStatus();
    if (status !== "armed" && status !== "paused") return;

    const task = await this.repo.getOrCreate(this.config.shipSymbol);
    if (status === "paused" && task.waitingUntil === null) return; // idle between steps

    const token = this.state.getToken();
    if (token === null) return; // disarmed between the status check above and here
    const authHeader = `Bearer ${token}`;

    const ship = await this.clients.getShip(this.config.shipSymbol, authHeader);

    const result = await advanceMiningTask({
      task,
      ship,
      systemSymbol: ship.nav.systemSymbol,
      asteroidWaypoint: this.config.asteroidWaypoint,
      clients: this.clients,
      clock: this.clock,
      authHeader,
    });
    if (result === null) return; // still waiting

    // The dispatch above already happened — it can't be un-sent — but an abort
    // during those awaits must still stop it from taking further effect: no
    // persisted phase transition, no event claiming the autopilot did this.
    if (this.state.getStatus() === "aborted") {
      await this.events.append("mining_discarded_after_abort", { shipSymbol: this.config.shipSymbol, event: result.event });
      return;
    }

    await this.repo.save(result.task);
    await this.events.append(result.event, result.detail);
  }
}

import { AnomalyChecker, AnomalyRepo } from "./anomaly";
import { AutopilotState } from "./autopilotState";
import { Clock } from "./clock";
import { EventLog } from "./eventLog";
import { GameClients } from "./gameClients";
import { IntervalLoop } from "./intervalLoop";
import { KnobRepo } from "./knobs";
import { ShipTaskRepo } from "./shipTaskRepo";
import { WebhookDelivery } from "./webhookDelivery";

export interface AnomalyConfig {
  intervalMs: number;
  webhookUrl: string;
}

export interface AnomalySchedulerDeps {
  state: AutopilotState;
  repo: AnomalyRepo;
  checker: AnomalyChecker;
  webhook: WebhookDelivery;
  events: EventLog;
  clock: Clock;
  knobs: KnobRepo;
  tasks: ShipTaskRepo;
  /** Null when no ship is configured — the per-ship checks then have nothing to read. */
  gameClients: GameClients | null;
  shipSymbol: string | null;
  intervalMs: number;
  /**
   * Fleet replan (meta#13): a newly-recorded (non-suppressed) anomaly is one of
   * the trigger sources for a replan. Optional so anomaly-only deployments
   * don't need a no-op wired in.
   */
  onAnomalyRecorded?: () => void;
}

/**
 * Runs the health checks on a fixed interval, independent of autopilot
 * arm/pause/abort (the checks themselves gate on live/armed where that's the
 * relevant condition — e.g. ship-idle only means something while mining is
 * actually supposed to be happening). Each detected anomaly is persisted
 * before its webhook delivery is attempted, and repeat firings of the same
 * underlying condition are suppressed for a knob-tunable cooldown instead of
 * paging the webhook every tick a problem remains open.
 */
export class AnomalyScheduler {
  private readonly loop: IntervalLoop;

  constructor(private readonly deps: AnomalySchedulerDeps) {
    this.loop = new IntervalLoop(deps.intervalMs, () => this.tick());
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Deterministic alternative to waiting on the real interval — see `IntervalLoop.runOnce`. */
  forceTick(): Promise<void> {
    return this.loop.runOnce();
  }

  private async tick(): Promise<void> {
    const { repo, checker, webhook, knobs, clock, tasks, shipSymbol, onAnomalyRecorded } = this.deps;
    await this.maybeSnapshotCredits();
    // stop() may have landed during that (real, potentially slow) HTTP call —
    // a tick that was told to stop must not go on to read or write state.
    if (this.loop.stopped) return;

    const task = shipSymbol === null ? null : await tasks.get(shipSymbol);
    const candidates = await checker.runChecks(shipSymbol ?? "unknown", task);
    if (this.loop.stopped) return;

    const cooldownMs = (await knobs.get("anomaly.dedupeCooldownMinutes")) * 60_000;
    const now = clock.now();

    for (const candidate of candidates) {
      if (this.loop.stopped) return;
      const recent = await repo.latestForKey(candidate.dedupeKey);
      if (recent !== null && now.getTime() - new Date(recent.detectedAt).getTime() < cooldownMs) continue;
      if (this.loop.stopped) return; // latestForKey's await is itself a gap stop() could land in

      const anomaly = await repo.record(candidate);
      onAnomalyRecorded?.();
      if (this.loop.stopped) return; // don't attempt delivery for a stop that landed mid-persist
      if (await webhook.deliver(anomaly)) await repo.markDelivered(anomaly.id);
      else await repo.incrementDeliveryAttempts(anomaly.id);
    }
  }

  /** Logs a credits snapshot while mining is actually live — the credits-flat check's only data source. */
  private async maybeSnapshotCredits(): Promise<void> {
    const { gameClients, state, events } = this.deps;
    if (gameClients === null) return;
    if (state.getStatus() !== "armed" || state.getMode() !== "live") return;
    const token = state.getToken();
    if (token === null) return;
    try {
      const agent = await gameClients.getAgent(token);
      if (this.loop.stopped) return; // a leaked in-flight tick must not persist after stop()
      await events.append("agent_credits_snapshot", { credits: agent.credits });
    } catch {
      // Upstream hiccup — skip this tick's snapshot rather than failing the whole check cycle.
    }
  }
}

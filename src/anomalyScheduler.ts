import { AnomalyChecker, AnomalyRepo } from "./anomaly";
import { AutopilotState } from "./autopilotState";
import { Clock } from "./clock";
import { EventLog } from "./eventLog";
import { GameClients } from "./gameClients";
import { KnobRepo } from "./knobs";
import { ShipTaskRepo } from "./shipTaskRepo";
import { WebhookDelivery } from "./webhookDelivery";

export interface AnomalyConfig {
  intervalMs: number;
  webhookUrl: string;
}

/**
 * Runs the six meta#15 health checks on a fixed interval, independent of
 * autopilot arm/pause/abort (the checks themselves gate on live/armed where
 * that's the relevant condition — e.g. ship-idle only means something while
 * mining is actually supposed to be happening). Each detected anomaly is
 * persisted before its webhook delivery is attempted, and repeat firings of
 * the same underlying condition are suppressed for a knob-tunable cooldown
 * instead of paging the webhook every tick a problem remains open.
 */
export class AnomalyScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  // Tracks the currently in-flight tick so stop() can await it — otherwise a
  // tick already past the interval-guard check keeps running (and can still
  // write to the DB) after stop() returns, which races a later test file's
  // TRUNCATE (observed as a spurious profit_drop anomaly from a stray
  // metrics_rollup row a leftover MetricsScheduler tick inserted mid-test).
  private inFlight: Promise<void> | null = null;
  // Belt-and-suspenders alongside clearInterval/inFlight: a timer callback
  // already queued by the event loop when stop() runs can still invoke tick()
  // once more before clearInterval takes effect. Checked synchronously at the
  // very top of tick(), before any awaits, so that race can't slip a write in.
  private stopped = false;

  constructor(
    private state: AutopilotState,
    private repo: AnomalyRepo,
    private checker: AnomalyChecker,
    private webhook: WebhookDelivery,
    private events: EventLog,
    private clock: Clock,
    private knobs: KnobRepo,
    private shipTaskRepo: ShipTaskRepo | null,
    private gameClients: GameClients | null,
    private config: { shipSymbol: string | null; intervalMs: number }
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.inFlight = this.tick()
        .catch(() => {})
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

  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.maybeSnapshotCredits();
    // stop() may have landed during that (real, potentially slow) HTTP call —
    // re-check before doing anything that reads or writes state, not just at
    // tick() entry, so a stop() mid-flight can't still complete a check/persist.
    if (this.stopped) return;

    const task =
      this.shipTaskRepo !== null && this.config.shipSymbol !== null
        ? await this.shipTaskRepo.get(this.config.shipSymbol)
        : null;

    const candidates = await this.checker.runChecks(
      this.config.shipSymbol ?? "unknown",
      task?.updatedAt ?? null,
      task?.failureCount ?? 0
    );
    if (this.stopped) return;

    const cooldownMinutes = await this.knobs.get("anomaly.dedupeCooldownMinutes");
    const now = this.clock.now();

    for (const candidate of candidates) {
      if (this.stopped) return;
      const recent = await this.repo.latestForKey(candidate.dedupeKey);
      if (recent !== null) {
        const sinceLastFire = now.getTime() - new Date(recent.detectedAt).getTime();
        if (sinceLastFire < cooldownMinutes * 60_000) continue; // still within the suppression window
      }
      // Re-check right before the persist, not just at the top of the loop —
      // latestForKey's await is itself a gap stop() could land in.
      if (this.stopped) return;

      const anomaly = await this.repo.record(candidate);
      if (this.stopped) return; // don't attempt delivery for a stop that landed mid-persist
      const delivered = await this.webhook.deliver(anomaly);
      if (delivered) {
        await this.repo.markDelivered(anomaly.id);
      } else {
        await this.repo.incrementDeliveryAttempts(anomaly.id);
      }
    }
  }

  /** Logs a credits snapshot while mining is actually live — the credits-flat check's only data source. */
  private async maybeSnapshotCredits(): Promise<void> {
    if (this.gameClients === null) return;
    if (this.state.getStatus() !== "armed" || this.state.getMode() !== "live") return;
    const token = this.state.getToken();
    if (token === null) return;
    try {
      const agent = await this.gameClients.getAgent(`Bearer ${token}`);
      // stop() may have landed during that (real, potentially slow) HTTP call —
      // re-check before writing, so a leaked in-flight tick can't still persist
      // a snapshot after the scheduler that owns it was told to stop.
      if (this.stopped) return;
      await this.events.append("agent_credits_snapshot", { credits: agent.credits });
    } catch {
      // Upstream hiccup — skip this tick's snapshot rather than failing the whole check cycle.
    }
  }
}

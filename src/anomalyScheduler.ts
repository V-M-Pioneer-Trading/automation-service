import { Anomaly, AnomalyChecker, AnomalyRepo } from "./anomaly";
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

/**
 * How many *rounds* of delivery an anomaly is worth in total — one per tick
 * that tries it, which is what `anomaly.delivery_attempts` counts.
 *
 * A round is not one HTTP request: `WebhookDelivery.deliver` retries with
 * backoff inside a single call (three attempts by default) and the counter is
 * incremented once for the whole call. So the real ceiling on POSTs is this
 * number times that one, and both have to be read together to know what a
 * dead webhook actually costs.
 *
 * The first round runs in the tick that records the anomaly; the rest are
 * spread over later ticks by `redeliverMissed`, so a webhook that comes back
 * within a few minutes still gets the page.
 */
const MAX_DELIVERY_ROUNDS = 12;
/** Oldest undelivered anomalies retried per tick, so a backlog can't stall the checks. */
const REDELIVERY_BATCH = 5;

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
      await this.attemptDelivery(anomaly);
    }

    await this.redeliverMissed();
  }

  /**
   * Re-sends anomalies that were recorded but never delivered.
   *
   * The first round failing used to be the end of it: the row stayed
   * undelivered forever, and dedupe meant no later firing of the same
   * condition would replace the missed page — so a webhook that was down for a
   * minute lost the alert permanently, while the record sat safely in Postgres
   * looking like nothing was wrong. Each later tick now retries a few of the
   * oldest, within `MAX_DELIVERY_ROUNDS`, so a recovered webhook receives what
   * it missed instead of never hearing about it.
   */
  private async redeliverMissed(): Promise<void> {
    const { repo } = this.deps;
    const pending = await repo.listUndelivered(MAX_DELIVERY_ROUNDS, REDELIVERY_BATCH);
    for (const anomaly of pending) {
      if (this.loop.stopped) return;
      await this.attemptDelivery(anomaly);
    }
  }

  private async attemptDelivery(anomaly: Anomaly): Promise<void> {
    const { repo, webhook } = this.deps;
    if (await webhook.deliver(anomaly)) await repo.markDelivered(anomaly.id);
    else await repo.incrementDeliveryAttempts(anomaly.id);
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

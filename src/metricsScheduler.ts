import { Clock } from "./clock";
import { MetricsRepo } from "./metrics";

/**
 * Computes and persists one metrics rollup per tick, independent of autopilot
 * arm/pause/abort — metrics (including the error rate) are meaningful whether
 * or not the fleet is currently armed. Each rollup covers [lastWindowEnd, now);
 * resuming from the last persisted rollup after a restart means no gap and no
 * double-counted window, the same restart-resumability the rest of this
 * service already has for ship_task.
 */
export class MetricsScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private windowStart: Date | null = null;
  // Tracks the currently in-flight tick so stop() can await it — otherwise a
  // tick already past the interval-guard check keeps running (and can still
  // write to the DB) after stop() returns, which raced a later test file's
  // TRUNCATE in practice (see meta#15's AnomalyScheduler for the same fix).
  private inFlight: Promise<void> | null = null;
  // Belt-and-suspenders alongside clearInterval/inFlight: a timer callback
  // already queued by the event loop when stop() runs can still invoke tick()
  // once more before clearInterval takes effect. Checked synchronously at the
  // very top of tick(), before any awaits, so that race can't slip a write in.
  private stopped = false;

  constructor(private repo: MetricsRepo, private clock: Clock, private intervalMs: number) {}

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
    }, this.intervalMs);
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
    const windowEnd = this.clock.now();
    if (this.windowStart === null) {
      this.windowStart = (await this.repo.latestWindowEnd()) ?? windowEnd;
    }
    if (windowEnd <= this.windowStart) return; // no time has elapsed yet

    await this.repo.computeAndSave(this.windowStart, windowEnd);
    this.windowStart = windowEnd;
  }
}

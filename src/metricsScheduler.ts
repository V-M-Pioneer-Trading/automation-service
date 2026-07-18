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

  constructor(private repo: MetricsRepo, private clock: Clock, private intervalMs: number) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch(() => {})
        .finally(() => {
          this.ticking = false;
        });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const windowEnd = this.clock.now();
    if (this.windowStart === null) {
      this.windowStart = (await this.repo.latestWindowEnd()) ?? windowEnd;
    }
    if (windowEnd <= this.windowStart) return; // no time has elapsed yet

    await this.repo.computeAndSave(this.windowStart, windowEnd);
    this.windowStart = windowEnd;
  }
}

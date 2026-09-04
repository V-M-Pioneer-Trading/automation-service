import { Clock } from "./clock";
import { IntervalLoop } from "./intervalLoop";
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
  private readonly loop: IntervalLoop;
  private windowStart: Date | null = null;

  constructor(private repo: MetricsRepo, private clock: Clock, intervalMs: number) {
    this.loop = new IntervalLoop(intervalMs, () => this.tick());
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  private async tick(): Promise<void> {
    const windowEnd = this.clock.now();
    if (this.windowStart === null) {
      this.windowStart = (await this.repo.latestWindowEnd()) ?? windowEnd;
    }
    if (windowEnd <= this.windowStart) return; // no time has elapsed yet
    if (this.loop.stopped) return; // stop() landed during the bootstrap read

    await this.repo.computeAndSave(this.windowStart, windowEnd);
    this.windowStart = windowEnd;
  }
}

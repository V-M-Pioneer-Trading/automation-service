/**
 * A background tick on a fixed interval, with the guarantees every scheduler
 * in this service needs and used to reimplement separately:
 *
 *  - **One tick at a time.** A tick awaits several HTTP calls and can outlast
 *    its interval; a timer firing mid-tick is dropped rather than racing the
 *    in-flight one on the same rows.
 *  - **`stop()` drains.** It resolves only once any in-flight tick has finished,
 *    so a caller (an abort, or a test about to truncate tables) knows nothing
 *    is still writing behind it.
 *  - **A stopped loop can be started again.** Stop then start is how an abort
 *    followed by a re-arm works; the stop flag is cleared on start rather than
 *    left set, which previously meant a re-armed scheduler never ticked again.
 *  - **`runOnce()` is deterministic.** Drains any in-flight tick, then runs
 *    exactly one to completion — for tests driving a fake clock, where a real
 *    tick spanning a clock jump would stamp a stale reading with a new time.
 */
export class IntervalLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopRequested = false;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
    private readonly onError: (err: unknown) => void | Promise<void> = () => {}
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`IntervalLoop needs a positive interval, got ${intervalMs}`);
    }
  }

  /**
   * True from `stop()` until the next `start()`. A long tick can poll this
   * between its awaits to avoid writing after it was told to stop.
   */
  get stopped(): boolean {
    return this.stopRequested;
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopRequested = false;
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    // Never keep the process alive on its own — the HTTP server does that.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight !== null) await this.inFlight;
  }

  async runOnce(): Promise<void> {
    if (this.inFlight !== null) await this.inFlight;
    await this.run();
  }

  private run(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (this.stopRequested) return Promise.resolve();
    this.inFlight = this.tick()
      // The error handler is usually an event-log write, which can itself
      // fail; that must not surface as an unhandled rejection.
      .catch((err) => Promise.resolve(this.onError(err)).catch(() => {}))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

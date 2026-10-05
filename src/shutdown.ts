/**
 * Graceful shutdown on SIGTERM/SIGINT (ECS sends SIGTERM on every deploy, then
 * SIGKILL after its stop timeout).
 *
 * Shutting down is **not** an abort: nothing here writes the autopilot state.
 * The persisted row stays as the operator left it, and the next boot restores
 * it under the restart rule (autopilotLifecycle.ts). What shutdown guarantees
 * is that every change already acknowledged is on disk, and that no tick is
 * half-way through a write when the pool goes away.
 */

/** The four steps, in the order they run. Each is awaited before the next starts. */
export interface ShutdownSteps {
  /** Refuse new lifecycle changes and wait for accepted ones to persist — first, so nothing can start a loop again. */
  closeLifecycle: () => Promise<void>;
  /** Stop every scheduler, awaiting its in-flight tick (the fleet loop also releases its dispatch lock). */
  stopSchedulers: () => Promise<void>;
  /** Stop accepting connections and wait for in-flight requests to finish. */
  closeServer: () => Promise<void>;
  /** Last: everything above may still be using it. */
  closePool: () => Promise<void>;
}

export type ShutdownOutcome = "clean" | "failed" | "timed-out";

export const SHUTDOWN_STEP_ORDER: readonly (keyof ShutdownSteps)[] = ["closeLifecycle", "stopSchedulers", "closeServer", "closePool"];

/**
 * Runs the steps in order, within `timeoutMs` overall. A step that throws is
 * logged and the rest still run — a failed scheduler stop must not leave the
 * pool open — but the outcome is then `failed`. A step that hangs is cut off by
 * the deadline (`timed-out`); the steps after it do not run, because the
 * process is about to exit and they would only race it.
 */
export async function shutdownGracefully(
  steps: ShutdownSteps,
  timeoutMs: number,
  log: (message: string, err?: unknown) => void = (message, err) => {
    if (err === undefined) console.log(message);
    else console.error(message, err);
  }
): Promise<ShutdownOutcome> {
  const failedSteps: string[] = [];
  const run = (async () => {
    for (const name of SHUTDOWN_STEP_ORDER) {
      try {
        await steps[name]();
      } catch (err) {
        failedSteps.push(name);
        log(`automation-service: shutdown step ${name} failed`, err);
      }
    }
  })();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => {
      resolve("timed-out");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([run.then(() => "done" as const), deadline]);
    if (result === "timed-out") {
      log(`automation-service: shutdown did not finish within ${String(timeoutMs)}ms`);
      return "timed-out";
    }
    return failedSteps.length > 0 ? "failed" : "clean";
  } finally {
    clearTimeout(timer);
  }
}

/** The bits of `process` the handler touches, so tests can pass a fake. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * Runs `shutdown` on the first SIGTERM or SIGINT and exits 0 if it was clean,
 * 1 otherwise. Later signals are ignored (`on`, not `once`, so a repeat does not
 * fall through to Node's default and kill the process mid-write): the deadline
 * already bounds the wait, and a second shutdown would close things twice.
 */
export function installShutdownHandlers(
  source: SignalSource,
  shutdown: () => Promise<ShutdownOutcome>,
  exit: (code: number) => void
): void {
  let started = false;
  const onSignal = (signal: NodeJS.Signals) => () => {
    if (started) return;
    started = true;
    console.log(`automation-service: ${signal} received, shutting down`);
    void shutdown()
      .catch(() => "failed" as const)
      .then((outcome) => {
        exit(outcome === "clean" ? 0 : 1);
      });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) source.on(signal, onSignal(signal));
}

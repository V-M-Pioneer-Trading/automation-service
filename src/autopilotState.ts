export type AutopilotStatus = "disarmed" | "armed" | "paused" | "aborted";
export type AutopilotMode = "live" | "shadow";

/** Status and mode together: what is persisted, and what a restart restores. */
export interface AutopilotSnapshot {
  status: AutopilotStatus;
  mode: AutopilotMode | null;
}

export class InvalidTransitionError extends Error {
  constructor(public action: string, public from: AutopilotStatus) {
    super(`Cannot ${action} while ${from}`);
  }
}

const PAUSE_ALLOWED_FROM: AutopilotStatus[] = ["armed"];
const ABORT_ALLOWED_FROM: AutopilotStatus[] = ["armed", "paused"];

/**
 * The autopilot lifecycle as this process currently believes it. Read
 * synchronously by every scheduler tick, so it stays an in-memory object; it
 * is persisted by `AutopilotLifecycle` (autopilotLifecycle.ts), which is the
 * only thing that changes it outside tests. A restart restores it from there,
 * downgraded to shadow (Q29) — see `restoredAfterRestart`.
 *
 * No credential is held here — st-gateway injects the game token itself
 * (auth-design.md decision 5) — so "armed" is purely a statement of intent.
 */
export class AutopilotState {
  private status: AutopilotStatus = "disarmed";
  // Set on arm, cleared on abort, unchanged by pause: mode is only meaningful
  // while the autopilot has been armed and not since aborted.
  private mode: AutopilotMode | null = null;

  getStatus(): AutopilotStatus {
    return this.status;
  }

  getMode(): AutopilotMode | null {
    return this.mode;
  }

  snapshot(): AutopilotSnapshot {
    return { status: this.status, mode: this.mode };
  }

  /** Replaces status and mode wholesale. Used to restore a persisted snapshot. */
  restore(snapshot: AutopilotSnapshot): void {
    this.status = snapshot.status;
    this.mode = snapshot.mode;
  }

  /** Arming (or re-arming, from any state) replaces the mode. Switching shadow<->live always goes through here. */
  arm(mode: AutopilotMode = "live"): void {
    this.mode = mode;
    this.status = "armed";
  }

  pause(): void {
    if (!PAUSE_ALLOWED_FROM.includes(this.status)) {
      throw new InvalidTransitionError("pause", this.status);
    }
    this.status = "paused";
  }

  abort(): void {
    if (!ABORT_ALLOWED_FROM.includes(this.status)) {
      throw new InvalidTransitionError("abort", this.status);
    }
    this.status = "aborted";
    this.mode = null;
  }
}

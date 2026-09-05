export type AutopilotStatus = "disarmed" | "armed" | "paused" | "aborted";
export type AutopilotMode = "live" | "shadow";

export class InvalidTransitionError extends Error {
  constructor(public action: string, public from: AutopilotStatus) {
    super(`Cannot ${action} while ${from}`);
  }
}

const PAUSE_ALLOWED_FROM: AutopilotStatus[] = ["armed"];
const ABORT_ALLOWED_FROM: AutopilotStatus[] = ["armed", "paused"];

/**
 * In-memory autopilot lifecycle. Deliberately not persisted: the spec requires
 * a restart to disarm, so status resets with the process and only the event
 * log survives. No credential is held here any more — st-gateway injects the
 * game token itself (auth-design.md decision 5) — so "armed" is purely a
 * statement of intent.
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

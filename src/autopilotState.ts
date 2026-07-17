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
 * a restart to disarm (the token it forwards downstream is memory-only), so
 * status resets with the process and only the event log survives.
 */
export class AutopilotState {
  private status: AutopilotStatus = "disarmed";
  private token: string | null = null;
  // Follows the token's lifecycle (set on arm, cleared on abort, unchanged by
  // pause) rather than status's — mode is only meaningful while a token is held.
  private mode: AutopilotMode | null = null;

  getStatus(): AutopilotStatus {
    return this.status;
  }

  getMode(): AutopilotMode | null {
    return this.mode;
  }

  /** Arming (or re-arming, from any state) replaces the held token and mode. Switching shadow<->live always goes through here. */
  arm(token: string, mode: AutopilotMode = "live"): void {
    this.token = token;
    this.mode = mode;
    this.status = "armed";
  }

  /** Current caller's Bearer token, for forwarding downstream. Never logged or persisted. */
  getToken(): string | null {
    return this.token;
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
    this.token = null;
    this.mode = null;
  }
}

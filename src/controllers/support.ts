/**
 * @file What the tsoa controllers share: where the app's collaborators live
 * (tsoa instantiates controllers itself, so they cannot take constructor
 * arguments), and the helpers the controllers and the inline routes both use.
 */

import type { Request } from "express";
import type { AutopilotLifecycle } from "../autopilotLifecycle";
import type { AutopilotState } from "../autopilotState";
import type { EventLog } from "../eventLog";
import type { ShipTaskRepo } from "../shipTaskRepo";

/** The error envelope every answer from this service uses. */
export interface ErrorBody {
  error: { message: string };
}

/** What the autopilot controller needs from the app (server.ts puts it in app.locals). */
export interface AutopilotDeps {
  state: AutopilotState;
  lifecycle: AutopilotLifecycle;
  events: EventLog;
  tasks: ShipTaskRepo;
}

export const AUTOPILOT_LOCAL = "autopilotDeps";

export const autopilotOf = (req: Request): AutopilotDeps => req.app.locals[AUTOPILOT_LOCAL] as AutopilotDeps;

/** A positive finite number from a query string, capped at `max`; anything else is `fallback`. */
export const clampLimit = (raw: unknown, fallback: number, max: number): number => {
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

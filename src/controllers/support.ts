/**
 * @file What the tsoa controllers share: where the app's collaborators live
 * (tsoa instantiates controllers itself, so they cannot take constructor
 * arguments), and the helpers they share.
 */

import type { Request } from "express";
import type { AutopilotLifecycle } from "../autopilotLifecycle";
import type { AutopilotState } from "../autopilotState";
import type { AnomalyRepo } from "../anomaly";
import type { Clock } from "../clock";
import type { EventLog } from "../eventLog";
import type { KnobRepo } from "../knobs";
import type { MetricsRepo } from "../metrics";
import type { ObservationRepo } from "../observations";
import type { FleetScheduler } from "../scheduler";
import type { ShipTaskRepo } from "../shipTaskRepo";

/** The error envelope every answer from this service uses. */
export interface ErrorBody {
  error: { message: string };
}

/**
 * How a controller answers a 4xx (meta#168): throw this, and `onError` (server.ts) sends
 * `{ error: { message } }` on `status`. The controller's return type then stays
 * the success body, and the 4xx is declared with `@Response<ErrorBody>`.
 * `message` is sent verbatim, so it must be safe for the caller to read.
 */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string
  ) {
    super(message);
  }
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

/** What the events controller needs from the app. */
export interface EventsDeps {
  events: EventLog;
}

export const EVENTS_LOCAL = "eventsDeps";

export const eventsOf = (req: Request): EventsDeps => req.app.locals[EVENTS_LOCAL] as EventsDeps;

/** What the planner controller needs. `scheduler` is null without mining config; the replan route is then not registered at all. */
export interface PlannerDeps {
  knobs: KnobRepo;
  events: EventLog;
  observations: ObservationRepo;
  scheduler: FleetScheduler | null;
}

export const PLANNER_LOCAL = "plannerDeps";

export const plannerOf = (req: Request): PlannerDeps => req.app.locals[PLANNER_LOCAL] as PlannerDeps;

/** What the observability controller needs. */
export interface ObservabilityDeps {
  metrics: MetricsRepo;
  anomalies: AnomalyRepo;
  events: EventLog;
  clock: Clock;
}

export const OBSERVABILITY_LOCAL = "observabilityDeps";

export const observabilityOf = (req: Request): ObservabilityDeps => req.app.locals[OBSERVABILITY_LOCAL] as ObservabilityDeps;

/** A positive finite number from a query string, capped at `max`; anything else is `fallback`. */
export const clampLimit = (raw: unknown, fallback: number, max: number): number => {
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

import { Controller, Extension, Get, Path, Post, Query, Request, Response, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { actorOf } from "@v-m-pioneer-trading/clerk-client";
import { SCOPE_FLEET_CONTROL } from "../auth";
import { InvalidTransitionError, type AutopilotMode, type AutopilotStatus } from "../autopilotState";
import type { EventLogEntry } from "../eventLog";
import type { ShipTask } from "../shipTaskRepo";
import { autopilotOf, clampLimit, type ErrorBody } from "./support";

export interface AutopilotSnapshot {
  status: AutopilotStatus;
  mode: AutopilotMode | null;
}

export interface EventsAnswer {
  events: EventLogEntry[];
}

export interface ShipTaskAnswer {
  task: ShipTask;
}

const MAX_EVENTS_LIMIT = 1000;

/**
 * The autopilot lifecycle. Reads are public (routePolicy in auth.ts: the
 * dashboard stays watchable while auth-service is down); arm, pause and abort
 * need `fleet:control`. Every change goes through the lifecycle, which
 * persists it and queues it behind the restore and behind any other change.
 *
 * Query and body are read here, not bound by tsoa: a typed binding would
 * answer its own 400 for input this service has always accepted (a repeated
 * `limit`, a non-object body).
 */
@Route("api/automation/v1/autopilot")
@Tags("autopilot")
export class AutopilotController extends Controller {
  /** Current status and mode. Waits for the restore of the persisted state, so a read never reports the "disarmed" a process starts with. */
  @Extension("x-auth", "public")
  @Get("status")
  public async status(@Request() req: ExpressRequest): Promise<AutopilotSnapshot> {
    const { lifecycle, state } = autopilotOf(req);
    // A failed restore leaves the process disarmed, and that is what it reports.
    await lifecycle.restored.catch(() => undefined);
    return { status: state.getStatus(), mode: state.getMode() };
  }

  /** Arms the autopilot. The body is `{ "mode": "live" | "shadow" }`, live when absent. */
  @Extension("x-auth", SCOPE_FLEET_CONTROL)
  @Post("arm")
  @Response<ErrorBody>(400, 'mode must be "live" or "shadow"')
  public async arm(@Request() req: ExpressRequest): Promise<AutopilotSnapshot | ErrorBody> {
    const mode: unknown = (req.body as { mode?: unknown } | undefined)?.mode ?? "live";
    if (mode !== "live" && mode !== "shadow") {
      this.setStatus(400);
      return { error: { message: 'mode must be "live" or "shadow"' } };
    }
    return await autopilotOf(req).lifecycle.arm(mode, actorOf(req.res as ExpressResponse));
  }

  /** Pauses an armed autopilot. */
  @Extension("x-auth", SCOPE_FLEET_CONTROL)
  @Post("pause")
  @Response<ErrorBody>(409, "not armed")
  public async pause(@Request() req: ExpressRequest): Promise<AutopilotSnapshot | ErrorBody> {
    return await this.transition(req, "pause");
  }

  /** Aborts an armed or paused autopilot. */
  @Extension("x-auth", SCOPE_FLEET_CONTROL)
  @Post("abort")
  @Response<ErrorBody>(409, "neither armed nor paused")
  public async abort(@Request() req: ExpressRequest): Promise<AutopilotSnapshot | ErrorBody> {
    return await this.transition(req, "abort");
  }

  /** The newest events, newest first. `limit` defaults to 100 and is capped at 1000; anything unusable is the default. */
  @Extension("x-auth", "public")
  @Get("events")
  public async events(@Request() req: ExpressRequest, @Query() limit?: unknown): Promise<EventsAnswer> {
    return { events: await autopilotOf(req).events.list(clampLimit(limit, 100, MAX_EVENTS_LIMIT)) };
  }

  /** The task a ship is on. Served only when the service has a fleet scheduler (mining configured). */
  @Extension("x-auth", "public")
  @Get("ships/{shipSymbol}")
  @Response<ErrorBody>(404, "no task for this ship yet")
  public async ship(@Request() req: ExpressRequest, @Path() shipSymbol: string): Promise<ShipTaskAnswer | ErrorBody> {
    const task = await autopilotOf(req).tasks.get(shipSymbol);
    if (task === null) {
      this.setStatus(404);
      return { error: { message: "no task for this ship yet" } };
    }
    return { task };
  }

  private async transition(req: ExpressRequest, action: "pause" | "abort"): Promise<AutopilotSnapshot | ErrorBody> {
    try {
      return await autopilotOf(req).lifecycle[action](actorOf(req.res as ExpressResponse));
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.setStatus(409);
        return { error: { message: err.message } };
      }
      throw err;
    }
  }
}

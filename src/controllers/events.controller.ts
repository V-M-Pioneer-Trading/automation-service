import { Controller, Extension, Post, Request, Response, Route, SuccessResponse, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { actorOf } from "@v-m-pioneer-trading/clerk-client";
import { SCOPE_EVENTS_WRITE } from "../auth";
import { eventsOf, type ErrorBody } from "./support";

export interface OkAnswer {
  ok: true;
}

/**
 * For an external supervisor (meta#19's ai-service) to log its own rationale
 * into the same audit trail everything else here uses. `type` is restricted
 * to the "ai_" namespace so an external caller can log its own decisions but
 * can never spoof a lifecycle/planner event type (e.g. "armed", "knob_changed")
 * that the rest of this service treats as authoritative.
 *
 * `events:write` only, from any kind of caller: `fleet:control` does not
 * satisfy it (decision 22). ai-service presents a Clerk M2M token minted by
 * auth-service (meta#59), like every other caller (decision 21).
 *
 * The body is read here, not bound by tsoa: a typed binding would answer its
 * own 400 where this service answers its own message (tsoa.json documents it).
 */
@Route("api/automation/v1")
@Tags("events")
export class EventsController extends Controller {
  /**
   * Appends an `ai_` audit event. `detail.actor` is stamped with the verified
   * `sub` and overrides anything the caller put there: the audit trail says who
   * wrote a row because the center said so, not because the row said so.
   */
  @Extension("x-auth", SCOPE_EVENTS_WRITE)
  @Post("events")
  @SuccessResponse(201, "Appended")
  @Response<ErrorBody>(400, 'type must be a string starting with "ai_"; detail must be an object')
  public async appendEvent(@Request() req: ExpressRequest): Promise<OkAnswer | ErrorBody> {
    const body = req.body as { type?: unknown; detail?: unknown } | undefined;
    const type: unknown = body?.type;
    const detail: unknown = body?.detail;
    if (typeof type !== "string" || !type.startsWith("ai_")) {
      this.setStatus(400);
      return { error: { message: 'type must be a string starting with "ai_"' } };
    }
    if (detail !== undefined && (typeof detail !== "object" || detail === null || Array.isArray(detail))) {
      this.setStatus(400);
      return { error: { message: "detail must be an object" } };
    }
    await eventsOf(req).events.append(type, { ...((detail as Record<string, unknown> | undefined) ?? {}), actor: actorOf(req.res as ExpressResponse) });
    this.setStatus(201);
    return { ok: true };
  }
}

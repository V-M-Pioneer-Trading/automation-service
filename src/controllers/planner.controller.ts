import { Controller, Extension, Get, Path, Post, Put, Query, Request, Response, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { actorOf, kindOf } from "@v-m-pioneer-trading/clerk-client";
import { SCOPE_PLANNER_ADVISE } from "../auth";
import { isKnobClass, KnobClassForbiddenError, KnobNotFoundError, KnobOutOfRangeError, type Knob, type KnobClass } from "../knobs";
import { priorsFromKnobs, type CalibratedModel } from "../observations";
import { plannerOf, type ErrorBody } from "./support";

export interface KnobsAnswer {
  knobs: Knob[];
}

export interface KnobAnswer {
  knob: Knob;
}

export interface ModelAnswer {
  model: CalibratedModel;
}

export interface ReplanAnswer {
  requested: true;
}

/**
 * Two kinds of caller may tune, and they are not trusted equally.
 *
 * Both need `planner:advise` (not `fleet:control`; decision 22). An operator may then write any class. A
 * machine (the AI supervisor, on its Clerk M2M token) may write `policy`
 * only: the class model is a fence around *it*, and a fence enforced only by
 * which knobs it is shown is not a fence: nothing stopped it naming
 * `anomaly.errorRateThreshold` and resolving "the error alarm fired" by
 * making the error alarm unable to fire.
 *
 * "Machine" is the center's `kind`, never the `sub` prefix and never which
 * header was sent. Only an explicit operator is unfenced, so a `kind` this
 * code does not know fails toward the narrower set.
 */
const machineWritableClasses: readonly KnobClass[] = ["policy"];

/**
 * Reads are public. Query and body are read here, not bound by tsoa: a typed
 * binding would answer its own 400 where this service answers its own message
 * (tsoa.json documents the bodies).
 */
@Route("api/automation/v1/planner")
@Tags("planner")
export class PlannerController extends Controller {
  /**
   * The tunable knobs. `?class=policy` is how the AI supervisor asks for exactly
   * the knobs it is allowed to write. Serving the filter here rather than
   * trusting the caller to filter means the restriction holds even if a client
   * forgets it.
   */
  @Extension("x-auth", "public")
  @Get("knobs")
  @Response<ErrorBody>(400, 'class must be "model", "policy" or "alert"')
  public async listKnobs(@Request() req: ExpressRequest, @Query("class") requested?: unknown): Promise<KnobsAnswer | ErrorBody> {
    const { knobs } = plannerOf(req);
    if (requested === undefined) return { knobs: await knobs.getAll() };
    if (!isKnobClass(requested)) {
      this.setStatus(400);
      return { error: { message: 'class must be "model", "policy" or "alert"' } };
    }
    return { knobs: await knobs.getByClass(requested) };
  }

  /** Sets one knob to a finite number. The body is `{ "value": number }`. A machine caller may write `policy` knobs only. */
  @Extension("x-auth", SCOPE_PLANNER_ADVISE)
  @Put("knobs/{name}")
  @Response<ErrorBody>(400, "value must be a finite number; out of range")
  @Response<ErrorBody>(403, "the caller's kind may not write this knob's class")
  @Response<ErrorBody>(404, "no such knob")
  public async setKnob(@Request() req: ExpressRequest, @Path() name: string): Promise<KnobAnswer | ErrorBody> {
    const value: unknown = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.setStatus(400);
      return { error: { message: "value must be a finite number" } };
    }
    const res = req.res as ExpressResponse;
    const { knobs, events, scheduler } = plannerOf(req);
    try {
      const { knob, previousValue } = await knobs.set(name, value, kindOf(res) === "operator" ? undefined : machineWritableClasses);
      await events.append("knob_changed", {
        name,
        previousValue,
        newValue: knob.value,
        // The caller's verified sub: `user_...` for an operator, `mch_...` for a machine.
        actor: actorOf(res),
      });
      scheduler?.requestReplan("knob_change");
      return { knob };
    } catch (err) {
      if (err instanceof KnobNotFoundError) return this.fail(404, err);
      if (err instanceof KnobOutOfRangeError) return this.fail(400, err);
      // 403, not 401: the credential is valid, it simply does not reach this class of knob. Re-authenticating would not help.
      if (err instanceof KnobClassForbiddenError) return this.fail(403, err);
      throw err;
    }
  }

  /**
   * What the planner currently believes about the universe, and whether each
   * belief was measured or assumed. The single most useful thing to look at
   * when a ship goes somewhere surprising.
   */
  @Extension("x-auth", "public")
  @Get("model")
  public async plannerModel(@Request() req: ExpressRequest): Promise<ModelAnswer> {
    const { observations, knobs } = plannerOf(req);
    return { model: await observations.calibrate(priorsFromKnobs(await knobs.getValues())) };
  }

  /** Asks the fleet scheduler to replan now. Served only when the service has a fleet scheduler (mining configured). */
  @Extension("x-auth", SCOPE_PLANNER_ADVISE)
  @Post("replan")
  public replan(@Request() req: ExpressRequest): ReplanAnswer {
    // Never null here: the route is not registered without a scheduler (server.ts).
    plannerOf(req).scheduler?.requestReplan("manual");
    return { requested: true };
  }

  private fail(status: number, err: Error): ErrorBody {
    this.setStatus(status);
    return { error: { message: err.message } };
  }
}

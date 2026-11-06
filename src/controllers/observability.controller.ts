import { Controller, Extension, Get, Query, Request, Route, Tags } from "@tsoa/runtime";
import type { Request as ExpressRequest } from "express";
import type { Anomaly } from "../anomaly";
import type { EventLogEntry } from "../eventLog";
import type { MetricsRollup } from "../metrics";
import { clampLimit, observabilityOf } from "./support";

export interface MetricsContextAnswer {
  rollups: MetricsRollup[];
  events: EventLogEntry[];
}

export interface AnomalyDigestAnswer {
  anomalies: Anomaly[];
  events: EventLogEntry[];
}

const MAX_ROLLUPS_LIMIT = 200;
const DEFAULT_CONTEXT_ROLLUP_LIMIT = 10;
const DEFAULT_CONTEXT_EVENT_LIMIT = 20;
const MAX_CONTEXT_EVENT_LIMIT = 100;
const MAX_ANOMALIES_LIMIT = 200;
const DEFAULT_DIGEST_ANOMALY_LIMIT = 50;
const DEFAULT_DIGEST_EVENT_LIMIT = 50;
const DEFAULT_DIGEST_WINDOW_MINUTES = 60;
const MAX_DIGEST_WINDOW_MINUTES = 7 * 24 * 60;

/**
 * Event types worth surfacing in the digest alongside anomalies.
 *
 * The digest is two audiences at once: an operator's hourly review, and the AI
 * supervisor's context on its next run. The test for inclusion is therefore not
 * "is this an error" but **"would someone be wrong about the fleet without it,
 * and does nothing else tell them?"** Routine per-tick events stay out; the
 * anomaly checks already summarize those, and diluting a bounded list is how a
 * digest stops being read.
 *
 * The failure mode this list keeps having is the one the audit kept finding
 * elsewhere: the record gets written, and the page nobody built never shows it.
 * `contract_discovery_error` is the cautionary tale: decision 19's production
 * outage, the entire autonomous loop down, was eventually found by grepping the
 * raw event log for exactly this type, because the digest filtered it out.
 */
const NOTABLE_EVENT_TYPES = [
  // Lifecycle: what the operator last said they wanted.
  "armed",
  "paused",
  "aborted",

  // Terminal task outcomes: a ship gave up, or had nowhere to go.
  "planner_no_viable_target",
  "mining_task_failed",
  "mining_no_market_found",
  "mining_discarded_after_abort",
  "planner_discarded_after_abort_or_pause",

  // Failures that silently degrade something rather than stopping it, which is
  // exactly why they need surfacing: nothing else reports them, and the fleet
  // keeps running while quietly getting worse at its job.
  //   contract_discovery_error: the contract loop is down; mining continues,
  //     so credits/hour sags rather than flatlining.
  //   observation_write_error: calibration stopped recording. The planner
  //     goes on scoring against the last values it measured, so it looks
  //     confident while drifting away from reality.
  "contract_discovery_error",
  "observation_write_error",

  // An operational condition, not a failure: another replica holds the dispatch
  // lock and this process is standing by. Logged once per spell, not per tick.
  // Two instances contending is something an operator should learn from the
  // digest rather than from a ship that mysteriously never moves.
  "dispatch_standby",

  // Configuration changes, which are the most consequential thing that can
  // happen without any ship doing anything.
  //   knob_changed: who retuned what. The supervisor may write policy knobs,
  //     so this is also how its next run sees its own prior tuning.
  //   knob_clamped: a deploy silently pulled a tuned value back inside new
  //     bounds. The audit added this event precisely so that stops being
  //     invisible; leaving it out of the digest left the fix half-finished.
  "knob_changed",
  "knob_clamped",

  // meta#19's ai-service supervisor logs these via POST /events, included
  // here so both the digest (an operator's hourly review) and the
  // supervisor's own next run (which reads this same digest for context)
  // see prior AI actions, not just command-interface's unfiltered Event Feed.
  "ai_intervention",
  "ai_no_action",
];

/**
 * Metrics and anomaly reads, all public (routePolicy in auth.ts). Each is
 * registered only when its scheduler is configured; otherwise the request falls
 * through to notFound(). Query values are read as `unknown`: a typed binding
 * would answer tsoa's own 400 where this service clamps or defaults.
 */
@Route("api/automation/v1")
@Tags("observability")
export class ObservabilityController extends Controller {
  /** Recent metric rollups and events, as context for the AI supervisor. `rollupLimit` (default 10, max 200) and `eventLimit` (default 20, max 100); anything unusable is the default. */
  @Extension("x-auth", "public")
  @Get("metrics/context")
  public async metricsContext(
    @Request() req: ExpressRequest,
    @Query() rollupLimit?: unknown,
    @Query() eventLimit?: unknown
  ): Promise<MetricsContextAnswer> {
    const { metrics, events } = observabilityOf(req);
    const [rollups, recentEvents] = await Promise.all([
      metrics.list(clampLimit(rollupLimit, DEFAULT_CONTEXT_ROLLUP_LIMIT, MAX_ROLLUPS_LIMIT)),
      events.list(clampLimit(eventLimit, DEFAULT_CONTEXT_EVENT_LIMIT, MAX_CONTEXT_EVENT_LIMIT)),
    ]);
    return { rollups, events: recentEvents };
  }

  /** Anomalies and notable events inside a window. `windowMinutes` (default 60, max 10080), `anomalyLimit` (default 50, max 200), `eventLimit` (default 50, max 100); anything unusable is the default. */
  @Extension("x-auth", "public")
  @Get("anomalies/digest")
  public async anomaliesDigest(
    @Request() req: ExpressRequest,
    @Query() windowMinutes?: unknown,
    @Query() anomalyLimit?: unknown,
    @Query() eventLimit?: unknown
  ): Promise<AnomalyDigestAnswer> {
    const { anomalies, events, clock } = observabilityOf(req);
    const window = clampLimit(windowMinutes, DEFAULT_DIGEST_WINDOW_MINUTES, MAX_DIGEST_WINDOW_MINUTES);
    const since = new Date(clock.now().getTime() - window * 60_000);
    const [found, notableEvents] = await Promise.all([
      anomalies.listSince(since, clampLimit(anomalyLimit, DEFAULT_DIGEST_ANOMALY_LIMIT, MAX_ANOMALIES_LIMIT)),
      events.listSince(since, clampLimit(eventLimit, DEFAULT_DIGEST_EVENT_LIMIT, MAX_CONTEXT_EVENT_LIMIT), NOTABLE_EVENT_TYPES),
    ]);
    return { anomalies: found, events: notableEvents };
  }
}

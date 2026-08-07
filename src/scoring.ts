/**
 * The autopilot's entire decision model, as pure functions.
 *
 * Everything the planner chooses between — mine here, work that contract, go
 * refresh that market's prices — is reduced to one number: **expected credits
 * per hour**. Highest number wins. These functions are the only place that
 * number is computed.
 *
 * They are deliberately pure (no I/O, no clock, no database) for three reasons:
 *
 *  1. They are the part most worth unit-testing directly.
 *  2. `replay.ts` re-runs them over historical `planner_assignment` events to
 *     answer "what would the fleet have done with different knobs?" — which
 *     only works because scoring never touches the network.
 *  3. Reading them end to end takes a minute, which is the honest way to
 *     understand what the autopilot actually optimizes for.
 */

/** Hours one round trip to a target and back takes, plus fixed on-station time. */
export function cycleHours(params: {
  /** Total distance flown in one cycle, in waypoint coordinate units. */
  distance: number;
  /** Units of distance covered per hour. Calibrated from observed flights. */
  speedUnitsPerHour: number;
  /** Survey + extract + cooldown + dock + sell time that doesn't scale with distance. */
  overheadHours: number;
}): number {
  const { distance, speedUnitsPerHour, overheadHours } = params;
  if (speedUnitsPerHour <= 0) return Infinity;
  return distance / speedUnitsPerHour + overheadHours;
}

/** Credits per hour, guarding the degenerate zero/negative-duration case. */
export function creditsPerHour(credits: number, hours: number): number {
  return hours > 0 && Number.isFinite(hours) ? credits / hours : 0;
}

export interface MiningScoreInput {
  /** Round-trip distance: out to the field and back to a market. */
  roundTripDistance: number;
  /**
   * What one full mine-and-sell cycle at THIS field is worth. Measured from
   * completed cycles at this field where we have them; a fleet-wide average or
   * the cold-start prior otherwise. This is the term that makes one field score
   * differently from another — without it, scoring collapses to "nearest field".
   */
  creditsPerCycle: number;
  /** Policy multiplier: how much the operator favors mining over other work. */
  taskWeight: number;
  speedUnitsPerHour: number;
  overheadHours: number;
}

export function miningScore(input: MiningScoreInput): { cycleHours: number; score: number } {
  const hours = cycleHours({
    distance: input.roundTripDistance,
    speedUnitsPerHour: input.speedUnitsPerHour,
    overheadHours: input.overheadHours,
  });
  return { cycleHours: hours, score: creditsPerHour(input.creditsPerCycle * input.taskWeight, hours) };
}

export interface ContractScoreInput {
  /** Payment minus procurement minus travel, frozen when the contract was evaluated. */
  expectedProfit: number;
  /** Also frozen at evaluation time — the contract's route doesn't change once accepted. */
  cycleHours: number;
  taskWeight: number;
}

export function contractScore(input: ContractScoreInput): number {
  return creditsPerHour(input.expectedProfit * input.taskWeight, input.cycleHours);
}

export interface ScoutScoreInput {
  /** One-way distance to the market. Scouting doesn't require coming back. */
  distance: number;
  /** Hours since this market's prices were last refreshed. */
  elapsedHours: number;
  /** Staleness at which a refresh is worth its full `creditsPerRefresh`. */
  stalenessThresholdHours: number;
  /**
   * What refreshing one market's prices is worth in credits. Unlike mining
   * revenue this can't be measured directly — it's the cost of the bad
   * decisions stale prices cause, which we never observe because we never see
   * the trade we didn't make. It is therefore a pure policy judgment, and the
   * only scouting knob (see `KNOB_DEFINITIONS`).
   */
  creditsPerRefresh: number;
  speedUnitsPerHour: number;
  overheadHours: number;
}

/**
 * Staleness grows linearly and without bound: a market unseen for twice the
 * threshold is worth twice as much to visit. That's what makes the planner
 * rotate through markets on its own — refreshing one drops its score to zero,
 * so the next-stalest naturally becomes the best scouting candidate. No
 * explicit cooldown or round-robin needed.
 */
export function scoutScore(input: ScoutScoreInput): { cycleHours: number; stalenessFactor: number; score: number } {
  const hours = cycleHours({
    distance: input.distance,
    speedUnitsPerHour: input.speedUnitsPerHour,
    overheadHours: input.overheadHours,
  });
  const stalenessFactor = input.stalenessThresholdHours > 0 ? input.elapsedHours / input.stalenessThresholdHours : 0;
  return {
    cycleHours: hours,
    stalenessFactor,
    score: creditsPerHour(input.creditsPerRefresh * stalenessFactor, hours),
  };
}

/**
 * Would taking on this work drop the agent below its cash floor? Applied before
 * scoring matters at all: a candidate that breaches the floor is not scored
 * against, it's removed. Running out of credits with no fuel money is the
 * classic SpaceTraders death spiral, and it is not recoverable in-game.
 */
export function breachesReserveFloor(params: {
  currentCredits: number;
  estimatedCost: number;
  reserveFloor: number;
}): boolean {
  return params.currentCredits - params.estimatedCost < params.reserveFloor;
}

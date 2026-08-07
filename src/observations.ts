import { Pool, PoolClient } from "pg";
import { Clock } from "./clock";

/**
 * What the fleet has actually learned by flying.
 *
 * The planner needs four numbers to score anything: how much a mining cycle
 * earns, how fast ships fly, how long the non-flying part of a cycle takes, and
 * what fuel costs. Every one of them is a fact about the universe, and every
 * one of them was originally a hand-typed constant — which meant the planner's
 * "expected credits per hour" was arithmetic on guesses, and mining scores
 * differed between asteroid fields only by distance.
 *
 * This module closes that loop. Completed work is recorded as observations;
 * `calibrate()` turns them into the numbers the planner scores with. The
 * matching `*Prior` knobs still exist, but only as the answer for a fleet that
 * hasn't flown yet.
 *
 * **Recency weighting**: observations decay with a half-life
 * (`observation.halfLifeHours`), so a market that got better last hour outweighs
 * how it behaved yesterday, without any single flight swinging the estimate.
 */

/** Observations older than this are not even fetched — they carry no meaningful weight. */
const MAX_OBSERVATION_AGE_HOURS = 24 * 14;
/** Cap on rows pulled per calibration, so a long-running fleet doesn't grow this query without bound. */
const MAX_OBSERVATIONS = 500;

export interface MiningObservation {
  asteroidWaypoint: string;
  revenue: number;
  cycleHours: number;
  travelDistance: number;
  unitsExtracted: number;
  observedAt: Date;
}

/**
 * Something learned by moving a ship. A completed flight contributes distance
 * and duration; a refuel contributes distance and price. One row carries
 * whichever it saw, so each field is independently nullable.
 */
export interface TravelObservation {
  distance: number;
  /** Real departure-to-arrival duration. Null on a refuel-only observation. */
  hours: number | null;
  /** Credits paid to refuel after covering `distance`. Null on a flight-only observation. */
  fuelCredits: number | null;
  observedAt: Date;
}

/**
 * The calibrated model the planner scores with. Every field carries its own
 * provenance so a `planner_assignment` event records not just what was
 * believed, but whether it was measured or assumed — which is the difference
 * between a decision you can defend and one you can only explain.
 */
export interface CalibratedModel {
  creditsPerCycleByWaypoint: Record<string, number>;
  /** Used for fields never mined before: the fleet-wide average, or the prior. */
  fleetCreditsPerCycle: number;
  speedUnitsPerHour: number;
  overheadHours: number;
  fuelCreditsPerUnitDistance: number;
  provenance: {
    creditsPerCycle: Provenance;
    speed: Provenance;
    overhead: Provenance;
    fuel: Provenance;
    miningSampleCount: number;
    flightSampleCount: number;
    refuelSampleCount: number;
    /** Fields with enough history to be scored on their own measured revenue, not the fleet average. */
    waypointsWithOwnAverage: string[];
  };
}

export type Provenance = "measured" | "prior";

export class ObservationRepo {
  constructor(private pool: Pool | PoolClient, private clock: Clock) {}

  /** Records one completed mine-and-sell cycle. Called when `mining_cycle_complete` fires. */
  async recordMiningCycle(params: {
    shipSymbol: string;
    asteroidWaypoint: string;
    revenue: number;
    cycleHours: number;
    travelDistance: number;
    unitsExtracted: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO mining_observation
         (ship_symbol, asteroid_waypoint, observed_at, revenue, cycle_hours, travel_distance, units_extracted)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.shipSymbol,
        params.asteroidWaypoint,
        this.clock.now(),
        params.revenue,
        params.cycleHours,
        params.travelDistance,
        params.unitsExtracted,
      ]
    );
  }

  /**
   * Records one real flight: how far, how long. Taken from the ship's own nav
   * route (origin and destination coordinates, departure and arrival times), so
   * it's the game's own timing rather than anything we estimated.
   */
  async recordTravel(params: { distance: number; hours?: number | null; fuelCredits?: number | null }): Promise<void> {
    await this.pool.query(
      `INSERT INTO travel_observation (observed_at, distance, hours, fuel_credits) VALUES ($1, $2, $3, $4)`,
      [this.clock.now(), params.distance, params.hours ?? null, params.fuelCredits ?? null]
    );
  }

  async recentMining(since: Date, limit = MAX_OBSERVATIONS): Promise<MiningObservation[]> {
    const { rows } = await this.pool.query(
      `SELECT asteroid_waypoint, revenue, cycle_hours, travel_distance, units_extracted, observed_at
       FROM mining_observation WHERE observed_at >= $1 ORDER BY observed_at DESC LIMIT $2`,
      [since, limit]
    );
    return rows.map((r: Record<string, unknown>) => ({
      asteroidWaypoint: r.asteroid_waypoint as string,
      revenue: Number(r.revenue),
      cycleHours: Number(r.cycle_hours),
      travelDistance: Number(r.travel_distance),
      unitsExtracted: Number(r.units_extracted),
      observedAt: r.observed_at as Date,
    }));
  }

  async recentTravel(since: Date, limit = MAX_OBSERVATIONS): Promise<TravelObservation[]> {
    const { rows } = await this.pool.query(
      `SELECT distance, hours, fuel_credits, observed_at
       FROM travel_observation WHERE observed_at >= $1 ORDER BY observed_at DESC LIMIT $2`,
      [since, limit]
    );
    return rows.map((r: Record<string, unknown>) => ({
      distance: Number(r.distance),
      hours: r.hours === null ? null : Number(r.hours),
      fuelCredits: r.fuel_credits === null ? null : Number(r.fuel_credits),
      observedAt: r.observed_at as Date,
    }));
  }

  /**
   * Turns observations into the numbers the planner scores with, falling back
   * to the `*Prior` knobs wherever nothing has been observed yet. Never throws
   * on missing data — a fleet on its first tick calibrates to exactly the
   * priors, which is the old behavior, so there is no cold-start cliff.
   */
  async calibrate(priors: {
    creditsPerCyclePrior: number;
    speedUnitsPerHourPrior: number;
    overheadHoursPrior: number;
    fuelCreditsPerUnitDistancePrior: number;
    halfLifeHours: number;
  }): Promise<CalibratedModel> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - MAX_OBSERVATION_AGE_HOURS * 3_600_000);
    const [mining, travel] = await Promise.all([this.recentMining(since), this.recentTravel(since)]);

    const weightOf = (observedAt: Date): number => decayWeight(now, observedAt, priors.halfLifeHours);

    // --- Speed: total distance flown over total time flown, recency-weighted ---
    const speed = weightedRatio(
      travel
        .filter((t) => t.hours !== null)
        .map((t) => ({ numerator: t.distance, denominator: t.hours as number, weight: weightOf(t.observedAt) }))
    );
    const speedUnitsPerHour = speed ?? priors.speedUnitsPerHourPrior;

    // --- Fuel: credits per unit of distance covered, from real refuel purchases ---
    const fuelSamples = travel.filter((t) => t.fuelCredits !== null && t.distance > 0);
    const fuel = weightedRatio(
      fuelSamples.map((t) => ({
        numerator: t.fuelCredits as number,
        denominator: t.distance,
        weight: weightOf(t.observedAt),
      }))
    );
    const fuelCreditsPerUnitDistance = fuel ?? priors.fuelCreditsPerUnitDistancePrior;

    // --- Overhead: measured cycle time minus the travel that cycle implies ---
    // Deriving it (rather than timing survey/extract/sell separately) keeps the
    // model self-consistent: cycleHours = distance/speed + overhead is exactly
    // the equation the planner scores with, so calibrating its residual means
    // predicted cycle time matches observed cycle time by construction.
    const overheadSamples = mining
      .map((m) => ({
        value: m.cycleHours - m.travelDistance / speedUnitsPerHour,
        weight: weightOf(m.observedAt),
      }))
      // A negative residual means the cycle finished faster than its travel
      // alone should allow — bad data (a clock jump, a resumed transit counted
      // twice). Clamping at zero rather than dropping it keeps a genuinely
      // fast cycle in the sample instead of biasing the average upward.
      .map((s) => ({ ...s, value: Math.max(0, s.value) }));
    const overhead = weightedMean(overheadSamples);
    const overheadHours = overhead ?? priors.overheadHoursPrior;

    // --- Revenue per cycle: per field where we've mined it, fleet-wide otherwise ---
    const fleetRevenue = weightedMean(mining.map((m) => ({ value: m.revenue, weight: weightOf(m.observedAt) })));
    const fleetCreditsPerCycle = fleetRevenue ?? priors.creditsPerCyclePrior;

    const byWaypoint: Record<string, number> = {};
    const grouped = new Map<string, { value: number; weight: number }[]>();
    for (const m of mining) {
      const bucket = grouped.get(m.asteroidWaypoint) ?? [];
      bucket.push({ value: m.revenue, weight: weightOf(m.observedAt) });
      grouped.set(m.asteroidWaypoint, bucket);
    }
    for (const [waypoint, samples] of grouped) {
      const mean = weightedMean(samples);
      if (mean !== null) byWaypoint[waypoint] = mean;
    }

    return {
      creditsPerCycleByWaypoint: byWaypoint,
      fleetCreditsPerCycle,
      speedUnitsPerHour,
      overheadHours,
      fuelCreditsPerUnitDistance,
      provenance: {
        creditsPerCycle: fleetRevenue === null ? "prior" : "measured",
        speed: speed === null ? "prior" : "measured",
        overhead: overhead === null ? "prior" : "measured",
        fuel: fuel === null ? "prior" : "measured",
        miningSampleCount: mining.length,
        flightSampleCount: travel.filter((t) => t.hours !== null).length,
        refuelSampleCount: fuelSamples.length,
        waypointsWithOwnAverage: Object.keys(byWaypoint).sort(),
      },
    };
  }
}

/** Half-life decay: an observation `halfLifeHours` old counts half as much as a fresh one. */
export function decayWeight(now: Date, observedAt: Date, halfLifeHours: number): number {
  if (halfLifeHours <= 0) return 1;
  const ageHours = Math.max(0, (now.getTime() - observedAt.getTime()) / 3_600_000);
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/** Weighted mean, or null when there's nothing meaningful to average. */
export function weightedMean(samples: { value: number; weight: number }[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const s of samples) {
    if (!Number.isFinite(s.value) || !Number.isFinite(s.weight) || s.weight <= 0) continue;
    weighted += s.value * s.weight;
    total += s.weight;
  }
  return total > 0 ? weighted / total : null;
}

/**
 * Weighted ratio of summed numerators to summed denominators — the right shape
 * for rates. Averaging each flight's own speed would let one very short hop
 * count as much as a long haul; summing distance over summed time weights each
 * flight by how much evidence it actually carries.
 */
export function weightedRatio(
  samples: { numerator: number; denominator: number; weight: number }[]
): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const s of samples) {
    if (!Number.isFinite(s.numerator) || !Number.isFinite(s.denominator) || s.denominator <= 0) continue;
    if (!Number.isFinite(s.weight) || s.weight <= 0) continue;
    numerator += s.numerator * s.weight;
    denominator += s.denominator * s.weight;
  }
  return denominator > 0 && numerator > 0 ? numerator / denominator : null;
}

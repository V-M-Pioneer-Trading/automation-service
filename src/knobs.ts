import { Pool } from "pg";

export interface KnobDefinition {
  name: string;
  default: number;
  min: number;
  max: number;
  description: string;
}

/**
 * The planner's tunable weights and thresholds (meta#10 v1). Bounds live in the
 * `knob` table itself (seeded from here) so a write is validated against schema
 * data, not a hardcoded switch statement.
 */
export const KNOB_DEFINITIONS: KnobDefinition[] = [
  {
    name: "mine.taskWeight",
    default: 1,
    min: 0,
    max: 10,
    description: "Multiplier applied to every mining-task score.",
  },
  {
    name: "mine.expectedCreditsPerCycle",
    default: 5000,
    min: 0,
    max: 1_000_000,
    description:
      "Estimated sale revenue for one full mine-sell cycle. v1 simplification: a flat " +
      "estimate, not yet derived from real per-good yield/market data.",
  },
  {
    name: "travel.speedUnitsPerHour",
    default: 30,
    min: 1,
    max: 1000,
    description: "Assumed ship speed used to convert route distance into travel time.",
  },
  {
    name: "cycle.fixedOverheadHours",
    default: 0.3,
    min: 0,
    max: 5,
    description: "Fixed survey + extract + cooldown + sell time assumed per cycle.",
  },
  {
    name: "fuel.creditsPerUnitDistance",
    default: 5,
    min: 0,
    max: 1000,
    description: "Assumed credits cost per unit of travel distance, for reserve-floor checks.",
  },
  {
    name: "credit.reserveFloor",
    default: 0,
    min: 0,
    max: 100_000_000,
    description: "The planner will never make an assignment that would drop credits below this.",
  },
  {
    name: "mine.failureRetryLimit",
    default: 3,
    min: 1,
    max: 20,
    description: "Consecutive tick failures on one target before the planner reassigns it away.",
  },
  {
    name: "anomaly.shipIdleMinutes",
    default: 10,
    min: 1,
    max: 1440,
    description: "Minutes a ship's task can go without a phase change (while armed and live) before an idle anomaly fires.",
  },
  {
    name: "anomaly.profitDropFraction",
    default: 0.5,
    min: 0,
    max: 1,
    description: "Fleet profit/hour anomaly fires when the latest rollup drops below this fraction of the trailing 6h average.",
  },
  {
    name: "anomaly.consecutiveFailureLimit",
    default: 3,
    min: 1,
    max: 20,
    description: "Consecutive tick failures on one ship that raise an anomaly (independent of the planner's own reassignment knob).",
  },
  {
    name: "anomaly.errorRateThreshold",
    default: 0.1,
    min: 0,
    max: 1,
    description: "Fraction of mining_* events that must be errors within the error-rate window before an anomaly fires.",
  },
  {
    name: "anomaly.errorRateWindowMinutes",
    default: 5,
    min: 1,
    max: 1440,
    description: "Trailing window over which the SpaceTraders error rate is computed.",
  },
  {
    name: "anomaly.creditsFlatWindowHours",
    default: 2,
    min: 0.25,
    max: 48,
    description: "Hours over which agent credits must show no net increase before a credits-flat anomaly fires.",
  },
  {
    name: "anomaly.marketStalenessMinutes",
    default: 30,
    min: 5,
    max: 1440,
    description: "Minutes since a market in active use was last priced before its intel is flagged stale.",
  },
  {
    name: "anomaly.dedupeCooldownMinutes",
    default: 15,
    min: 1,
    max: 1440,
    description: "Minutes an already-fired anomaly (by dedupe key) is suppressed from re-firing.",
  },
  {
    name: "contract.taskWeight",
    default: 1,
    min: 0,
    max: 10,
    description: "Multiplier applied to every contract-task score, in the same units as mine.taskWeight.",
  },
  {
    name: "contract.minProfitThreshold",
    default: 0,
    min: -1_000_000,
    max: 1_000_000,
    description: "A contract is only accepted if its deterministic expected profit exceeds this.",
  },
];

export interface Knob {
  name: string;
  value: number;
  default: number;
  min: number;
  max: number;
}

export class KnobNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown knob "${name}"`);
  }
}

export class KnobOutOfRangeError extends Error {
  constructor(name: string, value: number, min: number, max: number) {
    super(`${name} must be between ${min} and ${max}, got ${value}`);
  }
}

export class KnobRepo {
  constructor(private pool: Pool) {}

  async getAll(): Promise<Knob[]> {
    const { rows } = await this.pool.query(
      "SELECT name, value, default_value, min_value, max_value FROM knob ORDER BY name"
    );
    return rows.map(rowToKnob);
  }

  async get(name: string): Promise<number> {
    const { rows } = await this.pool.query("SELECT value FROM knob WHERE name = $1", [name]);
    if (rows.length === 0) throw new KnobNotFoundError(name);
    return Number(rows[0].value);
  }

  async set(name: string, value: number): Promise<Knob> {
    const { rows } = await this.pool.query(
      "SELECT name, value, default_value, min_value, max_value FROM knob WHERE name = $1",
      [name]
    );
    if (rows.length === 0) throw new KnobNotFoundError(name);
    const knob = rowToKnob(rows[0]);
    if (value < knob.min || value > knob.max) {
      throw new KnobOutOfRangeError(name, value, knob.min, knob.max);
    }
    await this.pool.query("UPDATE knob SET value = $2 WHERE name = $1", [name, value]);
    return { ...knob, value };
  }
}

function rowToKnob(row: {
  name: string;
  value: string | number;
  default_value: string | number;
  min_value: string | number;
  max_value: string | number;
}): Knob {
  return {
    name: row.name,
    value: Number(row.value),
    default: Number(row.default_value),
    min: Number(row.min_value),
    max: Number(row.max_value),
  };
}

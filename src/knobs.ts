import { Pool } from "pg";

/**
 * Which kind of number a knob holds. This distinction is the reason knobs are
 * trustworthy at all, so it's worth stating plainly:
 *
 * - **`model`** — a claim about how the universe behaves ("ships fly 30 units
 *   an hour", "a mining cycle nets 5000 credits"). These are *facts to be
 *   measured*, not preferences. The autopilot calibrates them from its own
 *   observations (see `observations.ts`); the stored value is only a cold-start
 *   prior for before there's data. Editing one doesn't change reality — it
 *   changes what the planner *believes* about reality, which is how you get a
 *   fleet confidently flying to the wrong asteroid. Operators can still write
 *   them (useful for testing a hypothesis); the AI supervisor cannot.
 *
 * - **`policy`** — a preference with no true value ("favor contracts over
 *   mining", "never drop below 50k credits"). Nothing can measure these; they
 *   encode what the operator wants. This is the only class the AI supervisor
 *   may write, and it's a complete set of levers for the trade-offs it's asked
 *   to manage.
 *
 * - **`alert`** — the thresholds that decide when something is wrong. Held
 *   deliberately out of the AI's reach: an agent that can widen its own alarm
 *   thresholds will eventually resolve "profit dropped" by deciding profit
 *   drops are fine. Only an operator moves these.
 */
export type KnobClass = "model" | "policy" | "alert";

export interface KnobDefinition {
  name: string;
  class: KnobClass;
  default: number;
  min: number;
  max: number;
  description: string;
}

/**
 * Every tunable number in the autopilot, with its bounds. Bounds live in the
 * `knob` table (seeded and re-synced from here on boot) so a write is validated
 * against schema data rather than a hardcoded switch statement.
 *
 * Adding a knob here is enough to create it; removing one here deletes it on
 * the next boot, so this list is always the complete and current set.
 */
export const KNOB_DEFINITIONS: KnobDefinition[] = [
  // --- Model: measured from observation, these values are only cold-start priors ---
  {
    name: "mine.creditsPerCyclePrior",
    class: "model",
    default: 5000,
    min: 0,
    max: 1_000_000,
    description:
      "Assumed revenue of one mine-and-sell cycle before any cycle has actually been observed. " +
      "Once cycles complete, per-field measured averages replace this — it only governs a cold fleet.",
  },
  {
    name: "travel.speedUnitsPerHourPrior",
    class: "model",
    default: 30,
    min: 1,
    max: 1000,
    description:
      "Assumed ship speed (distance units per hour) before any flight has been timed. " +
      "Replaced by the measured average of real departure-to-arrival flights once available.",
  },
  {
    name: "cycle.overheadHoursPrior",
    class: "model",
    default: 0.3,
    min: 0,
    max: 5,
    description:
      "Assumed non-travel time per cycle (survey + extract + cooldown + dock + sell) before any " +
      "cycle has been observed. Replaced by measured cycle time minus measured travel time.",
  },
  {
    name: "fuel.creditsPerUnitDistancePrior",
    class: "model",
    default: 5,
    min: 0,
    max: 1000,
    description:
      "Assumed credits of fuel burned per unit of distance, used for reserve-floor safety checks. " +
      "Replaced by the measured average of real refuel purchases once available.",
  },
  {
    name: "observation.halfLifeHours",
    class: "model",
    default: 6,
    min: 0.25,
    max: 720,
    description:
      "How fast old observations stop counting. An observation this many hours old carries half the " +
      "weight of a fresh one. Lower = adapts faster to a changing market, but noisier.",
  },

  // --- Policy: preferences with no measurable "true" value ---
  {
    name: "mine.taskWeight",
    class: "policy",
    default: 1,
    min: 0,
    max: 10,
    description: "How much to favor mining. Multiplies every mining score; 0 disables mining entirely.",
  },
  {
    name: "contract.taskWeight",
    class: "policy",
    default: 1,
    min: 0,
    max: 10,
    description: "How much to favor contracts, in the same units as mine.taskWeight. 0 disables contract work.",
  },
  {
    name: "contract.minProfitThreshold",
    class: "policy",
    default: 0,
    min: -1_000_000,
    max: 1_000_000,
    description: "A contract is only accepted if its expected profit exceeds this. Raise it to be pickier.",
  },
  {
    name: "scout.creditsPerRefresh",
    class: "policy",
    default: 500,
    min: 0,
    max: 1_000_000,
    description:
      "What refreshing one market's prices is worth. Unlike mining revenue this can't be measured — it's " +
      "the cost of decisions made on stale prices, which we never see. Also doubles as scouting's on/off " +
      "switch and its task weight: 0 disables scouting.",
  },
  {
    name: "scout.stalenessThresholdHours",
    class: "policy",
    default: 0.5,
    min: 0.1,
    max: 168,
    description:
      "Hours of staleness at which a market refresh is worth its full scout.creditsPerRefresh. " +
      "Value grows linearly past this, so a market unseen for twice this long is worth twice as much.",
  },
  {
    name: "credit.reserveFloor",
    class: "policy",
    default: 0,
    min: 0,
    max: 100_000_000,
    description: "Cash floor. The planner never takes on work whose estimated cost would drop credits below this.",
  },
  {
    name: "mine.failureRetryLimit",
    class: "policy",
    default: 3,
    min: 1,
    max: 20,
    description: "Consecutive failures on one target before the planner gives up on it and reassigns.",
  },
  {
    name: "replan.debounceSeconds",
    class: "policy",
    default: 30,
    min: 1,
    max: 600,
    description:
      "Minimum seconds between fleet replans. A burst of triggers inside this window coalesces into one replan.",
  },

  // --- Alert: what counts as "something is wrong". Operator-only, never AI ---
  {
    name: "anomaly.shipIdleMinutes",
    class: "alert",
    default: 10,
    min: 1,
    max: 1440,
    description: "Minutes a ship can sit without changing phase (while armed and live) before it's flagged idle.",
  },
  {
    name: "anomaly.profitDropFraction",
    class: "alert",
    default: 0.5,
    min: 0,
    max: 1,
    description: "Earnings are stalled if the latest hour's rate falls below this fraction of the trailing 6h average.",
  },
  {
    name: "anomaly.creditsFlatWindowHours",
    class: "alert",
    default: 2,
    min: 0.25,
    max: 48,
    description: "Earnings are also stalled if total credits show no net increase across this many hours.",
  },
  {
    name: "anomaly.consecutiveFailureLimit",
    class: "alert",
    default: 3,
    min: 1,
    max: 20,
    description: "Consecutive failures on one ship that raise an anomaly, independent of the planner's own retry limit.",
  },
  {
    name: "anomaly.errorRateThreshold",
    class: "alert",
    default: 0.1,
    min: 0,
    max: 1,
    description: "Fraction of recent mining events that must be errors before the fleet is flagged as failing.",
  },
  {
    name: "anomaly.errorRateWindowMinutes",
    class: "alert",
    default: 5,
    min: 1,
    max: 1440,
    description: "Trailing window over which that error fraction is computed.",
  },
  {
    name: "anomaly.marketStalenessMinutes",
    class: "alert",
    default: 30,
    min: 5,
    max: 1440,
    description: "Minutes since a market in active use was last priced before its price data is flagged stale.",
  },
  {
    name: "anomaly.dedupeCooldownMinutes",
    class: "alert",
    default: 15,
    min: 1,
    max: 1440,
    description: "How long an already-fired anomaly stays suppressed, so one open problem doesn't page every tick.",
  },
];

export const KNOB_DEFINITIONS_BY_NAME: ReadonlyMap<string, KnobDefinition> = new Map(
  KNOB_DEFINITIONS.map((d) => [d.name, d])
);

export interface Knob {
  name: string;
  class: KnobClass;
  value: number;
  default: number;
  min: number;
  max: number;
  description: string;
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
      "SELECT name, knob_class, value, default_value, min_value, max_value FROM knob ORDER BY name"
    );
    return rows.map(rowToKnob);
  }

  /** Just the knobs of one class — how the AI supervisor's tool surface is narrowed to `policy`. */
  async getByClass(knobClass: KnobClass): Promise<Knob[]> {
    const { rows } = await this.pool.query(
      "SELECT name, knob_class, value, default_value, min_value, max_value FROM knob WHERE knob_class = $1 ORDER BY name",
      [knobClass]
    );
    return rows.map(rowToKnob);
  }

  async get(name: string): Promise<number> {
    const { rows } = await this.pool.query("SELECT value FROM knob WHERE name = $1", [name]);
    if (rows.length === 0) throw new KnobNotFoundError(name);
    return Number(rows[0].value);
  }

  /** Every knob as a plain name→value map, for the callers that need most of them at once. */
  async getValues(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query("SELECT name, value FROM knob");
    return Object.fromEntries(rows.map((r: { name: string; value: string | number }) => [r.name, Number(r.value)]));
  }

  // Reads and writes on the same row within one client-held transaction (with a
  // row lock), so the previousValue returned is always the value actually
  // overwritten — a plain pool.query() get() followed by a separate set() call
  // could interleave with a concurrent writer and report a stale previousValue.
  async set(name: string, value: number): Promise<{ knob: Knob; previousValue: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT name, knob_class, value, default_value, min_value, max_value FROM knob WHERE name = $1 FOR UPDATE",
        [name]
      );
      if (rows.length === 0) throw new KnobNotFoundError(name);
      const knob = rowToKnob(rows[0]);
      if (value < knob.min || value > knob.max) {
        throw new KnobOutOfRangeError(name, value, knob.min, knob.max);
      }
      await client.query("UPDATE knob SET value = $2 WHERE name = $1", [name, value]);
      await client.query("COMMIT");
      return { knob: { ...knob, value }, previousValue: knob.value };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

function rowToKnob(row: {
  name: string;
  knob_class: string;
  value: string | number;
  default_value: string | number;
  min_value: string | number;
  max_value: string | number;
}): Knob {
  return {
    name: row.name,
    class: row.knob_class as KnobClass,
    value: Number(row.value),
    default: Number(row.default_value),
    min: Number(row.min_value),
    max: Number(row.max_value),
    // Descriptions live in code, not the database — they change with the code
    // that reads them, and nobody should have to run a migration to fix a typo.
    description: KNOB_DEFINITIONS_BY_NAME.get(row.name)?.description ?? "",
  };
}

import { Pool } from "pg";
import { withTransaction } from "./transaction";

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

export const KNOB_CLASSES: readonly KnobClass[] = ["model", "policy", "alert"];

export const isKnobClass = (value: unknown): value is KnobClass =>
  typeof value === "string" && (KNOB_CLASSES as readonly string[]).includes(value);

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
 * the next boot, so this list is always the complete and current set. It is
 * also the source of the `KnobName` type, so a typo in a knob name anywhere in
 * the code is a compile error rather than a `NaN` score at runtime.
 */
export const KNOB_DEFINITIONS = [
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
    // Deliberately not 0. At zero the check reduces to "would this take the
    // balance negative", which reserves nothing and only blocks work the agent
    // already cannot afford — so the guard against the unrecoverable
    // out-of-fuel-money spiral shipped nominally on and functionally absent.
    // 5000 is roughly ten round trips' fuel at the prior rate: enough that a
    // ship can always still reach a market. Turning the protection off should
    // cost an explicit write, not be what happens if nobody thinks about it.
    default: 5000,
    min: 0,
    max: 100_000_000,
    description:
      "Cash floor. The planner never takes on work whose estimated cost would drop credits below this. " +
      "0 disables the floor entirely, which risks the unrecoverable out-of-fuel-money spiral.",
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
    description:
      "Minutes a ship can sit without progress (while armed and live) before it's flagged idle. " +
      "Time spent inside a known wait — a flight or a cooldown — doesn't count.",
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
    name: "anomaly.noEarningsMinutes",
    class: "alert",
    default: 60,
    min: 5,
    max: 1440,
    description:
      "Minutes the autopilot can be armed or paused with nothing sold at all before earnings are " +
      "flagged as stalled. The only check measured against zero rather than the fleet's own recent " +
      "history, so unlike profit drop it cannot go quiet once a dead fleet's average reaches zero.",
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
    description:
      "Minutes since a ship last refreshed a market's prices in person before a market the planner is " +
      "deciding on is flagged stale.",
  },
  {
    name: "anomaly.dedupeCooldownMinutes",
    class: "alert",
    default: 15,
    min: 1,
    max: 1440,
    description: "How long an already-fired anomaly stays suppressed, so one open problem doesn't page every tick.",
  },
] as const satisfies readonly KnobDefinition[];

export type KnobName = (typeof KNOB_DEFINITIONS)[number]["name"];

/** Every knob's current value, keyed by name. Complete by construction — see `KnobRepo.getValues`. */
export type KnobValues = Record<KnobName, number>;

export const KNOB_NAMES: readonly KnobName[] = KNOB_DEFINITIONS.map((d) => d.name);

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

const KNOB_SELECT = "SELECT name, knob_class, value, default_value, min_value, max_value FROM knob";

/**
 * Brings the `knob` table in line with KNOB_DEFINITIONS.
 *
 * An operator's *tuned value* always survives a redeploy — that's the whole
 * point of storing it — but everything else about a knob (its class, bounds,
 * default) is code, and code wins. A knob dropped from the definitions is
 * deleted rather than left behind: an orphan row would still appear in the API
 * and in the AI supervisor's tool list, offering a lever wired to nothing.
 *
 * A tuned value that no longer fits newly-tightened bounds is clamped, not
 * discarded, so a redeploy can never leave a value the write path itself would
 * reject.
 */
export async function syncKnobDefinitions(pool: Pool): Promise<void> {
  for (const def of KNOB_DEFINITIONS) {
    await pool.query(
      `INSERT INTO knob (name, knob_class, value, default_value, min_value, max_value)
       VALUES ($1, $2, $3, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         knob_class = EXCLUDED.knob_class,
         default_value = EXCLUDED.default_value,
         min_value = EXCLUDED.min_value,
         max_value = EXCLUDED.max_value,
         value = LEAST(GREATEST(knob.value, EXCLUDED.min_value), EXCLUDED.max_value)`,
      [def.name, def.class, def.default, def.min, def.max]
    );
  }
  await pool.query(`DELETE FROM knob WHERE name <> ALL($1::text[])`, [KNOB_NAMES]);
}

export class KnobRepo {
  constructor(private pool: Pool) {}

  async getAll(): Promise<Knob[]> {
    const { rows } = await this.pool.query(`${KNOB_SELECT} ORDER BY name`);
    return rows.map(rowToKnob);
  }

  /** Just the knobs of one class — how the AI supervisor's tool surface is narrowed to `policy`. */
  async getByClass(knobClass: KnobClass): Promise<Knob[]> {
    const { rows } = await this.pool.query(`${KNOB_SELECT} WHERE knob_class = $1 ORDER BY name`, [knobClass]);
    return rows.map(rowToKnob);
  }

  async get(name: KnobName): Promise<number> {
    const { rows } = await this.pool.query("SELECT value FROM knob WHERE name = $1", [name]);
    if (rows.length === 0) throw new KnobNotFoundError(name);
    return Number(rows[0].value);
  }

  /**
   * Every knob's value at once, for the planner and anything else that needs
   * most of them. Guaranteed complete: a name missing from the table (which
   * `syncKnobDefinitions` on boot should make impossible) throws here rather
   * than turning up as `undefined` inside a score.
   */
  async getValues(): Promise<KnobValues> {
    const { rows } = await this.pool.query("SELECT name, value FROM knob");
    const values: Partial<KnobValues> = {};
    for (const row of rows as { name: string; value: string | number }[]) {
      if (KNOB_DEFINITIONS_BY_NAME.has(row.name)) values[row.name as KnobName] = Number(row.value);
    }
    for (const name of KNOB_NAMES) {
      if (values[name] === undefined) throw new KnobNotFoundError(name);
    }
    return values as KnobValues;
  }

  /**
   * Reads and writes the row under one row lock, so the previousValue returned
   * is always the value actually overwritten — a plain get() followed by a
   * separate set() could interleave with a concurrent writer and report a
   * stale previousValue.
   */
  async set(name: string, value: number): Promise<{ knob: Knob; previousValue: number }> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query(`${KNOB_SELECT} WHERE name = $1 FOR UPDATE`, [name]);
      if (rows.length === 0) throw new KnobNotFoundError(name);
      const knob = rowToKnob(rows[0]);
      if (value < knob.min || value > knob.max) {
        throw new KnobOutOfRangeError(name, value, knob.min, knob.max);
      }
      await client.query("UPDATE knob SET value = $2 WHERE name = $1", [name, value]);
      return { knob: { ...knob, value }, previousValue: knob.value };
    });
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

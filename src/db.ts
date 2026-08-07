import { Pool, PoolClient } from "pg";
import { KNOB_DEFINITIONS } from "./knobs";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

/**
 * Runs fn against a single checked-out client inside a BEGIN/COMMIT block,
 * rolling back on any error. Callers pass the client into repo methods (which
 * accept Pool | PoolClient) so multiple writes across different repos land in
 * one transaction instead of as separate autocommitted statements (meta#30).
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

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
  await pool.query(`DELETE FROM knob WHERE name <> ALL($1::text[])`, [KNOB_DEFINITIONS.map((d) => d.name)]);
}

/** Idempotent so it can run on every boot; no separate migration runner for one table yet. */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_log (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  // Matches EventLog.list()'s ORDER BY exactly, and stands ready for meta#10/#11
  // (metrics rollups, anomaly detection) querying this table by time window.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS event_log_occurred_at_id_idx ON event_log (occurred_at DESC, id DESC)
  `);
  // Anomaly detection (meta#15) filters by exact event type on every tick,
  // indefinitely — agent_credits_snapshot, mining_market_selected, etc.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS event_log_type_occurred_at_idx ON event_log (type, occurred_at)
  `);

  // One row per ship under autopilot control. Survives restarts (per story 14)
  // even though AutopilotState's armed/paused/aborted status does not — a
  // restart disarms, but re-arming resumes each ship from its persisted phase
  // instead of re-running completed work.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ship_task (
      ship_symbol TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      waiting_until TIMESTAMPTZ,
      survey JSONB,
      trade_symbol TEXT,
      market_waypoint TEXT,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  // asteroid_waypoint is NULL whenever the ship needs a fresh assignment from the
  // planner (meta#10) — a brand new task, or the moment a cycle completes.
  // failure_count drives reassignment away from a target that keeps erroring.
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS asteroid_waypoint TEXT`);
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0`);

  // Contract loop (meta#11): a ship's task can be either 'mining' (the existing
  // phases above) or 'contract' (phases in contractTask.ts), sharing the same
  // row/columns rather than a parallel task table — the planner picks whichever
  // wins the credits-per-hour scoring, and both kinds resume identically on restart.
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS task_kind TEXT NOT NULL DEFAULT 'mining'`);
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS contract_id TEXT`);
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS destination_waypoint TEXT`);
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS units_delivered INTEGER NOT NULL DEFAULT 0`);

  // Per-cycle accumulators. A mining cycle's revenue and duration can only be
  // known once the cycle ends, and a cycle spans many ticks and a restart — so
  // they're tallied on the task row as the cycle runs, then written to
  // mining_observation and reset when the ship hands itself back to the planner.
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS cycle_started_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS cycle_revenue DOUBLE PRECISION NOT NULL DEFAULT 0`);
  await pool.query(
    `ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS cycle_travel_distance DOUBLE PRECISION NOT NULL DEFAULT 0`
  );
  await pool.query(`ALTER TABLE ship_task ADD COLUMN IF NOT EXISTS cycle_units_extracted DOUBLE PRECISION NOT NULL DEFAULT 0`);

  // Knobs: value + class + default + min/max, schema-validated on write.
  // Synced from KNOB_DEFINITIONS below on every boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knob (
      name TEXT PRIMARY KEY,
      value DOUBLE PRECISION NOT NULL,
      default_value DOUBLE PRECISION NOT NULL,
      min_value DOUBLE PRECISION NOT NULL,
      max_value DOUBLE PRECISION NOT NULL
    )
  `);
  // 'policy' is the safe default for a pre-existing row: it's the class the AI
  // may write, so a knob that somehow misses the sync below stays functional
  // rather than silently disappearing from the supervisor's tool list.
  await pool.query(`ALTER TABLE knob ADD COLUMN IF NOT EXISTS knob_class TEXT NOT NULL DEFAULT 'policy'`);
  await syncKnobDefinitions(pool);

  // Metrics rollups (meta#14): each row summarizes activity over one
  // [window_start, window_end) slice of event_log, computed and persisted on
  // a schedule rather than aggregated on every read.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metrics_rollup (
      id BIGSERIAL PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL,
      credits_per_hour DOUBLE PRECISION NOT NULL,
      extraction_units DOUBLE PRECISION NOT NULL,
      error_rate DOUBLE PRECISION NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS metrics_rollup_window_end_idx ON metrics_rollup (window_end DESC)
  `);

  // Anomaly detection (meta#15): one row per fired anomaly, persisted before
  // webhook delivery is attempted so a delivery failure never loses the record.
  // dedupe_key groups repeat firings of the same underlying condition so a
  // sustained problem doesn't spam the webhook every tick.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anomaly (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      delivered_at TIMESTAMPTZ,
      delivery_attempts INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS anomaly_dedupe_key_detected_at_idx ON anomaly (dedupe_key, detected_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS anomaly_detected_at_idx ON anomaly (detected_at DESC)
  `);

  // Market scouting: one row per marketplace, tracking the last time this
  // automation-service called getMarket while a ship was docked there.
  // Freshness decays over time; the planner scores scouting tasks higher as
  // staleness grows to keep price data current (see README).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_intel (
      waypoint TEXT PRIMARY KEY,
      last_refreshed_at TIMESTAMPTZ NOT NULL
    )
  `);

  // What the fleet has learned by flying. These two tables are what let the
  // planner score on measured values instead of hand-typed constants — see
  // observations.ts. One row per completed mining cycle, one per real flight.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mining_observation (
      id BIGSERIAL PRIMARY KEY,
      ship_symbol TEXT NOT NULL,
      asteroid_waypoint TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      revenue DOUBLE PRECISION NOT NULL,
      cycle_hours DOUBLE PRECISION NOT NULL,
      travel_distance DOUBLE PRECISION NOT NULL DEFAULT 0,
      units_extracted DOUBLE PRECISION NOT NULL DEFAULT 0
    )
  `);
  // Calibration always reads "recent observations, newest first" — for one
  // waypoint when scoring a known field, across all of them for the fleet-wide
  // fallback. Both are served by this index.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS mining_observation_waypoint_observed_at_idx
      ON mining_observation (asteroid_waypoint, observed_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS mining_observation_observed_at_idx ON mining_observation (observed_at DESC)
  `);

  // Two things are learned from moving a ship, and both are recorded here:
  // how long a flight of known distance took (hours), and what refuelling after
  // a known distance cost (fuel_credits). A row carries whichever it observed —
  // a flight has no price attached, a refuel has no duration — so both columns
  // are nullable and each calibration reads only the rows that inform it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS travel_observation (
      id BIGSERIAL PRIMARY KEY,
      observed_at TIMESTAMPTZ NOT NULL,
      distance DOUBLE PRECISION NOT NULL,
      hours DOUBLE PRECISION,
      fuel_credits DOUBLE PRECISION
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS travel_observation_observed_at_idx ON travel_observation (observed_at DESC)
  `);

  // Contract loop (meta#11): one row per contract this agent has ever seen,
  // recording the deterministic evaluation decision and its inputs so a
  // contract is never re-evaluated (or re-accepted) once decided.
  // v1 simplification: tracks only the contract's first deliverable — see
  // README for contracts with more than one deliverable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contract (
      contract_id TEXT PRIMARY KEY,
      trade_symbol TEXT NOT NULL,
      destination_waypoint TEXT NOT NULL,
      units_required INTEGER NOT NULL,
      total_payment DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL,
      expected_profit DOUBLE PRECISION NOT NULL,
      cycle_hours DOUBLE PRECISION NOT NULL,
      procurement_market TEXT,
      evaluated_at TIMESTAMPTZ NOT NULL
    )
  `);
}

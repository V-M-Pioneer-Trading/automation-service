import { Pool } from "pg";
import { KNOB_DEFINITIONS } from "./knobs";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
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

  // Planner knobs (meta#10): value + default + min/max, schema-validated on write.
  // Seeded from KNOB_DEFINITIONS below; existing rows are left alone so an operator's
  // tuning survives a redeploy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knob (
      name TEXT PRIMARY KEY,
      value DOUBLE PRECISION NOT NULL,
      default_value DOUBLE PRECISION NOT NULL,
      min_value DOUBLE PRECISION NOT NULL,
      max_value DOUBLE PRECISION NOT NULL
    )
  `);
  for (const def of KNOB_DEFINITIONS) {
    await pool.query(
      `INSERT INTO knob (name, value, default_value, min_value, max_value)
       VALUES ($1, $2, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [def.name, def.default, def.min, def.max]
    );
  }

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

import { Pool } from "pg";

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
}

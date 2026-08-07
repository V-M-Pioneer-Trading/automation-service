import { Pool } from "pg";

/**
 * Returns the database to a known state between tests.
 *
 * Every test file shares one Postgres (that's why jest pins `maxWorkers: 1`),
 * so anything one file leaves behind is another file's mystery failure. This
 * exists because that kept happening: files truncated different subsets of
 * tables, and only some reset knobs — so a test's outcome could depend on which
 * file ran before it.
 *
 * Truncating every state table here, in one place, means adding a table to
 * db.ts only needs adding it to this list, not remembering to update eight
 * `beforeEach` blocks.
 */
const STATE_TABLES = [
  "event_log",
  "ship_task",
  "metrics_rollup",
  "anomaly",
  "market_intel",
  "contract",
  "mining_observation",
  "travel_observation",
];

export interface ResetOptions {
  /**
   * Scouting competes for assignments by default, so a test about mining or
   * contracts can otherwise find its ship flying off to price a market. Tests
   * that aren't about scouting should leave this false and say so; a test that
   * wants scouting enables it explicitly.
   */
  enableScouting?: boolean;
}

export async function resetDatabase(pool: Pool, options: ResetOptions = {}): Promise<void> {
  await pool.query(`TRUNCATE ${STATE_TABLES.join(", ")} RESTART IDENTITY`);
  await pool.query("UPDATE knob SET value = default_value");
  if (options.enableScouting !== true) {
    await pool.query("UPDATE knob SET value = 0 WHERE name = 'scout.creditsPerRefresh'");
  }
}

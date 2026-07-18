import { Pool } from "pg";
import { Clock } from "./clock";

export interface MetricsRollup {
  windowStart: string;
  windowEnd: string;
  computedAt: string;
  creditsPerHour: number;
  extractionUnits: number;
  /** Fraction (0..1) of mining_* events in the window that were tick errors or task failures. */
  errorRate: number;
}

/**
 * Rolls up profitability/health metrics from event_log over one time window —
 * a periodic aggregate, not computed fresh on every read. v1 simplification:
 * credits/hour only counts mining_sell revenue (transaction totalPrice logged
 * on every sell since meta#14); it doesn't net out fuel or other costs.
 */
export class MetricsRepo {
  constructor(private pool: Pool, private clock: Clock) {}

  async computeAndSave(windowStart: Date, windowEnd: Date): Promise<MetricsRollup> {
    const computedAt = this.clock.now(); // read once so the returned rollup and the persisted row agree exactly
    const { rows } = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'mining_sell' THEN (detail->>'totalPrice')::double precision ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN type = 'mining_extract' THEN (detail->>'units')::double precision ELSE 0 END), 0) AS extraction_units,
         COUNT(*) FILTER (WHERE type LIKE 'mining_%') AS total_mining_events,
         COUNT(*) FILTER (WHERE type IN ('mining_tick_error', 'mining_task_failed')) AS error_events
       FROM event_log
       WHERE occurred_at >= $1 AND occurred_at < $2`,
      [windowStart, windowEnd]
    );
    const row = rows[0];
    const windowHours = (windowEnd.getTime() - windowStart.getTime()) / (60 * 60 * 1000);
    const revenue = Number(row.revenue);
    const totalMiningEvents = Number(row.total_mining_events);
    const errorEvents = Number(row.error_events);

    const rollup: MetricsRollup = {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      computedAt: computedAt.toISOString(),
      creditsPerHour: windowHours > 0 ? revenue / windowHours : 0,
      extractionUnits: Number(row.extraction_units),
      errorRate: totalMiningEvents > 0 ? errorEvents / totalMiningEvents : 0,
    };

    await this.pool.query(
      `INSERT INTO metrics_rollup (window_start, window_end, computed_at, credits_per_hour, extraction_units, error_rate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [windowStart, windowEnd, computedAt, rollup.creditsPerHour, rollup.extractionUnits, rollup.errorRate]
    );
    return rollup;
  }

  /** The window_end of the most recent rollup, or null if none exist yet. */
  async latestWindowEnd(): Promise<Date | null> {
    const { rows } = await this.pool.query("SELECT MAX(window_end) AS latest FROM metrics_rollup");
    return rows[0]?.latest ?? null;
  }

  async list(limit = 20): Promise<MetricsRollup[]> {
    const { rows } = await this.pool.query(
      `SELECT window_start, window_end, computed_at, credits_per_hour, extraction_units, error_rate
       FROM metrics_rollup ORDER BY window_end DESC LIMIT $1`,
      [limit]
    );
    return rows.map((row) => ({
      windowStart: row.window_start.toISOString(),
      windowEnd: row.window_end.toISOString(),
      computedAt: row.computed_at.toISOString(),
      creditsPerHour: row.credits_per_hour,
      extractionUnits: row.extraction_units,
      errorRate: row.error_rate,
    }));
  }
}

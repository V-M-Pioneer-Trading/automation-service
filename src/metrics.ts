import { Pool } from "pg";
import { Clock } from "./clock";
import { ACTION_ERROR_PREDICATE, EVENT_REVENUE_SQL, TASK_EVENT_PREDICATE } from "./fleetEvents";

export interface MetricsRollup {
  windowStart: string;
  windowEnd: string;
  computedAt: string;
  creditsPerHour: number;
  extractionUnits: number;
  /** Fraction (0..1) of ship-task events in the window — any task kind — that were tick errors or task failures. */
  errorRate: number;
}

/**
 * Rolls up profitability/health metrics from event_log over one time window —
 * a periodic aggregate, not computed fresh on every read. v1 simplification:
 * credits/hour counts mining sells and both contract payments (see
 * `fleetEvents.ts`); it doesn't net out fuel or other costs.
 */
export class MetricsRepo {
  constructor(private pool: Pool, private clock: Clock) {}

  async computeAndSave(windowStart: Date, windowEnd: Date): Promise<MetricsRollup> {
    const computedAt = this.clock.now(); // read once so the returned rollup and the persisted row agree exactly
    const { rows } = await this.pool.query(
      `SELECT
         COALESCE(SUM(${EVENT_REVENUE_SQL}), 0) AS revenue,
         COALESCE(SUM(CASE WHEN type = 'mining_extract' THEN (detail->>'units')::double precision ELSE 0 END), 0) AS extraction_units,
         COUNT(*) FILTER (WHERE ${TASK_EVENT_PREDICATE}) AS total_task_events,
         COUNT(*) FILTER (WHERE ${ACTION_ERROR_PREDICATE}) AS error_events
       FROM event_log
       WHERE occurred_at >= $1 AND occurred_at < $2`,
      [windowStart, windowEnd]
    );
    const row = rows[0];
    const windowHours = (windowEnd.getTime() - windowStart.getTime()) / (60 * 60 * 1000);
    const revenue = Number(row.revenue);
    const totalTaskEvents = Number(row.total_task_events);
    const errorEvents = Number(row.error_events);

    const rollup: MetricsRollup = {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      computedAt: computedAt.toISOString(),
      creditsPerHour: windowHours > 0 ? revenue / windowHours : 0,
      extractionUnits: Number(row.extraction_units),
      errorRate: totalTaskEvents > 0 ? errorEvents / totalTaskEvents : 0,
    };

    await this.pool.query(
      `INSERT INTO metrics_rollup (window_start, window_end, computed_at, credits_per_hour, extraction_units, error_rate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [windowStart, windowEnd, computedAt, rollup.creditsPerHour, rollup.extractionUnits, rollup.errorRate]
    );
    return rollup;
  }

  /**
   * The most recent rollup at or before `at`, and the average of the rollups
   * strictly before it within `trailingMs`.
   *
   * One method rather than two because the two numbers only mean anything
   * together: the trailing average deliberately *excludes* the latest rollup,
   * so this is "latest against its own history" rather than "latest against a
   * window that already contains it". Split across two calls that invariant
   * lived in the caller, which is how the profit-drop check came to own two
   * queries against a table it does not.
   */
  async latestAgainstTrailingAverage(
    at: Date,
    trailingMs: number
  ): Promise<{ latest: number; trailingAverage: number; sampleCount: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT credits_per_hour, window_end FROM metrics_rollup WHERE window_end <= $1 ORDER BY window_end DESC LIMIT 1`,
      [at]
    );
    if (rows.length === 0) return null;
    const latestWindowEnd: Date = rows[0].window_end;
    const { rows: trailing } = await this.pool.query(
      `SELECT AVG(credits_per_hour) AS avg, COUNT(*) AS count FROM metrics_rollup
       WHERE window_end > $1 AND window_end < $2`,
      [new Date(at.getTime() - trailingMs), latestWindowEnd]
    );
    return {
      latest: Number(rows[0].credits_per_hour),
      trailingAverage: Number(trailing[0].avg),
      sampleCount: Number(trailing[0].count),
    };
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

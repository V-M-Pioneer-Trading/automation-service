import { Pool } from "pg";
import { AutopilotState } from "./autopilotState";
import { Clock } from "./clock";
import { KnobRepo } from "./knobs";

export interface Anomaly {
  id: string;
  type: string;
  dedupeKey: string;
  detectedAt: string;
  detail: Record<string, unknown>;
  deliveredAt: string | null;
  deliveryAttempts: number;
}

/** A candidate anomaly a check has detected this tick, not yet persisted or deduped. */
export interface AnomalyCandidate {
  type: string;
  dedupeKey: string;
  detail: Record<string, unknown>;
}

const MARKET_ACTIVE_USE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export class AnomalyRepo {
  constructor(private pool: Pool, private clock: Clock) {}

  /** Most recent anomaly recorded for a dedupe key, or null if this key has never fired. */
  async latestForKey(dedupeKey: string): Promise<Anomaly | null> {
    const { rows } = await this.pool.query(
      `SELECT id, type, dedupe_key, detected_at, detail, delivered_at, delivery_attempts
       FROM anomaly WHERE dedupe_key = $1 ORDER BY detected_at DESC LIMIT 1`,
      [dedupeKey]
    );
    return rows.length === 0 ? null : rowToAnomaly(rows[0]);
  }

  async record(candidate: AnomalyCandidate): Promise<Anomaly> {
    const detectedAt = this.clock.now();
    const { rows } = await this.pool.query(
      `INSERT INTO anomaly (type, dedupe_key, detected_at, detail) VALUES ($1, $2, $3, $4)
       RETURNING id, type, dedupe_key, detected_at, detail, delivered_at, delivery_attempts`,
      [candidate.type, candidate.dedupeKey, detectedAt, candidate.detail]
    );
    return rowToAnomaly(rows[0]);
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE anomaly SET delivered_at = $2, delivery_attempts = delivery_attempts + 1 WHERE id = $1`,
      [id, this.clock.now()]
    );
  }

  async incrementDeliveryAttempts(id: string): Promise<void> {
    await this.pool.query(`UPDATE anomaly SET delivery_attempts = delivery_attempts + 1 WHERE id = $1`, [id]);
  }

  /** Anomalies detected at or after `since`, newest first — feeds the digest endpoint. */
  async listSince(since: Date, limit: number): Promise<Anomaly[]> {
    const { rows } = await this.pool.query(
      `SELECT id, type, dedupe_key, detected_at, detail, delivered_at, delivery_attempts
       FROM anomaly WHERE detected_at >= $1 ORDER BY detected_at DESC LIMIT $2`,
      [since, limit]
    );
    return rows.map(rowToAnomaly);
  }
}

function rowToAnomaly(row: {
  id: string | number;
  type: string;
  dedupe_key: string;
  detected_at: Date;
  detail: Record<string, unknown>;
  delivered_at: Date | null;
  delivery_attempts: number;
}): Anomaly {
  return {
    id: String(row.id),
    type: row.type,
    dedupeKey: row.dedupe_key,
    detectedAt: row.detected_at.toISOString(),
    detail: row.detail,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    deliveryAttempts: row.delivery_attempts,
  };
}

/**
 * Runs the six meta#15 health checks and returns every candidate detected this
 * tick. Deliberately read-only and side-effect free — persistence, dedupe, and
 * webhook delivery are the caller's (AnomalyScheduler's) job, so these checks
 * stay simple functions of "what does the data say right now."
 */
export class AnomalyChecker {
  constructor(private pool: Pool, private clock: Clock, private knobs: KnobRepo, private state: AutopilotState) {}

  async runChecks(shipSymbol: string, shipTaskUpdatedAt: Date | null, shipFailureCount: number): Promise<AnomalyCandidate[]> {
    const now = this.clock.now();
    const miningActive = this.state.getStatus() === "armed" && this.state.getMode() === "live";

    // The six checks are independent reads (different tables/knobs), so run
    // them concurrently rather than paying for six sequential round trips.
    const results = await Promise.all([
      miningActive && shipTaskUpdatedAt !== null
        ? this.checkShipIdle(shipSymbol, shipTaskUpdatedAt, now)
        : Promise.resolve(null),
      this.checkProfitDrop(now),
      this.checkConsecutiveFailures(shipSymbol, shipFailureCount),
      this.checkErrorRate(now),
      this.checkCreditsFlat(now),
      this.checkMarketStaleness(now),
    ]);

    const [idle, profit, failures, errorRate, creditsFlat, marketStale] = results;
    return [idle, profit, failures, errorRate, creditsFlat, ...marketStale].filter(
      (c): c is AnomalyCandidate => c !== null
    );
  }

  private async checkShipIdle(shipSymbol: string, updatedAt: Date, now: Date): Promise<AnomalyCandidate | null> {
    const thresholdMinutes = await this.knobs.get("anomaly.shipIdleMinutes");
    const idleMinutes = (now.getTime() - updatedAt.getTime()) / 60_000;
    if (idleMinutes <= thresholdMinutes) return null;
    return {
      type: "ship_idle",
      dedupeKey: `ship_idle:${shipSymbol}`,
      detail: { shipSymbol, idleMinutes, thresholdMinutes },
    };
  }

  private async checkProfitDrop(now: Date): Promise<AnomalyCandidate | null> {
    const { rows } = await this.pool.query(
      `SELECT credits_per_hour, window_end FROM metrics_rollup WHERE window_end <= $1 ORDER BY window_end DESC LIMIT 1`,
      [now]
    );
    if (rows.length === 0) return null;
    const latest = Number(rows[0].credits_per_hour);
    const latestWindowEnd: Date = rows[0].window_end;

    // Trailing average excludes the latest rollup itself — this is "latest vs
    // history", not "latest vs a window that already contains it".
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const { rows: windowRows } = await this.pool.query(
      `SELECT AVG(credits_per_hour) AS avg, COUNT(*) AS count FROM metrics_rollup WHERE window_end > $1 AND window_end < $2`,
      [sixHoursAgo, latestWindowEnd]
    );
    const avgCount = Number(windowRows[0].count);
    if (avgCount < 2) return null; // not enough history to judge a drop yet
    const avg6h = Number(windowRows[0].avg);
    if (avg6h <= 0) return null;

    const fraction = await this.knobs.get("anomaly.profitDropFraction");
    if (latest >= avg6h * fraction) return null;
    return {
      type: "profit_drop",
      dedupeKey: "profit_drop",
      detail: { latestCreditsPerHour: latest, avg6hCreditsPerHour: avg6h, fraction },
    };
  }

  private async checkConsecutiveFailures(shipSymbol: string, failureCount: number): Promise<AnomalyCandidate | null> {
    const limit = await this.knobs.get("anomaly.consecutiveFailureLimit");
    if (failureCount < limit) return null;
    return {
      type: "consecutive_failures",
      dedupeKey: `consecutive_failures:${shipSymbol}`,
      detail: { shipSymbol, failureCount, limit },
    };
  }

  private async checkErrorRate(now: Date): Promise<AnomalyCandidate | null> {
    const windowMinutes = await this.knobs.get("anomaly.errorRateWindowMinutes");
    const since = new Date(now.getTime() - windowMinutes * 60_000);
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE type LIKE 'mining\_%') AS total,
         COUNT(*) FILTER (WHERE type IN ('mining_tick_error', 'mining_task_failed')) AS errors
       FROM event_log WHERE occurred_at >= $1 AND occurred_at <= $2`,
      [since, now]
    );
    const total = Number(rows[0].total);
    if (total === 0) return null;
    const errors = Number(rows[0].errors);
    const rate = errors / total;
    const threshold = await this.knobs.get("anomaly.errorRateThreshold");
    if (rate <= threshold) return null;
    return {
      type: "error_rate",
      dedupeKey: "error_rate",
      detail: { rate, threshold, windowMinutes, totalEvents: total, errorEvents: errors },
    };
  }

  private async checkCreditsFlat(now: Date): Promise<AnomalyCandidate | null> {
    const windowHours = await this.knobs.get("anomaly.creditsFlatWindowHours");
    const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

    // Baseline is the most recent snapshot at or before the window start (not
    // one strictly inside it) — real polling is intermittent, and a FakeClock
    // in tests jumps discretely, so no snapshot may land exactly in-window.
    // None of these three queries depend on each other, so run them concurrently.
    const [{ rows: earliestRows }, { rows: baselineRows }, { rows: currentRows }] = await Promise.all([
      this.pool.query(`SELECT MIN(occurred_at) AS earliest FROM event_log WHERE type = 'agent_credits_snapshot'`),
      this.pool.query(
        `SELECT id, detail FROM event_log WHERE type = 'agent_credits_snapshot' AND occurred_at <= $1
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [since]
      ),
      this.pool.query(
        `SELECT id, detail FROM event_log WHERE type = 'agent_credits_snapshot' AND occurred_at <= $1
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [now]
      ),
    ]);

    // Require snapshotting to have started before the window, not just within
    // it — otherwise a freshly-armed autopilot looks "flat" on its first tick
    // simply for lack of history, not because credits actually stalled.
    const earliest = earliestRows[0].earliest;
    if (earliest === null || new Date(earliest) > since) return null;
    if (baselineRows.length === 0 || currentRows.length === 0) return null;
    // If the most recent snapshot overall is the very same one used as the
    // baseline, no fresh reading has landed since the window opened yet — that's
    // "no data", not "flat". Firing here would be a false positive on every
    // poll right after the window boundary, before the next snapshot arrives.
    if (currentRows[0].id === baselineRows[0].id) return null;

    const oldestCredits = Number((baselineRows[0].detail as { credits: number }).credits);
    const newestCredits = Number((currentRows[0].detail as { credits: number }).credits);
    const netChange = newestCredits - oldestCredits;
    if (netChange > 0) return null;
    return {
      type: "credits_flat",
      dedupeKey: "credits_flat",
      detail: { netChange, windowHours, oldestCredits, newestCredits },
    };
  }

  private async checkMarketStaleness(now: Date): Promise<AnomalyCandidate[]> {
    const stalenessMinutes = await this.knobs.get("anomaly.marketStalenessMinutes");
    const activeSince = new Date(now.getTime() - MARKET_ACTIVE_USE_LOOKBACK_MS);
    // Every market this ship priced (not just the one it ultimately picked) while
    // selecting a market to sell at, in the last 24h — "markets in active use".
    // The per-market MAX is computed in SQL (one row per market back, not one
    // per event) since this runs every tick indefinitely.
    const { rows } = await this.pool.query(
      `SELECT market, MAX(occurred_at) AS last_priced FROM (
         SELECT jsonb_array_elements_text(COALESCE(detail->'marketsChecked', '[]'::jsonb)) AS market, occurred_at
         FROM event_log WHERE type = 'mining_market_selected' AND occurred_at >= $1
       ) markets_checked
       GROUP BY market`,
      [activeSince]
    );

    const candidates: AnomalyCandidate[] = [];
    for (const row of rows) {
      const staleMinutes = (now.getTime() - new Date(row.last_priced).getTime()) / 60_000;
      if (staleMinutes <= stalenessMinutes) continue;
      candidates.push({
        type: "market_stale",
        dedupeKey: `market_stale:${row.market}`,
        detail: { market: row.market, staleMinutes, thresholdMinutes: stalenessMinutes },
      });
    }
    return candidates;
  }
}

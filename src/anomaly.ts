import { Pool } from "pg";
import { AutopilotState } from "./autopilotState";
import { Clock } from "./clock";
import { KnobRepo } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { ShipTask } from "./shipTaskRepo";

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

const ANOMALY_SELECT = "SELECT id, type, dedupe_key, detected_at, detail, delivered_at, delivery_attempts FROM anomaly";

export class AnomalyRepo {
  constructor(private pool: Pool, private clock: Clock) {}

  /** Most recent anomaly recorded for a dedupe key, or null if this key has never fired. */
  async latestForKey(dedupeKey: string): Promise<Anomaly | null> {
    const { rows } = await this.pool.query(`${ANOMALY_SELECT} WHERE dedupe_key = $1 ORDER BY detected_at DESC LIMIT 1`, [dedupeKey]);
    return rows.length === 0 ? null : rowToAnomaly(rows[0]);
  }

  async record(candidate: AnomalyCandidate): Promise<Anomaly> {
    const { rows } = await this.pool.query(
      `INSERT INTO anomaly (type, dedupe_key, detected_at, detail) VALUES ($1, $2, $3, $4)
       RETURNING id, type, dedupe_key, detected_at, detail, delivered_at, delivery_attempts`,
      [candidate.type, candidate.dedupeKey, this.clock.now(), candidate.detail]
    );
    return rowToAnomaly(rows[0]);
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(`UPDATE anomaly SET delivered_at = $2, delivery_attempts = delivery_attempts + 1 WHERE id = $1`, [
      id,
      this.clock.now(),
    ]);
  }

  async incrementDeliveryAttempts(id: string): Promise<void> {
    await this.pool.query(`UPDATE anomaly SET delivery_attempts = delivery_attempts + 1 WHERE id = $1`, [id]);
  }

  /**
   * Anomalies that were persisted but never successfully delivered, oldest
   * first, that still have delivery budget left.
   *
   * Recording before delivering means a webhook outage can't lose the record —
   * but nothing ever came back for it, so the page was lost anyway while the
   * row sat safely in Postgres looking fine. Dedupe made it worse: once the
   * condition cleared, no re-fire would ever replace the missed page.
   */
  async listUndelivered(maxAttempts: number, limit: number): Promise<Anomaly[]> {
    const { rows } = await this.pool.query(
      `${ANOMALY_SELECT} WHERE delivered_at IS NULL AND delivery_attempts < $1
       ORDER BY detected_at ASC LIMIT $2`,
      [maxAttempts, limit]
    );
    return rows.map(rowToAnomaly);
  }

  /** Anomalies detected at or after `since`, newest first — feeds the digest endpoint. */
  async listSince(since: Date, limit: number): Promise<Anomaly[]> {
    const { rows } = await this.pool.query(`${ANOMALY_SELECT} WHERE detected_at >= $1 ORDER BY detected_at DESC LIMIT $2`, [since, limit]);
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

type Reason = { reason: string; detail: Record<string, unknown> };

/**
 * Five health checks, each answering a different question about the fleet:
 *
 * | Check | Question |
 * |---|---|
 * | `ship_idle` | Is a ship stuck? |
 * | `earnings_stalled` | Has the money stopped coming in? |
 * | `consecutive_failures` | Is one ship failing repeatedly? |
 * | `error_rate` | Is the fleet as a whole erroring? |
 * | `market_stale` | Are we deciding on prices that are too old? |
 *
 * `earnings_stalled` covers two conditions that were previously separate checks
 * (`profit_drop` and `credits_flat`). They are two ways of measuring one thing —
 * a fleet that stops earning trips both, and paging twice for one problem made
 * the digest look busier than the fleet actually was. They stay separately
 * tunable and are reported in `detail.reasons`.
 *
 * Deliberately read-only and side-effect free — persistence, dedupe, and
 * webhook delivery are the caller's (AnomalyScheduler's) job, so these checks
 * stay simple functions of "what does the data say right now."
 */
export class AnomalyChecker {
  constructor(
    private pool: Pool,
    private clock: Clock,
    private knobs: KnobRepo,
    private state: AutopilotState,
    private marketIntel: MarketIntelRepo
  ) {}

  async runChecks(shipSymbol: string, task: ShipTask | null): Promise<AnomalyCandidate[]> {
    const now = this.clock.now();
    const miningActive = this.state.getStatus() === "armed" && this.state.getMode() === "live";

    // Independent reads (different tables and knobs), so run them concurrently.
    const [idle, earnings, failures, errorRate, marketStale] = await Promise.all([
      miningActive && task !== null ? this.checkShipIdle(shipSymbol, task, now) : Promise.resolve(null),
      this.checkEarningsStalled(now),
      this.checkConsecutiveFailures(shipSymbol, task?.failureCount ?? 0),
      this.checkErrorRate(now),
      this.checkMarketStaleness(now),
    ]);
    return [idle, earnings, failures, errorRate, ...marketStale].filter((c): c is AnomalyCandidate => c !== null);
  }

  /**
   * A ship is idle when nothing has happened to it for too long. Time spent
   * inside a wait it was told to sit through — a flight, a cooldown — is not
   * idleness, so a long transit doesn't page; the clock starts when the wait
   * ends and the row still hasn't moved.
   */
  private async checkShipIdle(shipSymbol: string, task: ShipTask, now: Date): Promise<AnomalyCandidate | null> {
    const thresholdMinutes = await this.knobs.get("anomaly.shipIdleMinutes");
    const idleSince = task.waitingUntil !== null && task.waitingUntil > task.updatedAt ? task.waitingUntil : task.updatedAt;
    const idleMinutes = (now.getTime() - idleSince.getTime()) / 60_000;
    if (idleMinutes <= thresholdMinutes) return null;
    return {
      type: "ship_idle",
      dedupeKey: `ship_idle:${shipSymbol}`,
      detail: {
        shipSymbol,
        idleMinutes,
        thresholdMinutes,
        phase: task.phase,
        waitingUntil: task.waitingUntil?.toISOString() ?? null,
      },
    };
  }

  /**
   * "The money stopped." Three independent readings of the same underlying
   * problem, any of which is enough to fire:
   *
   *  - **profit_drop** — the latest hourly rate collapsed against its own
   *    recent history. Catches a fleet that's still working but earning less.
   *  - **credits_flat** — total credits haven't grown at all over a window.
   *    Catches a fleet that looks busy but nets nothing, which a rate compared
   *    only against itself can miss.
   *  - **no_earnings** — nothing has been sold at all for a window, while the
   *    operator's intent is that the fleet be working. Catches what the other
   *    two structurally cannot: both compare the fleet against its own recent
   *    history, so a fleet that has been dead long enough for that history to
   *    reach zero stops tripping them. This one is absolute, so it keeps
   *    firing for as long as the problem lasts.
   */
  private async checkEarningsStalled(now: Date): Promise<AnomalyCandidate | null> {
    const readings = await Promise.all([this.detectProfitDrop(now), this.detectCreditsFlat(now), this.detectNoEarnings(now)]);
    const reasons = readings.filter((r): r is Reason => r !== null);
    if (reasons.length === 0) return null;
    return {
      type: "earnings_stalled",
      dedupeKey: "earnings_stalled",
      detail: { reasons: reasons.map((r) => r.reason), ...Object.assign({}, ...reasons.map((r) => r.detail)) },
    };
  }

  private async detectProfitDrop(now: Date): Promise<Reason | null> {
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
    if (Number(windowRows[0].count) < 2) return null; // not enough history to judge a drop yet
    const avg6h = Number(windowRows[0].avg);
    if (avg6h <= 0) return null;

    const fraction = await this.knobs.get("anomaly.profitDropFraction");
    if (latest >= avg6h * fraction) return null;
    return { reason: "profit_drop", detail: { latestCreditsPerHour: latest, avg6hCreditsPerHour: avg6h, fraction } };
  }

  private async detectCreditsFlat(now: Date): Promise<Reason | null> {
    const windowHours = await this.knobs.get("anomaly.creditsFlatWindowHours");
    const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

    // Baseline is the most recent snapshot at or before the window start (not
    // one strictly inside it) — real polling is intermittent, and a FakeClock
    // in tests jumps discretely, so no snapshot may land exactly in-window.
    const latestSnapshot = (before: Date) =>
      this.pool.query(
        `SELECT id, detail FROM event_log WHERE type = 'agent_credits_snapshot' AND occurred_at <= $1
         ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [before]
      );
    const [{ rows: earliestRows }, { rows: baselineRows }, { rows: currentRows }] = await Promise.all([
      this.pool.query(`SELECT MIN(occurred_at) AS earliest FROM event_log WHERE type = 'agent_credits_snapshot'`),
      latestSnapshot(since),
      latestSnapshot(now),
    ]);

    // Require snapshotting to have started before the window, not just within
    // it — otherwise a freshly-armed autopilot looks "flat" on its first tick
    // simply for lack of history, not because credits actually stalled.
    const earliest = earliestRows[0].earliest;
    if (earliest === null || new Date(earliest) > since) return null;
    if (baselineRows.length === 0 || currentRows.length === 0) return null;
    // The baseline being the most recent snapshot overall means no fresh
    // reading has landed since the window opened — "no data", not "flat".
    if (currentRows[0].id === baselineRows[0].id) return null;

    const oldestCredits = Number((baselineRows[0].detail as { credits: number }).credits);
    const newestCredits = Number((currentRows[0].detail as { credits: number }).credits);
    const netChange = newestCredits - oldestCredits;
    if (netChange > 0) return null;
    return { reason: "credits_flat", detail: { netChange, windowHours, oldestCredits, newestCredits } };
  }

  /**
   * Nothing sold for a whole window, while the autopilot is armed or paused —
   * i.e. while the operator's stated intent is that the fleet be working.
   *
   * This is the only check that asserts the *positive* condition, and it is
   * the one that covers a fleet left paused: `ship_idle` and the credits
   * snapshot both gate on armed-and-live, and `profit_drop` compares the
   * fleet only against itself, so once a dead fleet's trailing average
   * reaches zero it stops having anything to fall below. Measuring against
   * zero instead of against history means this cannot switch itself off.
   *
   * The window is measured from the last lifecycle transition as well as from
   * now, so a freshly armed fleet is given the full window to earn something
   * before it is called stalled.
   */
  private async detectNoEarnings(now: Date): Promise<Reason | null> {
    const status = this.state.getStatus();
    if (status !== "armed" && status !== "paused") return null;

    const windowMinutes = await this.knobs.get("anomaly.noEarningsMinutes");
    const since = new Date(now.getTime() - windowMinutes * 60_000);

    const [{ rows: lifecycleRows }, { rows: sellRows }] = await Promise.all([
      this.pool.query(
        `SELECT occurred_at FROM event_log WHERE type IN ('armed', 'paused', 'aborted')
         ORDER BY occurred_at DESC, id DESC LIMIT 1`
      ),
      this.pool.query(
        `SELECT MAX(occurred_at) AS last_sold, COUNT(*) AS sells FROM event_log
         WHERE type = 'mining_sell' AND occurred_at >= $1 AND occurred_at <= $2`,
        [since, now]
      ),
    ]);

    // In this state for less than the window: too early to judge.
    const enteredStateAt = lifecycleRows[0]?.occurred_at ?? null;
    if (enteredStateAt === null || new Date(enteredStateAt) > since) return null;
    if (Number(sellRows[0].sells) > 0) return null;

    return {
      reason: "no_earnings",
      detail: {
        status,
        windowMinutes,
        lastSoldAt: (sellRows[0].last_sold as Date | null)?.toISOString() ?? null,
        enteredStateAt: new Date(enteredStateAt).toISOString(),
      },
    };
  }

  private async checkConsecutiveFailures(shipSymbol: string, failureCount: number): Promise<AnomalyCandidate | null> {
    const limit = await this.knobs.get("anomaly.consecutiveFailureLimit");
    if (failureCount < limit) return null;
    return { type: "consecutive_failures", dedupeKey: `consecutive_failures:${shipSymbol}`, detail: { shipSymbol, failureCount, limit } };
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
    return { type: "error_rate", dedupeKey: "error_rate", detail: { rate, threshold, windowMinutes, totalEvents: total, errorEvents: errors } };
  }

  /**
   * "Are we deciding on prices that are too old?" A market is in active use
   * when the sell leg priced it (from wherever the ship was) in the last 24h;
   * it's stale when no ship of ours has read it *in person* — the only read
   * SpaceTraders answers with trade goods — within the threshold. Freshness
   * comes from `market_intel`, the same store the planner scouts against, so
   * the alert and the planner can never disagree about what stale means.
   */
  private async checkMarketStaleness(now: Date): Promise<AnomalyCandidate[]> {
    const thresholdMinutes = await this.knobs.get("anomaly.marketStalenessMinutes");
    const activeSince = new Date(now.getTime() - MARKET_ACTIVE_USE_LOOKBACK_MS);
    const { rows } = await this.pool.query(
      `SELECT DISTINCT jsonb_array_elements_text(COALESCE(detail->'marketsChecked', '[]'::jsonb)) AS market
       FROM event_log WHERE type = 'mining_market_selected' AND occurred_at >= $1`,
      [activeSince]
    );
    if (rows.length === 0) return [];

    const lastRefreshed = new Map((await this.marketIntel.getAll()).map((m) => [m.waypoint, m.lastRefreshedAt]));
    const candidates: AnomalyCandidate[] = [];
    for (const { market } of rows as { market: string }[]) {
      const refreshedAt = lastRefreshed.get(market);
      const staleMinutes = refreshedAt === undefined ? null : (now.getTime() - refreshedAt.getTime()) / 60_000;
      if (staleMinutes !== null && staleMinutes <= thresholdMinutes) continue;
      candidates.push({
        type: "market_stale",
        dedupeKey: `market_stale:${market}`,
        detail: { market, staleMinutes, lastRefreshedAt: refreshedAt?.toISOString() ?? null, thresholdMinutes },
      });
    }
    return candidates;
  }
}

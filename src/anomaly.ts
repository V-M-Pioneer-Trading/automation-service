import { Pool } from "pg";
import { AutopilotState } from "./autopilotState";
import { Clock } from "./clock";
import { KnobValues } from "./knobs";
import { MarketIntelRepo } from "./marketIntelRepo";
import { ShipTask } from "./shipTaskRepo";
import { EventLog } from "./eventLog";
import { MetricsRepo } from "./metrics";

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

/** How far back `profit_drop` looks for the history it judges the latest rollup against. */
const PROFIT_TREND_WINDOW_MS = 6 * 60 * 60 * 1000;

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
  async listUndelivered(maxRounds: number, limit: number): Promise<Anomaly[]> {
    const { rows } = await this.pool.query(
      // delivery_attempts counts *rounds* — one per deliver() call, each of
      // which retries internally — not individual HTTP requests.
      `${ANOMALY_SELECT} WHERE delivered_at IS NULL AND delivery_attempts < $1
       ORDER BY detected_at ASC LIMIT $2`,
      [maxRounds, limit]
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
 *
 * It has no `Pool` and no `KnobRepo`. It used to have both, and used them to run
 * six queries against `event_log`, two against `metrics_rollup`, and eight
 * separate reads of the knob table — tables owned by `EventLog`, `MetricsRepo`
 * and `KnobRepo`, whose vocabulary it therefore had to know and keep in step by
 * hand. Those modules answer the questions instead, and the thresholds arrive as
 * one snapshot, so this file contains the *judgement* (what counts as flat,
 * stale, too many) and none of the retrieval.
 */
export class AnomalyChecker {
  constructor(
    private clock: Clock,
    private state: AutopilotState,
    private marketIntel: MarketIntelRepo,
    private events: EventLog,
    private metrics: MetricsRepo
  ) {}

  /**
   * `knobs` is one snapshot, read once by the caller for the whole tick — the
   * same rule `DecisionContext` enforces for the planner, which exists so every
   * arm of a decision scores against one set of numbers.
   *
   * This used to be eight separate reads, two of them inside checks running
   * concurrently, so an operator changing a threshold mid-tick could have one
   * alarm judged against the old value and another against the new one. Worse
   * than a stale reading, because the result is a report of a fleet state that
   * never existed: `error_rate` could fire on a window `errorRateWindowMinutes`
   * long while naming a different length in its own detail.
   */
  async runChecks(shipSymbol: string, task: ShipTask | null, knobs: KnobValues): Promise<AnomalyCandidate[]> {
    const now = this.clock.now();
    const miningActive = this.state.getStatus() === "armed" && this.state.getMode() === "live";

    // Independent reads (different tables), so run them concurrently.
    const [idle, earnings, failures, errorRate, marketStale] = await Promise.all([
      miningActive && task !== null ? this.checkShipIdle(shipSymbol, task, now, knobs) : Promise.resolve(null),
      this.checkEarningsStalled(now, knobs),
      // The sum, not either counter: this check's question is "has this ship
      // stopped getting anywhere", and it does not care whose fault that is.
      this.checkConsecutiveFailures(shipSymbol, (task?.failureCount ?? 0) + (task?.unrelatedFailureCount ?? 0), knobs),
      this.checkErrorRate(now, knobs),
      this.checkMarketStaleness(now, knobs),
    ]);
    return [idle, earnings, failures, errorRate, ...marketStale].filter((c): c is AnomalyCandidate => c !== null);
  }

  /**
   * A ship is idle when nothing has happened to it for too long. Time spent
   * inside a wait it was told to sit through — a flight, a cooldown — is not
   * idleness, so a long transit doesn't page; the clock starts when the wait
   * ends and the row still hasn't moved.
   */
  private async checkShipIdle(shipSymbol: string, task: ShipTask, now: Date, knobs: KnobValues): Promise<AnomalyCandidate | null> {
    const thresholdMinutes = knobs["anomaly.shipIdleMinutes"];
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
  private async checkEarningsStalled(now: Date, knobs: KnobValues): Promise<AnomalyCandidate | null> {
    const readings = await Promise.all([
      this.detectProfitDrop(now, knobs),
      this.detectCreditsFlat(now, knobs),
      this.detectNoEarnings(now, knobs),
    ]);
    const reasons = readings.filter((r): r is Reason => r !== null);
    if (reasons.length === 0) return null;
    return {
      type: "earnings_stalled",
      dedupeKey: "earnings_stalled",
      detail: { reasons: reasons.map((r) => r.reason), ...Object.assign({}, ...reasons.map((r) => r.detail)) },
    };
  }

  private async detectProfitDrop(now: Date, knobs: KnobValues): Promise<Reason | null> {
    const trend = await this.metrics.latestAgainstTrailingAverage(now, PROFIT_TREND_WINDOW_MS);
    if (trend === null) return null;
    if (trend.sampleCount < 2) return null; // not enough history to judge a drop yet
    if (trend.trailingAverage <= 0) return null;

    const fraction = knobs["anomaly.profitDropFraction"];
    if (trend.latest >= trend.trailingAverage * fraction) return null;
    return {
      reason: "profit_drop",
      detail: { latestCreditsPerHour: trend.latest, avg6hCreditsPerHour: trend.trailingAverage, fraction },
    };
  }

  private async detectCreditsFlat(now: Date, knobs: KnobValues): Promise<Reason | null> {
    const windowHours = knobs["anomaly.creditsFlatWindowHours"];
    const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

    const [earliest, baseline, current] = await Promise.all([
      this.events.firstCreditsSnapshotAt(),
      this.events.creditsAt(since),
      this.events.creditsAt(now),
    ]);

    // Require snapshotting to have started before the window, not just within
    // it — otherwise a freshly-armed autopilot looks "flat" on its first tick
    // simply for lack of history, not because credits actually stalled.
    if (earliest === null || earliest > since) return null;
    if (baseline === null || current === null) return null;
    // The baseline being the most recent snapshot overall means no fresh
    // reading has landed since the window opened — "no data", not "flat".
    if (current.id === baseline.id) return null;

    const oldestCredits = baseline.credits;
    const newestCredits = current.credits;
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
  private async detectNoEarnings(now: Date, knobs: KnobValues): Promise<Reason | null> {
    const status = this.state.getStatus();
    if (status !== "armed" && status !== "paused") return null;

    const windowMinutes = knobs["anomaly.noEarningsMinutes"];
    const since = new Date(now.getTime() - windowMinutes * 60_000);

    const [enteredStateAt, earnings] = await Promise.all([
      this.events.lastLifecycleTransitionAt(),
      this.events.earningsBetween(since, now),
    ]);

    // In this state for less than the window: too early to judge.
    if (enteredStateAt === null || enteredStateAt > since) return null;
    if (earnings.count > 0) return null;

    return {
      reason: "no_earnings",
      detail: {
        status,
        windowMinutes,
        lastEarnedAt: earnings.lastEarnedAt?.toISOString() ?? null,
        enteredStateAt: enteredStateAt.toISOString(),
      },
    };
  }

  private async checkConsecutiveFailures(shipSymbol: string, failureCount: number, knobs: KnobValues): Promise<AnomalyCandidate | null> {
    const limit = knobs["anomaly.consecutiveFailureLimit"];
    if (failureCount < limit) return null;
    return { type: "consecutive_failures", dedupeKey: `consecutive_failures:${shipSymbol}`, detail: { shipSymbol, failureCount, limit } };
  }

  private async checkErrorRate(now: Date, knobs: KnobValues): Promise<AnomalyCandidate | null> {
    const windowMinutes = knobs["anomaly.errorRateWindowMinutes"];
    const since = new Date(now.getTime() - windowMinutes * 60_000);
    const { total, errors } = await this.events.taskOutcomesBetween(since, now);
    if (total === 0) return null;
    const rate = errors / total;
    const threshold = knobs["anomaly.errorRateThreshold"];
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
  private async checkMarketStaleness(now: Date, knobs: KnobValues): Promise<AnomalyCandidate[]> {
    const thresholdMinutes = knobs["anomaly.marketStalenessMinutes"];
    const activeSince = new Date(now.getTime() - MARKET_ACTIVE_USE_LOOKBACK_MS);
    const marketsInUse = await this.events.marketsPricedSince(activeSince);
    if (marketsInUse.length === 0) return [];

    const lastRefreshed = new Map((await this.marketIntel.getAll()).map((m) => [m.waypoint, m.lastRefreshedAt]));
    const candidates: AnomalyCandidate[] = [];
    for (const market of marketsInUse) {
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

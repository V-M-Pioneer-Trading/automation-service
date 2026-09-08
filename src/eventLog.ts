import { Pool } from "pg";
import { Clock } from "./clock";
import {
  ACTION_ERROR_PREDICATE,
  CREDITS_SNAPSHOT_TYPE,
  EARNING_EVENT_PREDICATE,
  LIFECYCLE_EVENT_TYPES,
  MARKET_SELECTION_TYPE,
  TASK_EVENT_PREDICATE,
} from "./fleetEvents";

export interface EventLogEntry {
  id: string;
  occurredAt: string;
  type: string;
  detail: Record<string, unknown>;
}

/** What the balance read at one moment, and which row said so. */
export interface CreditsReading {
  id: string;
  credits: number;
}

/** How much of what the fleet did in a window was a failure. */
export interface TaskOutcomes {
  total: number;
  errors: number;
}

/** Whether anything was earned in a window, and when the last of it landed. */
export interface EarningsInWindow {
  count: number;
  lastEarnedAt: Date | null;
}

const ENTRY_SELECT = "SELECT id, occurred_at, type, detail FROM event_log";
const NEWEST_FIRST = "ORDER BY occurred_at DESC, id DESC";

/**
 * Append-only audit trail of autopilot lifecycle events. Never pass a token or
 * anything token-shaped as `detail` — this is the one thing in the system that
 * outlives a restart and is meant to be read back through the API.
 *
 * It also answers the questions other modules ask *of* the log, rather than
 * handing out the table. `AnomalyChecker` used to issue six of its own queries
 * against `event_log` — reaching past this class into rows it does not own, and
 * spelling out the event vocabulary a seventh and eighth time. The methods
 * below are those questions, phrased the way the caller means them: what did
 * the balance read, what did the operator last say they wanted, what did the
 * fleet earn, how much of what it did failed, which markets is it pricing
 * against. The vocabulary itself still lives in `fleetEvents.ts`.
 */
export class EventLog {
  constructor(private pool: Pool, private clock: Clock) {}

  async append(type: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query("INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, $2, $3)", [
      this.clock.now(),
      type,
      detail,
    ]);
  }

  async list(limit = 100): Promise<EventLogEntry[]> {
    const { rows } = await this.pool.query(`${ENTRY_SELECT} ${NEWEST_FIRST} LIMIT $1`, [limit]);
    return rows.map(rowToEntry);
  }

  /** Events at or after `since`, newest first, optionally restricted to `types`. */
  async listSince(since: Date, limit: number, types?: string[]): Promise<EventLogEntry[]> {
    const { rows } = await this.pool.query(
      `${ENTRY_SELECT}
       WHERE occurred_at >= $1 AND ($2::text[] IS NULL OR type = ANY($2::text[]))
       ${NEWEST_FIRST} LIMIT $3`,
      [since, types ?? null, limit]
    );
    return rows.map(rowToEntry);
  }

  /**
   * What the agent's balance read at the last snapshot taken at or before `at`.
   *
   * "At or before", not "inside a window": snapshotting is intermittent in
   * production and jumps discretely under a `FakeClock`, so a window can easily
   * contain no snapshot at all while the balance either side of it is known
   * perfectly well.
   */
  async creditsAt(at: Date): Promise<CreditsReading | null> {
    const { rows } = await this.pool.query(
      `SELECT id, detail FROM event_log WHERE type = $1 AND occurred_at <= $2 ${NEWEST_FIRST} LIMIT 1`,
      [CREDITS_SNAPSHOT_TYPE, at]
    );
    if (rows.length === 0) return null;
    return { id: String(rows[0].id), credits: Number((rows[0].detail as { credits: number }).credits) };
  }

  /**
   * When the fleet first started recording its balance at all — the answer to
   * "do we have enough history to say the balance is flat, or have we simply
   * not been watching long enough?"
   */
  async firstCreditsSnapshotAt(): Promise<Date | null> {
    const { rows } = await this.pool.query(`SELECT MIN(occurred_at) AS earliest FROM event_log WHERE type = $1`, [
      CREDITS_SNAPSHOT_TYPE,
    ]);
    return rows[0].earliest === null ? null : new Date(rows[0].earliest);
  }

  /**
   * When the operator last said what they wanted — armed, paused or aborted.
   * A check that judges a fleet against its stated intent measures from here,
   * so a freshly armed fleet gets a full window before it is called stalled.
   */
  async lastLifecycleTransitionAt(): Promise<Date | null> {
    const { rows } = await this.pool.query(
      `SELECT occurred_at FROM event_log WHERE type = ANY($1::text[]) ${NEWEST_FIRST} LIMIT 1`,
      [LIFECYCLE_EVENT_TYPES]
    );
    return rows.length === 0 ? null : new Date(rows[0].occurred_at);
  }

  /** What the fleet earned between two instants — every way it can earn, not just sells. */
  async earningsBetween(since: Date, until: Date): Promise<EarningsInWindow> {
    const { rows } = await this.pool.query(
      `SELECT MAX(occurred_at) AS last_earned, COUNT(*) AS earnings FROM event_log
       WHERE ${EARNING_EVENT_PREDICATE} AND occurred_at >= $1 AND occurred_at <= $2`,
      [since, until]
    );
    return { count: Number(rows[0].earnings), lastEarnedAt: (rows[0].last_earned as Date | null) ?? null };
  }

  /**
   * How many ship-task events happened between two instants and how many of
   * them were failures — the numerator and denominator of the error rate, read
   * from the same rows so they cannot describe different populations.
   */
  async taskOutcomesBetween(since: Date, until: Date): Promise<TaskOutcomes> {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${TASK_EVENT_PREDICATE}) AS total,
         COUNT(*) FILTER (WHERE ${ACTION_ERROR_PREDICATE}) AS errors
       FROM event_log WHERE occurred_at >= $1 AND occurred_at <= $2`,
      [since, until]
    );
    return { total: Number(rows[0].total), errors: Number(rows[0].errors) };
  }

  /**
   * Every market the fleet priced a sell against since `since` — "which markets
   * are actually in use", as distinct from every market that exists. A read
   * from afar counts: pricing a decision on a stale quote is the thing worth
   * knowing about, whether or not a ship ever docked there.
   */
  async marketsPricedSince(since: Date): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT jsonb_array_elements_text(COALESCE(detail->'marketsChecked', '[]'::jsonb)) AS market
       FROM event_log WHERE type = $1 AND occurred_at >= $2`,
      [MARKET_SELECTION_TYPE, since]
    );
    return (rows as { market: string }[]).map((r) => r.market);
  }
}

function rowToEntry(row: { id: string | number; occurred_at: Date; type: string; detail: Record<string, unknown> }): EventLogEntry {
  return {
    id: String(row.id),
    occurredAt: row.occurred_at.toISOString(),
    type: row.type,
    detail: row.detail,
  };
}

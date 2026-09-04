import { Pool } from "pg";
import { Clock } from "./clock";

export interface EventLogEntry {
  id: string;
  occurredAt: string;
  type: string;
  detail: Record<string, unknown>;
}

const ENTRY_SELECT = "SELECT id, occurred_at, type, detail FROM event_log";
const NEWEST_FIRST = "ORDER BY occurred_at DESC, id DESC";

/**
 * Append-only audit trail of autopilot lifecycle events. Never pass a token or
 * anything token-shaped as `detail` — this is the one thing in the system that
 * outlives a restart and is meant to be read back through the API.
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
}

function rowToEntry(row: { id: string | number; occurred_at: Date; type: string; detail: Record<string, unknown> }): EventLogEntry {
  return {
    id: String(row.id),
    occurredAt: row.occurred_at.toISOString(),
    type: row.type,
    detail: row.detail,
  };
}

import { Pool } from "pg";
import { Clock } from "./clock";

export interface EventLogEntry {
  id: string;
  occurredAt: string;
  type: string;
  detail: Record<string, unknown>;
}

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
    const { rows } = await this.pool.query(
      "SELECT id, occurred_at, type, detail FROM event_log ORDER BY occurred_at DESC, id DESC LIMIT $1",
      [limit]
    );
    return rows.map((row) => ({
      id: String(row.id),
      occurredAt: row.occurred_at.toISOString(),
      type: row.type,
      detail: row.detail,
    }));
  }
}

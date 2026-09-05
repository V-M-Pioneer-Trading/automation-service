import { Pool, PoolClient } from "pg";
import { createHash } from "crypto";

/**
 * Makes "only one process drives this ship" true across processes, not just
 * within one.
 *
 * The scheduler's own re-entrancy guard is an in-memory boolean: it stops one
 * process overlapping itself and does nothing about a second replica. Both
 * would read the same `MINING_SHIP_SYMBOL`, both would drive it, and two
 * schedulers reaching `CONTRACT_PURCHASE` in the same window each dispatch a
 * purchase — the agent buys twice the goods for twice the credits, while the
 * reserve-floor check that cleared the trip only ever accounted for one of
 * them. The same shape applies to delivering and selling. Until now the only
 * thing bounding that was the deployment happening to be single-instance, and
 * nothing in the code would have told you if that changed.
 *
 * A Postgres session-level advisory lock is the right tool: it is held by a
 * connection rather than a row, so it is released automatically if the process
 * dies or the connection drops — a crashed replica cannot wedge the fleet the
 * way a lease row with an expiry would. The connection is checked out of the
 * pool for as long as the lock is held, which is why this owns a client rather
 * than borrowing one per query.
 */
export class DispatchLock {
  private client: PoolClient | null = null;

  constructor(private readonly pool: Pool, private readonly key: string) {}

  /** Postgres advisory locks are keyed by bigint, so the ship symbol is hashed into one. */
  private lockKey(): string {
    // Signed 64-bit range: take 63 bits and let Postgres read it as positive.
    const digest = createHash("sha1").update(this.key).digest();
    return (digest.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
  }

  get held(): boolean {
    return this.client !== null;
  }

  /**
   * True once this process holds the lock. Already holding it is a pass, so a
   * caller can call this every tick. False means another process holds it —
   * the caller should do nothing this tick and try again on the next one,
   * which is what makes a second replica a warm standby rather than a rival.
   */
  async acquire(): Promise<boolean> {
    if (this.client !== null) return true;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [this.lockKey()]);
      if (rows[0]?.locked !== true) {
        client.release();
        return false;
      }
      this.client = client;
      return true;
    } catch (err) {
      client.release();
      throw err;
    }
  }

  /** Releases the lock and returns the connection. Safe to call when it was never held. */
  async release(): Promise<void> {
    const client = this.client;
    if (client === null) return;
    this.client = null;
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [this.lockKey()]);
    } catch {
      // Releasing the connection drops the session and with it the lock, so a
      // failure to unlock cleanly is not worth failing a shutdown over.
    } finally {
      client.release();
    }
  }
}

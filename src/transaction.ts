import { Pool, PoolClient } from "pg";

/**
 * Runs fn against a single checked-out client inside a BEGIN/COMMIT block,
 * rolling back on any error. Callers pass the client into repo methods (which
 * accept Pool | PoolClient) so writes across different repos land in one
 * transaction instead of as separate autocommitted statements (meta#30).
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors so we don't mask the original failure.
    }
    throw err;
  }
  } finally {
    client.release();
  }
}

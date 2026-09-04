import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../transaction";

/**
 * `withTransaction` is the only thing standing between a half-applied pair of
 * writes and a corrupt state (meta#30), and it runs on the ship-dispatch path,
 * so its failure handling is worth pinning directly. No database needed: a
 * fake client records the statements and can be told which one to fail.
 */

const fakeClient = (fail: (sql: string) => boolean = () => false) => {
  const statements: string[] = [];
  let released = 0;
  const client = {
    query: jest.fn((sql: string) => {
      statements.push(sql);
      return fail(sql) ? Promise.reject(new Error(`${sql} failed`)) : Promise.resolve({ rows: [] });
    }),
    release: jest.fn(() => {
      released += 1;
    }),
  };
  return { client, statements, releases: () => released };
};

const poolOf = (client: unknown): Pool => ({ connect: async () => client as PoolClient }) as unknown as Pool;

describe("withTransaction", () => {
  it("commits and returns the callback's value, releasing the client", async () => {
    const { client, statements, releases } = fakeClient();
    const result = await withTransaction(poolOf(client), async () => "done");

    expect(result).toBe("done");
    expect(statements).toEqual(["BEGIN", "COMMIT"]);
    expect(releases()).toBe(1);
  });

  it("rolls back and rethrows when the callback fails", async () => {
    const { client, statements, releases } = fakeClient();
    await expect(
      withTransaction(poolOf(client), async () => {
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");

    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(releases()).toBe(1);
  });

  /**
   * A ROLLBACK can itself fail — the connection may already be broken, or no
   * transaction was ever opened because BEGIN was what failed. Surfacing that
   * error would replace the real cause with a misleading one, so it is
   * swallowed and the original always wins.
   */
  it("rethrows the original failure even when the rollback also fails", async () => {
    const { client, releases } = fakeClient((sql) => sql === "ROLLBACK");
    await expect(
      withTransaction(poolOf(client), async () => {
        throw new Error("the real cause");
      })
    ).rejects.toThrow("the real cause");

    expect(releases()).toBe(1);
  });

  it("does not mask a failing BEGIN with the rollback that follows it", async () => {
    const { client, releases } = fakeClient((sql) => sql === "BEGIN" || sql === "ROLLBACK");
    await expect(withTransaction(poolOf(client), async () => "unreachable")).rejects.toThrow("BEGIN failed");

    expect(releases()).toBe(1); // the client goes back to the pool either way
  });
});

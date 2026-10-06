import type { Pool, PoolClient } from "pg";

/**
 * Wraps a real Pool so exactly one query matching `shouldFail` rejects
 * (both direct pool.query calls and queries run on a connect()ed client, so
 * it also intercepts inside withTransaction's BEGIN/COMMIT block) — simulates
 * the transient DB failure meta#28/#30 guard against, without needing to
 * actually break Postgres.
 */
type LooseFn = (...args: unknown[]) => unknown;

export function makeFlakyPool(
  pool: Pool,
  shouldFail: (sql: string) => boolean,
  error: () => Error = () => new Error("simulated transient DB failure")
): Pool {
  let failed = false;
  const flakyQuery = (originalQuery: LooseFn) => {
    return (...args: unknown[]) => {
      const sql = args[0];
      if (!failed && typeof sql === "string" && shouldFail(sql)) {
        failed = true;
        return Promise.reject(error());
      }
      return originalQuery(...args);
    };
  };

  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") return flakyQuery(target.query.bind(target));
      if (prop === "connect") {
        return async (...args: unknown[]) => {
          const client = await (target.connect.bind(target) as unknown as (...a: unknown[]) => Promise<PoolClient>)(...args);
          return new Proxy(client, {
            get(ctarget, cprop, creceiver) {
              if (cprop === "query") return flakyQuery(ctarget.query.bind(ctarget));
              return Reflect.get(ctarget, cprop, creceiver) as unknown;
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

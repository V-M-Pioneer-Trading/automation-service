import { Pool } from "pg";
import { createPool } from "../db";
import { DispatchLock } from "../dispatchLock";

/**
 * The scheduler's own re-entrancy guard is an in-memory boolean: it stops one
 * process overlapping itself and says nothing about a second replica. Two
 * replicas both driving one ship each dispatch their own purchase, and the
 * reserve-floor check that cleared the trip only accounted for one of them.
 */
describe("DispatchLock", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("lets exactly one holder in, and hands over once it is released", async () => {
    const first = new DispatchLock(pool, "dispatch:SHIP-1");
    const second = new DispatchLock(pool, "dispatch:SHIP-1");

    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false); // the standby replica
    expect(second.held).toBe(false);

    // Re-acquiring is a pass, so a holder can call this every tick.
    expect(await first.acquire()).toBe(true);

    await first.release();
    expect(await second.acquire()).toBe(true); // the standby takes over
    await second.release();
  });

  it("does not make two different ships wait on each other", async () => {
    const one = new DispatchLock(pool, "dispatch:SHIP-1");
    const two = new DispatchLock(pool, "dispatch:SHIP-2");

    expect(await one.acquire()).toBe(true);
    expect(await two.acquire()).toBe(true);

    await Promise.all([one.release(), two.release()]);
  });

  it("is safe to release when it was never held", async () => {
    const lock = new DispatchLock(pool, "dispatch:SHIP-3");
    await expect(lock.release()).resolves.toBeUndefined();
    expect(lock.held).toBe(false);
  });

  /**
   * The lock is session-level rather than a lease row with an expiry, so a
   * process that dies releases it instead of wedging the fleet until a
   * timeout none of its survivors can shorten. That behaviour is Postgres's
   * own and is not re-tested here; what is worth pinning is the consequence
   * for shutdown, since the lock holds a pooled connection checked out.
   */
  it("returns its connection to the pool on release, so a shutdown can drain", async () => {
    const lock = new DispatchLock(pool, "dispatch:SHIP-4");
    expect(await lock.acquire()).toBe(true);
    await lock.release();

    // With the connection still checked out, `pool.end()` would wait on it
    // forever — which is why FleetScheduler.stop() releases the lock rather
    // than leaving it to process exit.
    const drained = createPool(process.env.DATABASE_URL!);
    const short = new DispatchLock(drained, "dispatch:SHIP-5");
    await short.acquire();
    await short.release();
    await expect(drained.end()).resolves.toBeUndefined();
  });
});

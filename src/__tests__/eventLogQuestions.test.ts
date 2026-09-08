import { Pool } from "pg";
import { createPool, migrate } from "../db";
import { EventLog } from "../eventLog";
import { FakeClock } from "../testSupport/fakeClock";
import { resetDatabase } from "../testSupport/resetDatabase";

/**
 * The questions `AnomalyChecker` asks of the event log.
 *
 * It used to ask them in its own SQL, against a table `EventLog` owns, spelling
 * out the event vocabulary a second time on the way. These are the same
 * questions phrased as methods — so what is pinned here is the *semantics* the
 * checks depend on, not the SQL: "at or before", not "inside the window"; the
 * numerator and denominator of the error rate read from one pass over the same
 * rows; earnings that count contract payments and not only sells.
 */

const T0 = new Date("2026-01-01T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("what the event log can be asked", () => {
  let pool: Pool;
  let clock: FakeClock;
  let events: EventLog;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FakeClock(T0);
    events = new EventLog(pool, clock);
  });

  /** Appends at a chosen time, since these questions are all about ordering. */
  const appendAt = async (minutes: number, type: string, detail: Record<string, unknown> = {}) => {
    clock.advance(at(minutes).getTime() - clock.now().getTime());
    await events.append(type, detail);
  };

  describe("credits", () => {
    it("reads the last snapshot at or before the instant asked about", async () => {
      await appendAt(0, "agent_credits_snapshot", { credits: 100 });
      await appendAt(10, "agent_credits_snapshot", { credits: 200 });
      await appendAt(30, "agent_credits_snapshot", { credits: 300 });

      // Nothing was snapshotted at minute 20. Real polling is intermittent and
      // a FakeClock jumps discretely, so "inside this window" would find
      // nothing and read as "credits are flat" for want of a reading.
      expect((await events.creditsAt(at(20)))?.credits).toBe(200);
      expect((await events.creditsAt(at(30)))?.credits).toBe(300);
    });

    it("has no answer before the fleet started watching", async () => {
      await appendAt(10, "agent_credits_snapshot", { credits: 100 });
      expect(await events.creditsAt(at(5))).toBeNull();
    });

    it("says when it started watching, so short history is not mistaken for a flat balance", async () => {
      expect(await events.firstCreditsSnapshotAt()).toBeNull();
      await appendAt(10, "agent_credits_snapshot", { credits: 100 });
      await appendAt(20, "agent_credits_snapshot", { credits: 100 });
      expect(await events.firstCreditsSnapshotAt()).toEqual(at(10));
    });
  });

  describe("what the operator last said they wanted", () => {
    it("is the most recent lifecycle transition, not the most recent event", async () => {
      await appendAt(0, "armed");
      await appendAt(5, "mining_sell", { totalPrice: 500 });
      await appendAt(10, "paused");
      await appendAt(15, "mining_extract", { units: 3 });

      expect(await events.lastLifecycleTransitionAt()).toEqual(at(10));
    });

    it("is null for a fleet that has never been armed", async () => {
      await appendAt(0, "mining_sell", { totalPrice: 500 });
      expect(await events.lastLifecycleTransitionAt()).toBeNull();
    });
  });

  describe("earnings in a window", () => {
    it("counts every way the fleet earns, not just sells", async () => {
      await appendAt(1, "mining_sell", { totalPrice: 500 });
      await appendAt(2, "contract_accepted", { payment: 1000 });
      await appendAt(3, "contract_fulfilled", { payment: 4000 });
      // Progress, not income — a fleet doing only this has earned nothing.
      await appendAt(4, "mining_extract", { units: 3 });

      const earnings = await events.earningsBetween(at(0), at(10));
      expect(earnings.count).toBe(3);
      expect(earnings.lastEarnedAt).toEqual(at(3));
    });

    it("includes both ends of the window", async () => {
      // The bounds are inclusive, and a check that pages on "nothing earned
      // all window" must not be able to miss an earning that landed exactly on
      // an edge — least of all the one at `now`, which is every tick.
      await appendAt(0, "mining_sell", { totalPrice: 100 });
      await appendAt(10, "mining_sell", { totalPrice: 100 });
      await appendAt(11, "mining_sell", { totalPrice: 100 }); // outside

      const earnings = await events.earningsBetween(at(0), at(10));
      expect(earnings.count).toBe(2);
      expect(earnings.lastEarnedAt).toEqual(at(10));
    });

    it("reports nothing earned as zero rather than as no data", async () => {
      await appendAt(1, "mining_extract", { units: 3 });
      const earnings = await events.earningsBetween(at(0), at(10));
      expect(earnings.count).toBe(0);
      expect(earnings.lastEarnedAt).toBeNull();
    });
  });

  describe("task outcomes in a window", () => {
    it("counts errors against every task kind's events, not mining's alone", async () => {
      // The drift this replaced: a contract-only window counted contract errors
      // against a denominator of mining events, and read as a 100% error rate.
      await appendAt(1, "contract_travel", {});
      await appendAt(2, "contract_purchase", {});
      await appendAt(3, "scout_refresh", {});
      await appendAt(4, "mining_tick_error", {});
      await appendAt(5, "anomaly_recorded", {}); // not a task event at all

      const { total, errors } = await events.taskOutcomesBetween(at(0), at(10));
      expect(total).toBe(4);
      expect(errors).toBe(1);
    });

    it("ignores what happened outside the window, and includes both of its ends", async () => {
      await appendAt(9, "mining_tick_error", {}); // before
      await appendAt(10, "mining_tick_error", {}); // exactly at `since`
      await appendAt(40, "mining_extract", { units: 1 }); // exactly at `until`
      await appendAt(41, "mining_extract", { units: 1 }); // after

      const { total, errors } = await events.taskOutcomesBetween(at(10), at(40));
      expect(total).toBe(2);
      expect(errors).toBe(1);
    });
  });

  describe("markets in active use", () => {
    it("is every market a sell leg priced, deduplicated, from the lookback edge inclusive", async () => {
      await appendAt(0, "mining_market_selected", { marketsChecked: ["X1-A", "X1-B"] }); // exactly at `since`
      await appendAt(2, "mining_market_selected", { marketsChecked: ["X1-B", "X1-C"] });
      await appendAt(3, "mining_sell", { totalPrice: 10 }); // says nothing about markets

      expect((await events.marketsPricedSince(at(0))).sort()).toEqual(["X1-A", "X1-B", "X1-C"]);
    });

    it("does not reach back past the lookback", async () => {
      await appendAt(0, "mining_market_selected", { marketsChecked: ["X1-OLD"] });
      await appendAt(5, "mining_market_selected", { marketsChecked: ["X1-NEW"] });
      expect(await events.marketsPricedSince(at(1))).toEqual(["X1-NEW"]);
    });

    it("treats a selection that priced nothing as no markets rather than an error", async () => {
      await appendAt(1, "mining_market_selected", { shipSymbol: "MINING-1" });
      expect(await events.marketsPricedSince(at(0))).toEqual([]);
    });
  });
});

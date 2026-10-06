import type { Pool } from "pg";
import { AnomalyRepo } from "../anomaly";
import type { Anomaly, AnomalyCandidate, AnomalyChecker } from "../anomaly";
import { AnomalyScheduler } from "../anomalyScheduler";
import { AutopilotState } from "../autopilotState";
import { createPool, migrate } from "../db";
import { EventLog } from "../eventLog";
import { KnobRepo } from "../knobs";
import { ShipTaskRepo } from "../shipTaskRepo";
import { WebhookDelivery, type DeliveryResult } from "../webhookDelivery";
import { redeliveryWindowMs } from "../anomalyScheduler";
import { databaseUrl } from "../testSupport/databaseUrl";
import { fakeGameClients } from "../testSupport/fakeGameClients";
import { FakeClock } from "../testSupport/fakeClock";
import { resetDatabase } from "../testSupport/resetDatabase";

/**
 * `AnomalyScheduler.stop()` promises that nothing it owns acts afterwards. Each
 * `isStopped()` check in the tick guards one await boundary where stop() can
 * land; this file lands stop() at each of them, in turn, by holding that one
 * await open on a gate, and then asserts the *next* step never happens.
 *
 * The real repos run against the test Postgres, so "no events / no anomalies"
 * is read from the tables, not from a spy. The checker, the game clients and
 * the webhook are the seams a tick blocks on, so those are the gated fakes.
 *
 * Some guards overlap (the one after `runChecks` and the one at the top of the
 * candidate loop both stop a first candidate from being recorded), so a test
 * is written to isolate each guard by its *own* observable: a read that
 * would only happen if that guard were missing.
 */

interface Gate {
  /** Resolves when the gated call has been reached. */
  entered: Promise<void>;
  /** Called by the gated call: signals `entered`, then waits for `release()`. */
  hold: () => Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const released = new Promise<void>((r) => {
    release = r;
  });
  return {
    entered,
    hold: () => {
      enter();
      return released;
    },
    release,
  };
}

const DELIVERED: DeliveryResult = { delivered: true, rateLimited: false };
const RATE_LIMITED: DeliveryResult = { delivered: false, rateLimited: true };

const candidate = (n: number): AnomalyCandidate => ({ type: "test_anomaly", dedupeKey: `test:${String(n)}`, detail: { n } });

describe("anomaly scheduler stop guards", () => {
  let pool: Pool;
  let clock: FakeClock;
  let state: AutopilotState;
  let repo: AnomalyRepo;
  let events: EventLog;
  let candidates: AnomalyCandidate[];
  let runChecks: jest.Mock<Promise<AnomalyCandidate[]>, []>;
  let getAgent: jest.Mock<Promise<{ credits: number }>, []>;
  let deliver: jest.Mock<Promise<DeliveryResult>, [Anomaly, AbortSignal?]>;
  let schedulers: AnomalyScheduler[];
  let onAnomalyRecorded: jest.Mock;

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    state = new AutopilotState();
    repo = new AnomalyRepo(pool, clock);
    events = new EventLog(pool, clock);
    candidates = [];
    runChecks = jest.fn(() => Promise.resolve(candidates));
    getAgent = jest.fn(() => Promise.resolve({ credits: 1234 }));
    deliver = jest.fn<Promise<DeliveryResult>, [Anomaly, AbortSignal?]>(() => Promise.resolve(DELIVERED));
    schedulers = [];
    onAnomalyRecorded = jest.fn();
  });

  afterEach(async () => {
    await Promise.all(schedulers.map((s) => s.stop()));
    jest.restoreAllMocks();
  });

  const build = (opts: { webhook?: boolean | WebhookDelivery; intervalMs?: number } = {}): AnomalyScheduler => {
    const scheduler = new AnomalyScheduler({
      state,
      repo,
      checker: { runChecks } as unknown as AnomalyChecker,
      webhook: opts.webhook === false ? null : opts.webhook instanceof WebhookDelivery ? opts.webhook : ({ deliver } as unknown as WebhookDelivery),
      events,
      clock,
      knobs: new KnobRepo(pool),
      tasks: new ShipTaskRepo(pool, clock),
      gameClients: fakeGameClients({ getAgent }),
      shipSymbol: "SHIP-1",
      onAnomalyRecorded,
      // Long enough never to fire unless a test asks: ticks are driven by forceTick.
      intervalMs: opts.intervalMs ?? 3_600_000,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  /** Runs one tick, lands stop() while it is parked on `g`, lets it go, and waits for everything to drain. */
  async function stopWhileHeldAt(scheduler: AnomalyScheduler, g: Gate): Promise<void> {
    const tick = scheduler.forceTick();
    await g.entered;
    const stopping = scheduler.stop();
    g.release();
    await Promise.all([tick, stopping]);
  }

  const eventTypes = async (): Promise<string[]> => (await events.list(100)).map((e) => e.type);
  const anomalyCount = async (): Promise<number> =>
    Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM anomaly")).rows[0].n);

  describe("credits snapshot", () => {
    beforeEach(() => {
      state.arm("live");
    });

    it("sanity: an unstopped tick does append a snapshot and run the checks", async () => {
      const scheduler = build();
      await scheduler.forceTick();
      expect(await eventTypes()).toEqual(["agent_credits_snapshot"]);
      expect(runChecks).toHaveBeenCalledTimes(1);
    });

    it("stop() during the agent read: no snapshot is appended, and the checks never run", async () => {
      const g = gate();
      getAgent.mockImplementation(async () => {
        await g.hold();
        return { credits: 1234 };
      });
      await stopWhileHeldAt(build(), g);

      // The guard inside maybeSnapshotCredits.
      expect(await eventTypes()).toEqual([]);
      // The guard right after it in tick(): a stopped tick reads and writes nothing further.
      expect(runChecks).not.toHaveBeenCalled();
    });
  });

  describe("anomaly recording", () => {
    it("stop() during runChecks with candidates: nothing is recorded, delivered or redelivered", async () => {
      candidates = [candidate(1), candidate(2)];
      const g = gate();
      runChecks.mockImplementation(async () => {
        await g.hold();
        return candidates;
      });
      const latestForKey = jest.spyOn(repo, "latestForKey");
      await stopWhileHeldAt(build(), g);

      expect(await anomalyCount()).toBe(0);
      expect(latestForKey).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });

    it("stop() during runChecks with no candidates: the redelivery pass is skipped too", async () => {
      // Only the post-runChecks guard stands between this tick and the backlog
      // query; the loop guards are never reached with nothing to loop over.
      await repo.record(candidate(1));
      const g = gate();
      runChecks.mockImplementation(async () => {
        await g.hold();
        return [];
      });
      const listUndelivered = jest.spyOn(repo, "listUndelivered");
      await stopWhileHeldAt(build(), g);

      expect(listUndelivered).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });

    it("stop() between two candidates: the second is neither looked up nor recorded", async () => {
      candidates = [candidate(1), candidate(2)];
      const g = gate();
      // Park inside the first candidate's delivery, i.e. after its record().
      deliver.mockImplementation(async () => {
        await g.hold();
        return DELIVERED;
      });
      const latestForKey = jest.spyOn(repo, "latestForKey");
      await stopWhileHeldAt(build(), g);

      expect(await anomalyCount()).toBe(1);
      // Only the loop-top guard prevents the second candidate's lookup.
      expect(latestForKey).toHaveBeenCalledTimes(1);
    });

    it("stop() during the dedupe lookup: that candidate is not recorded", async () => {
      candidates = [candidate(1)];
      const g = gate();
      const original = repo.latestForKey.bind(repo);
      jest.spyOn(repo, "latestForKey").mockImplementation(async (key) => {
        const recent = await original(key);
        await g.hold();
        return recent;
      });
      const record = jest.spyOn(repo, "record");
      await stopWhileHeldAt(build(), g);

      expect(record).not.toHaveBeenCalled();
      expect(await anomalyCount()).toBe(0);
      expect(deliver).not.toHaveBeenCalled();
    });

    it("stop() during record(): the row stays, but no webhook and no replan request", async () => {
      candidates = [candidate(1)];
      const g = gate();
      const original = repo.record.bind(repo);
      jest.spyOn(repo, "record").mockImplementation(async (c) => {
        const anomaly = await original(c);
        await g.hold();
        return anomaly;
      });
      await stopWhileHeldAt(build(), g);

      expect(await anomalyCount()).toBe(1);
      expect(deliver).not.toHaveBeenCalled();
      // A stopped scheduler must not ask the fleet scheduler to replan.
      expect(onAnomalyRecorded).not.toHaveBeenCalled();
    });

    it("sanity: an unstopped tick that records an anomaly requests a replan", async () => {
      candidates = [candidate(1)];
      await build().forceTick();
      expect(onAnomalyRecorded).toHaveBeenCalledTimes(1);
    });
  });

  describe("redelivery", () => {
    it("stop() during one redelivery: the rest of the backlog is not attempted", async () => {
      await repo.record(candidate(1));
      await repo.record(candidate(2));
      const g = gate();
      deliver.mockImplementation(async () => {
        await g.hold();
        return DELIVERED;
      });
      await stopWhileHeldAt(build(), g);

      expect(deliver).toHaveBeenCalledTimes(1);
    });

    /**
     * #47 review: a 429 means the chat service is rate-limiting us. The rest of
     * the batch would collect more 429s (and spend their rounds), so it waits
     * for the next tick.
     */
    it("after a 429 the rest of the batch waits for the next tick", async () => {
      await repo.record(candidate(1));
      await repo.record(candidate(2));
      await repo.record(candidate(3));
      deliver.mockResolvedValueOnce(RATE_LIMITED);
      const scheduler = build();

      await scheduler.forceTick();
      expect(deliver).toHaveBeenCalledTimes(1);

      await scheduler.forceTick();
      expect(deliver).toHaveBeenCalledTimes(4); // all three, the rate-limited one included
    });

    it("a fresh anomaly rate-limited mid-tick ends the tick's sending, redelivery included", async () => {
      await repo.record(candidate(9)); // backlog
      candidates = [candidate(1), candidate(2)];
      deliver.mockResolvedValueOnce(RATE_LIMITED);
      await build().forceTick();

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await anomalyCount()).toBe(3); // the second fresh one is still recorded
    });

    /**
     * #47 review: two capped Retry-After sleeps are 10 s, past the 8 s shutdown
     * deadline, after which closing the server and the pool is skipped. stop()
     * must wake the sleep and end the round. A real WebhookDelivery, real timers.
     */
    it("stop() during a Retry-After sleep returns promptly and spends no round", async () => {
      let posts = 0;
      let posted!: () => void;
      const firstPost = new Promise<void>((r) => {
        posted = r;
      });
      jest.spyOn(globalThis, "fetch").mockImplementation(() => {
        posts++;
        posted();
        return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "5" } }));
      });
      const recorded = await repo.record(candidate(1));
      const scheduler = build({ webhook: new WebhookDelivery({ url: "http://hook.test/x", format: "discord" }) });

      const tick = scheduler.forceTick();
      await firstPost;
      await new Promise((r) => setTimeout(r, 50)); // now inside the Retry-After sleep
      const started = Date.now();
      await scheduler.stop();
      await tick;

      expect(Date.now() - started).toBeLessThan(1000);
      expect(posts).toBe(1);
      const { rows } = await pool.query<{ delivery_attempts: number }>("SELECT delivery_attempts FROM anomaly WHERE id = $1", [recorded.id]);
      expect(rows[0].delivery_attempts).toBe(0);
    });
  });

  /**
   * start() right after an un-awaited stop() clears the loop's stop flag while
   * the old tick's cut round is still returning. That tick must keep its own,
   * aborted signal: not count the cut round, and not hand the rest of its
   * batch the new scheduler's live signal.
   */
  it("a start() racing an un-awaited stop() neither counts the cut round nor revives the old tick", async () => {
    const first = await repo.record(candidate(1));
    const second = await repo.record(candidate(2));
    const g = gate();
    deliver.mockImplementationOnce(async () => {
      await g.hold();
      return { delivered: false, rateLimited: false };
    });
    deliver.mockImplementation(() => Promise.resolve({ delivered: false, rateLimited: false }));
    const scheduler = build();

    const tick = scheduler.forceTick();
    await g.entered;
    const stopping = scheduler.stop();
    scheduler.start();
    g.release();
    await Promise.all([tick, stopping]);

    expect(deliver.mock.calls.length).toBeGreaterThan(0);
    expect(deliver.mock.calls.every(([, signal]) => signal?.aborted === true)).toBe(true);
    const { rows } = await pool.query<{ delivery_attempts: number }>("SELECT delivery_attempts FROM anomaly WHERE id = ANY($1) ORDER BY id", [
      [first.id, second.id],
    ]);
    expect(rows.map((r) => r.delivery_attempts)).toEqual([0, 0]);
  });

  describe("redelivery window", () => {
    it("is an hour at the default interval, and always fits every delivery round twice", () => {
      expect(redeliveryWindowMs(60_000)).toBe(60 * 60 * 1000);
      expect(redeliveryWindowMs(600_000)).toBe(12 * 600_000 * 2);
    });
  });

  describe("scheduling", () => {
    // Only the interval is faked, so `advanceTimersByTime` is the one thing that
    // can fire the loop; Postgres and the gates keep their real timers. A tick's
    // synchronous prefix calls getAgent, so a call count says "a tick started"
    // without waiting for the tick to finish.
    beforeEach(() => {
      state.arm("live");
      jest.useFakeTimers({
        doNotFake: [
          "Date",
          "hrtime",
          "nextTick",
          "performance",
          "queueMicrotask",
          "requestAnimationFrame",
          "cancelAnimationFrame",
          "requestIdleCallback",
          "cancelIdleCallback",
          "setImmediate",
          "clearImmediate",
          "setTimeout",
          "clearTimeout",
        ],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("sanity: a started scheduler ticks on its interval", () => {
      build({ intervalMs: 10 }).start();
      jest.advanceTimersByTime(10);
      expect(getAgent).toHaveBeenCalledTimes(1);
    });

    it("after stop() no further tick is scheduled", async () => {
      const scheduler = build({ intervalMs: 10 });
      scheduler.start();
      jest.advanceTimersByTime(10);
      await scheduler.stop();
      expect(getAgent).toHaveBeenCalledTimes(1);
      // The interval is the only fake timer in play, so none may be left pending.
      expect(jest.getTimerCount()).toBe(0);

      jest.advanceTimersByTime(1000);
      expect(getAgent).toHaveBeenCalledTimes(1);
    });

    it("a tick in flight when stop() landed is the last one, and is itself inert", async () => {
      const g = gate();
      getAgent.mockImplementationOnce(async () => {
        await g.hold();
        return { credits: 1234 };
      });
      const scheduler = build({ intervalMs: 10 });
      scheduler.start();
      jest.advanceTimersByTime(10);
      await g.entered;
      const stopping = scheduler.stop();
      // Intervals elapse while the in-flight tick is still parked.
      jest.advanceTimersByTime(1000);
      g.release();
      await stopping;
      jest.advanceTimersByTime(1000);

      expect(getAgent).toHaveBeenCalledTimes(1);
      expect(runChecks).not.toHaveBeenCalled();
      expect(await eventTypes()).toEqual([]);
    });
  });
});

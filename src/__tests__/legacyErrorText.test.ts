import type { Pool } from "pg";
import request from "supertest";
import { createPool, migrate } from "../db";
import { LEGACY_ERROR_TEXT_PREDICATE, legacyErrorTextRemoved, PUBLIC_REQUEST_PATTERN } from "../fleetEvents";
import { LEGACY_SCRUB_JOB, LegacyErrorTextScrubber } from "../legacyScrub";
import { stopBackgroundSchedulers } from "../testSupport/appHooks";
import { createTestApp } from "../testSupport/createTestApp";
import { databaseUrl } from "../testSupport/databaseUrl";
import { FakeClock } from "../testSupport/fakeClock";
import { resetDatabase } from "../testSupport/resetDatabase";

/**
 * #45, the rows already written. Failure events stored raw error text before
 * the public detail stopped carrying any, and production holds ~440k of them
 * (`Error: GET http://localhost:80/api/agent/...`). Nothing expires
 * `event_log` and the public route serves the newest rows, so the fix reaches
 * back: a background scrubber walks the table in small batches after startup,
 * and every reader drops the fields meanwhile.
 */

const NOW = new Date("2026-01-01T00:00:00Z");
const OLD_TEXT =
  'Error: GET http://localhost:80/api/agent/v1/ships/MINING-1: 500 {"error":{"message":"st-gateway: GET https://api.spacetraders.io/v2/my/ships failed via http://st-gateway.internal:8080"}}';
const OLD_DENIED_REQUEST = "GET /api/agent/v1/ships/MINING-1: 403 upstream http://st-gateway.internal:8080 said no";
const FLOOD = 20; // extra old rows, so a small batch size needs many batches
/** Requests the guard keeps, and ones it drops — checked against both the JS guard and the SQL scrub. */
const KEEP = ["GET /ships/X: 403", "GET /ships/X: 403 (code 4225)", "POST /ships/X/orbit: no response (ECONNREFUSED)", "upstream call failed (denied)"];
const DROP_TEXT = [OLD_DENIED_REQUEST, "GET //st-gateway.internal/x: 403", "GET /ships/X: 403 ", "GET /ships/X: 403 (code 1) http://x", ""];

describe("pre-#45 error text in stored rows", () => {
  let pool: Pool;
  let gateway: ReturnType<typeof createTestApp> | null = null;
  let logs: string[];
  const log = (line: string, err?: unknown) => {
    logs.push(err instanceof Error ? `${line} ${err.message}` : line);
  };

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    logs = [];
  });

  afterEach(async () => {
    if (gateway !== null) await stopBackgroundSchedulers(gateway);
    gateway = null;
  });

  const insertEvent = (type: string, detail: Record<string, unknown>) =>
    pool.query("INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, $2, $3)", [NOW, type, detail]);
  const insertAnomaly = (type: string, detail: Record<string, unknown>) =>
    pool.query("INSERT INTO anomaly (type, dedupe_key, detected_at, detail) VALUES ($1, $2, $3, $4)", [type, `${type}:x`, NOW, detail]);

  /** Every shape production holds, interleaved with rows that must come through untouched. */
  const seedOldRows = async () => {
    await insertEvent("mining_tick_error", { shipSymbol: "MINING-1", message: OLD_TEXT, failureKind: "unavailable", failureCount: 2 });
    await insertEvent("contract_discovery_error", { message: OLD_TEXT, failureKind: "unavailable" });
    await insertEvent("observation_write_error", { message: `${OLD_TEXT} postgres://u:pw@db.internal/x` });
    await insertEvent("repeated_denied_tripped", { shipSymbol: "MINING-1", source: "tick", request: OLD_DENIED_REQUEST, consecutiveFailures: 5 });
    // Already the new shape: kept.
    await insertEvent("repeated_denied_tripped", { shipSymbol: "MINING-2", request: "GET /ships/MINING-2: 403 (code 4225)" });
    // A `message` on any other type is not ours to remove (POST /events rows, lifecycle notes).
    await insertEvent("ai_review", { message: "kept: an ai-service note", actor: "machine_1" });
    for (let i = 0; i < FLOOD; i++) {
      await insertEvent("mining_tick_error", { message: OLD_TEXT, failureKind: "unavailable", n: i });
      if (i % 5 === 0) await insertEvent("mining_extract", { units: i }); // clean rows between dirty ones
    }
    await insertAnomaly("repeated_denied", { shipSymbol: "MINING-1", request: OLD_DENIED_REQUEST });
    await insertAnomaly("autopilot_resumed_in_shadow", { message: "kept: the restart notice is its message" });
  };
  const DIRTY = 4 + FLOOD;

  const rawEvents = async () =>
    (await pool.query<{ type: string; detail: Record<string, unknown> }>("SELECT type, detail FROM event_log ORDER BY id")).rows;
  const rawAnomalies = async () =>
    (await pool.query<{ type: string; detail: Record<string, unknown> }>("SELECT type, detail FROM anomaly ORDER BY id")).rows;
  const stillToScrub = async () =>
    Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM event_log WHERE ${LEGACY_ERROR_TEXT_PREDICATE}`)).rows[0].n);
  const progress = async () =>
    (await pool.query<{ cursor: string; finished_at: Date | null }>("SELECT cursor, finished_at FROM maintenance_progress WHERE name = $1", [LEGACY_SCRUB_JOB]))
      .rows[0] as { cursor: string; finished_at: Date | null } | undefined;
  const maxId = async () => Number((await pool.query<{ m: string }>("SELECT max(id) AS m FROM event_log")).rows[0].m);

  /**
   * The pool, with every scrub batch counted, its cursor recorded, and
   * optionally held at a gate or failed once — so a test can see batches and
   * stop the scrubber in the middle of one.
   */
  const instrumented = (opts: { holdBatch?: number; failBatch?: number; afterBatch?: () => Promise<unknown> } = {}) => {
    const cursors: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const heldNow = new Promise<void>((r) => (held = r));
    let saved!: () => void;
    const progressSaved = new Promise<void>((r) => (saved = r));
    const proxy = new Proxy(pool, {
      get(target, prop) {
        if (prop !== "query") return Reflect.get(target, prop, target) as unknown;
        return async (text: string, values?: unknown[]) => {
          if (typeof text === "string" && text.includes("WITH batch")) {
            const n = cursors.push(Number(values?.[0]));
            if (n === opts.failBatch) throw new Error("simulated: connection to db.internal:5432 lost");
            if (n === opts.holdBatch) {
              held();
              await gate;
            }
          }
          const result = await target.query(text, values);
          if (typeof text === "string" && text.includes("INSERT INTO maintenance_progress")) saved();
          if (typeof text === "string" && text.includes("WITH batch") && opts.afterBatch) await opts.afterBatch();
          return result;
        };
      },
    });
    return { pool: proxy, cursors, release, heldNow, progressSaved };
  };

  const publicResponses = async () => {
    gateway = createTestApp(pool, new FakeClock(NOW), undefined, undefined, { intervalMs: 100_000 });
    const events = await request(gateway).get("/api/automation/v1/autopilot/events?limit=200");
    const digest = await request(gateway).get("/api/automation/v1/anomalies/digest");
    expect(events.status).toBe(200);
    expect(digest.status).toBe(200);
    return { events: events.body as { events: { type: string; detail: Record<string, unknown> }[] }, digest: digest.body as unknown };
  };

  it("migrate() leaves them alone: it runs before listen and must stay fast", async () => {
    await seedOldRows();
    await migrate(pool);
    expect(await stillToScrub()).toBe(DIRTY);
  });

  it("the scrubber removes them in many small batches, keeps everything else, and logs start and end", async () => {
    await seedOldRows();
    const { pool: p, cursors } = instrumented();

    await new LegacyErrorTextScrubber(p, { batchSize: 3, pauseMs: 0, log }).start();

    expect(await stillToScrub()).toBe(0);
    expect(cursors.length).toBeGreaterThan(5);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b)); // walks forward by id
    expect(JSON.stringify(await rawEvents())).not.toContain("http");
    expect(JSON.stringify(await rawAnomalies())).not.toContain("http");
    const events = await rawEvents();
    expect(events.slice(0, 6)).toEqual([
      { type: "mining_tick_error", detail: { shipSymbol: "MINING-1", failureKind: "unavailable", failureCount: 2 } },
      { type: "contract_discovery_error", detail: { failureKind: "unavailable" } },
      { type: "observation_write_error", detail: {} },
      { type: "repeated_denied_tripped", detail: { shipSymbol: "MINING-1", source: "tick", consecutiveFailures: 5 } },
      { type: "repeated_denied_tripped", detail: { shipSymbol: "MINING-2", request: "GET /ships/MINING-2: 403 (code 4225)" } },
      { type: "ai_review", detail: { message: "kept: an ai-service note", actor: "machine_1" } },
    ]);
    expect(events.filter((e) => e.type === "mining_extract")).toHaveLength(FLOOD / 5);
    expect(await rawAnomalies()).toEqual([
      { type: "repeated_denied", detail: { shipSymbol: "MINING-1" } },
      { type: "autopilot_resumed_in_shadow", detail: { message: "kept: the restart notice is its message" } },
    ]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/scrubbing pre-#45 error text .* from id 0/);
    expect(logs[1]).toBe(`automation-service: legacy error-text scrub done: ${String(DIRTY)} event_log rows and 1 anomaly rows scrubbed`);
    expect((await progress())?.finished_at).not.toBeNull();

    const { events: served, digest } = await publicResponses();
    expect(JSON.stringify(served)).not.toContain("http");
    expect(JSON.stringify(digest)).not.toContain("http");
  });

  it("is idempotent: a finished scrub never runs again, and a forced re-walk changes nothing", async () => {
    await seedOldRows();
    await new LegacyErrorTextScrubber(pool, { batchSize: 4, pauseMs: 0, log }).start();
    const [events, anomalies] = [await rawEvents(), await rawAnomalies()];
    logs = [];

    const again = instrumented();
    await new LegacyErrorTextScrubber(again.pool, { batchSize: 4, pauseMs: 0, log }).start();
    expect(again.cursors).toEqual([]); // the next boot: recorded as finished, so not one batch
    expect(logs).toEqual([]);

    await pool.query("DELETE FROM maintenance_progress");
    await new LegacyErrorTextScrubber(pool, { batchSize: 4, pauseMs: 0, log }).start();
    expect(await rawEvents()).toEqual(events);
    expect(await rawAnomalies()).toEqual(anomalies);
    expect(logs[1]).toMatch(/done: 0 event_log rows and 0 anomaly rows/);
  });

  it("stop() mid-batch returns at once; the next start resumes from the saved cursor", async () => {
    await seedOldRows();
    const first = instrumented({ holdBatch: 3 });
    const scrubber = new LegacyErrorTextScrubber(first.pool, { batchSize: 3, pauseMs: 0, log });
    const run = scrubber.start();
    await first.heldNow; // the third batch is in flight, parked at the database

    const started = Date.now();
    await scrubber.stop();
    expect(Date.now() - started).toBeLessThan(50); // did not wait for the batch

    first.release();
    await run; // the in-flight batch commits as one statement, then the loop exits
    expect(first.cursors).toHaveLength(3); // and no batch after it
    expect(await stillToScrub()).toBeGreaterThan(0);
    const saved = Number((await progress())?.cursor);
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBeLessThan(await maxId());
    expect((await progress())?.finished_at).toBeNull();

    const second = instrumented();
    await new LegacyErrorTextScrubber(second.pool, { batchSize: 3, pauseMs: 0, log }).start();
    expect(second.cursors[0]).toBe(saved); // resumed, not restarted from 0
    expect(await stillToScrub()).toBe(0);
  });

  it("stop() during the pause between batches ends it without waiting out the pause", async () => {
    await seedOldRows();
    const { pool: p, cursors, progressSaved } = instrumented();
    const scrubber = new LegacyErrorTextScrubber(p, { batchSize: 3, pauseMs: 60_000, log });
    const run = scrubber.start();
    await progressSaved; // the first batch is done and saved
    await new Promise((r) => setImmediate(r)); // drains the microtasks that take the scrubber into its minute-long pause

    const started = Date.now();
    await scrubber.stop();
    await run;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cursors).toHaveLength(1);
  });

  it("a failed batch is logged and retried, never thrown", async () => {
    await seedOldRows();
    const { pool: p } = instrumented({ failBatch: 2 });

    await expect(new LegacyErrorTextScrubber(p, { batchSize: 3, pauseMs: 0, retryMs: 5, log }).start()).resolves.toBeUndefined();

    expect(logs.some((l) => l.includes("batch after id") && l.includes("retrying later"))).toBe(true);
    expect(await stillToScrub()).toBe(0);
  });

  it("before the scrub reaches a row, the public routes still never serve its text", async () => {
    await seedOldRows();
    expect(await stillToScrub()).toBe(DIRTY);

    const { events, digest } = await publicResponses();

    expect(JSON.stringify(events)).not.toContain("http");
    expect(JSON.stringify(digest)).not.toContain("http");
    const byType = new Map(events.events.map((e) => [e.type, e.detail]));
    expect(byType.get("ai_review")).toEqual({ message: "kept: an ai-service note", actor: "machine_1" });
    expect(events.events.filter((e) => e.type === "repeated_denied_tripped").map((e) => e.detail.request)).toEqual(
      expect.arrayContaining(["GET /ships/MINING-2: 403 (code 4225)"])
    );
    expect(await stillToScrub()).toBe(DIRTY); // reading never writes
  });

  it("legacyErrorTextRemoved keeps a request of the new shape and drops anything else", () => {
    for (const r of KEEP) expect(legacyErrorTextRemoved("repeated_denied_tripped", { request: r })).toEqual({ request: r });
    for (const r of [...DROP_TEXT, 42, null]) {
      expect(legacyErrorTextRemoved("repeated_denied", { request: r, shipSymbol: "X" })).toEqual({ shipSymbol: "X" });
    }
    expect(legacyErrorTextRemoved("mining_tick_error", { message: OLD_TEXT, failureKind: "unavailable" })).toEqual({ failureKind: "unavailable" });
  });

  it("Postgres and JavaScript read PUBLIC_REQUEST_PATTERN the same way", async () => {
    for (const r of [...KEEP, ...DROP_TEXT]) {
      const { rows } = await pool.query<{ m: boolean }>("SELECT $1::text ~ $2 AS m", [r, PUBLIC_REQUEST_PATTERN]);
      expect([r, rows[0].m]).toEqual([r, new RegExp(PUBLIC_REQUEST_PATTERN).test(r)]);
    }
  });

  it("the scrub agrees with the guard on every request, including null", async () => {
    for (const r of [...KEEP, ...DROP_TEXT, null]) await insertEvent("repeated_denied_tripped", { request: r, shipSymbol: "X" });
    await new LegacyErrorTextScrubber(pool, { batchSize: 4, pauseMs: 0, log }).start();
    const stored = (await rawEvents()).map((e) => e.detail);
    expect(stored).toEqual([...KEEP.map((r) => ({ request: r, shipSymbol: "X" })), ...[...DROP_TEXT, null].map(() => ({ shipSymbol: "X" }))]);
  });

  it("rows written during the walk do not keep it running", async () => {
    await seedOldRows();
    const before = await maxId();
    // A busy fleet: every batch is followed by more rows than a batch takes.
    const { pool: p, cursors } = instrumented({
      afterBatch: () => pool.query("INSERT INTO event_log (occurred_at, type, detail) SELECT $1, 'mining_extract', '{}' FROM generate_series(1, 5)", [NOW]),
    });

    await new LegacyErrorTextScrubber(p, { batchSize: 3, pauseMs: 0, log }).start();

    expect(cursors.length).toBeLessThanOrEqual(Math.ceil(before / 3));
    expect(Math.max(...cursors)).toBeLessThan(before);
    expect(await stillToScrub()).toBe(0);
    expect((await progress())?.finished_at).not.toBeNull();
  });

  it("progress only moves forward, and a finish is never undone", async () => {
    const save = (s: LegacyErrorTextScrubber, cursor: number, finished: boolean) =>
      (s as unknown as { saveProgress(c: number, f: boolean): Promise<void> }).saveProgress(cursor, finished);
    const a = new LegacyErrorTextScrubber(pool, { log });
    const b = new LegacyErrorTextScrubber(pool, { log });

    await save(a, 10, false);
    await save(b, 5, false); // a slower instance, behind
    expect(Number((await progress())?.cursor)).toBe(10);

    await save(a, 12, true);
    await save(b, 11, false);
    const after = await progress();
    expect(Number(after?.cursor)).toBe(12);
    expect(after?.finished_at).not.toBeNull();
  });
});

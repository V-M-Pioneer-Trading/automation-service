import type { Pool } from "pg";
import request from "supertest";
import { createPool, migrate } from "../db";
import { LEGACY_ERROR_TEXT_PREDICATE, legacyErrorTextRemoved } from "../fleetEvents";
import { stopBackgroundSchedulers } from "../testSupport/appHooks";
import { createTestApp } from "../testSupport/createTestApp";
import { databaseUrl } from "../testSupport/databaseUrl";
import { FakeClock } from "../testSupport/fakeClock";
import { resetDatabase } from "../testSupport/resetDatabase";

/**
 * #45, the rows already written. Failure events stored raw error text before
 * the public detail stopped carrying any, and production holds thousands of
 * them (`Error: GET http://localhost:80/api/agent/...`). Nothing expires
 * `event_log`, and the public route serves the newest rows, so the fix had to
 * reach back: `migrate()` scrubs them on boot, and every reader drops the
 * fields anyway.
 */

const NOW = new Date("2026-01-01T00:00:00Z");
const OLD_TEXT =
  'Error: GET http://localhost:80/api/agent/v1/ships/MINING-1: 500 {"error":{"message":"st-gateway: GET https://api.spacetraders.io/v2/my/ships failed via http://st-gateway.internal:8080"}}';
const OLD_DENIED_REQUEST = "GET /api/agent/v1/ships/MINING-1: 403 upstream http://st-gateway.internal:8080 said no";

describe("pre-#45 error text in stored rows", () => {
  let pool: Pool;
  let gateway: ReturnType<typeof createTestApp> | null = null;

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterEach(async () => {
    if (gateway !== null) await stopBackgroundSchedulers(gateway);
    gateway = null;
  });

  const insertEvent = (type: string, detail: Record<string, unknown>) =>
    pool.query("INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, $2, $3)", [NOW, type, detail]);
  const insertAnomaly = (type: string, detail: Record<string, unknown>) =>
    pool.query("INSERT INTO anomaly (type, dedupe_key, detected_at, detail) VALUES ($1, $2, $3, $4)", [type, `${type}:x`, NOW, detail]);

  /** Every shape production holds, plus rows that must come through untouched. */
  const seedOldRows = async () => {
    await insertEvent("mining_tick_error", { shipSymbol: "MINING-1", message: OLD_TEXT, failureKind: "unavailable", failureCount: 2 });
    await insertEvent("contract_discovery_error", { message: OLD_TEXT, failureKind: "unavailable" });
    await insertEvent("observation_write_error", { message: `${OLD_TEXT} postgres://u:pw@db.internal/x` });
    await insertEvent("repeated_denied_tripped", { shipSymbol: "MINING-1", source: "tick", request: OLD_DENIED_REQUEST, consecutiveFailures: 5 });
    // Already the new shape: kept.
    await insertEvent("repeated_denied_tripped", { shipSymbol: "MINING-2", request: "GET /ships/MINING-2: 403 (code 4225)" });
    // A `message` on any other type is not ours to remove (POST /events rows, lifecycle notes).
    await insertEvent("ai_review", { message: "kept: an ai-service note", actor: "machine_1" });
    await insertAnomaly("repeated_denied", { shipSymbol: "MINING-1", request: OLD_DENIED_REQUEST });
    await insertAnomaly("autopilot_resumed_in_shadow", { message: "kept: the restart notice is its message" });
  };

  const rawEvents = async () =>
    (await pool.query<{ type: string; detail: Record<string, unknown> }>("SELECT type, detail FROM event_log ORDER BY id")).rows;
  const rawAnomalies = async () =>
    (await pool.query<{ type: string; detail: Record<string, unknown> }>("SELECT type, detail FROM anomaly ORDER BY id")).rows;
  const stillToScrub = async () =>
    Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM event_log WHERE ${LEGACY_ERROR_TEXT_PREDICATE}`)).rows[0].n);

  const publicResponses = async () => {
    gateway = createTestApp(pool, new FakeClock(NOW), undefined, undefined, { intervalMs: 100_000 });
    const events = await request(gateway).get("/api/automation/v1/autopilot/events?limit=200");
    const digest = await request(gateway).get("/api/automation/v1/anomalies/digest");
    expect(events.status).toBe(200);
    expect(digest.status).toBe(200);
    return { events: events.body as { events: { type: string; detail: Record<string, unknown> }[] }, digest: digest.body as unknown };
  };

  it("migrate() scrubs them, keeps everything else, and serves no address afterwards", async () => {
    await seedOldRows();
    expect(await stillToScrub()).toBe(4);

    await migrate(pool); // what the next boot does

    expect(await stillToScrub()).toBe(0);
    expect(JSON.stringify(await rawEvents())).not.toContain("http");
    expect(JSON.stringify(await rawAnomalies())).not.toContain("http");
    expect(await rawEvents()).toEqual([
      { type: "mining_tick_error", detail: { shipSymbol: "MINING-1", failureKind: "unavailable", failureCount: 2 } },
      { type: "contract_discovery_error", detail: { failureKind: "unavailable" } },
      { type: "observation_write_error", detail: {} },
      { type: "repeated_denied_tripped", detail: { shipSymbol: "MINING-1", source: "tick", consecutiveFailures: 5 } },
      { type: "repeated_denied_tripped", detail: { shipSymbol: "MINING-2", request: "GET /ships/MINING-2: 403 (code 4225)" } },
      { type: "ai_review", detail: { message: "kept: an ai-service note", actor: "machine_1" } },
    ]);
    expect(await rawAnomalies()).toEqual([
      { type: "repeated_denied", detail: { shipSymbol: "MINING-1" } },
      { type: "autopilot_resumed_in_shadow", detail: { message: "kept: the restart notice is its message" } },
    ]);

    const { events, digest } = await publicResponses();
    expect(events.events).toHaveLength(6);
    expect(JSON.stringify(events)).not.toContain("http");
    expect(JSON.stringify(digest)).not.toContain("http");
  });

  it("a second migrate() changes nothing", async () => {
    await seedOldRows();
    await migrate(pool);
    const [events, anomalies] = [await rawEvents(), await rawAnomalies()];

    await migrate(pool);

    expect(await rawEvents()).toEqual(events);
    expect(await rawAnomalies()).toEqual(anomalies);
    expect(await stillToScrub()).toBe(0);
  });

  it("a row the scrub never saw (a restored backup) is still not served", async () => {
    await seedOldRows(); // after the boot migration, so still in the table as written
    expect(await stillToScrub()).toBe(4);

    const { events, digest } = await publicResponses();

    expect(JSON.stringify(events)).not.toContain("http");
    expect(JSON.stringify(digest)).not.toContain("http");
    const byType = new Map(events.events.map((e) => [e.type, e.detail]));
    expect(byType.get("mining_tick_error")).toEqual({ shipSymbol: "MINING-1", failureKind: "unavailable", failureCount: 2 });
    expect(byType.get("ai_review")).toEqual({ message: "kept: an ai-service note", actor: "machine_1" });
    expect(events.events.filter((e) => e.type === "repeated_denied_tripped").map((e) => e.detail.request)).toEqual(
      expect.arrayContaining(["GET /ships/MINING-2: 403 (code 4225)"])
    );
    expect(await stillToScrub()).toBe(4); // reading never writes
  });

  it("legacyErrorTextRemoved keeps a request of the new shape and drops anything else", () => {
    const keep = ["GET /ships/X: 403", "GET /ships/X: 403 (code 4225)", "POST /ships/X/orbit: no response (ECONNREFUSED)", "upstream call failed (denied)"];
    for (const r of keep) expect(legacyErrorTextRemoved("repeated_denied_tripped", { request: r })).toEqual({ request: r });
    const drop = [OLD_DENIED_REQUEST, "GET //st-gateway.internal/x: 403", "GET /ships/X: 403 ", "GET /ships/X: 403 (code 1) http://x", 42];
    for (const r of drop) expect(legacyErrorTextRemoved("repeated_denied", { request: r, shipSymbol: "X" })).toEqual({ shipSymbol: "X" });
  });
});

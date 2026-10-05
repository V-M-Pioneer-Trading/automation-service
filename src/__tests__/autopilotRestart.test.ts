/**
 * @file Owner decision Q29 = C: the autopilot's status and mode persist, and a
 * restart restores them — except live, which comes back as shadow with one
 * anomaly asking the owner to re-arm. A "restart" here is a second app built
 * on the same database, which is all a new process is to this service.
 */

import http from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import type { Express } from "express";
import type { Pool } from "pg";
import { AnomalyRepo } from "../anomaly";
import {
  AutopilotLifecycle,
  type PersistedAutopilot,
  AutopilotStateRepo,
  RESTART_ACTOR,
  RESUMED_IN_SHADOW,
  restoredAfterRestart,
  resumedInShadowAnomaly,
} from "../autopilotLifecycle";
import { AutopilotState, type AutopilotSnapshot } from "../autopilotState";
import { createPool, migrate } from "../db";
import { autopilotRestored } from "../server";
import { forceAnomalyTick, stopBackgroundSchedulers } from "../testSupport/appHooks";
import { bearer, TEST_ACTOR as OPERATOR } from "../testSupport/authTokens";
import { createTestApp } from "../testSupport/createTestApp";
import { databaseUrl } from "../testSupport/databaseUrl";
import { FakeClock } from "../testSupport/fakeClock";
import { makeFlakyPool } from "../testSupport/flakyPool";
import { resetDatabase } from "../testSupport/resetDatabase";

interface LifecycleEvent {
  type: string;
  detail: { from?: string; mode?: string | null; actor?: string | null; restoredFrom?: unknown };
}
interface EventsBody {
  events: LifecycleEvent[];
}

const BASE = "/api/automation/v1/autopilot";
const START = new Date("2026-10-05T10:00:00Z");

describe("autopilot state across a restart (Q29)", () => {
  let pool: Pool;
  let clock: FakeClock;
  const apps: Express[] = [];

  beforeAll(async () => {
    pool = createPool(databaseUrl());
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FakeClock(START);
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await stopBackgroundSchedulers(app);
  });

  /** A process: an app on the shared database, with its restore finished. */
  const boot = async (): Promise<Express> => {
    const app = createTestApp(pool, clock);
    apps.push(app);
    await autopilotRestored(app);
    return app;
  };

  const post = (app: Express, action: "arm" | "pause" | "abort", body: object = {}) =>
    request(app).post(`${BASE}/${action}`).set("Authorization", bearer()).send(body);
  const status = async (app: Express) => (await request(app).get(`${BASE}/status`)).body as AutopilotSnapshot;
  const lifecycleEvents = async (app: Express) =>
    ((await request(app).get(`${BASE}/events`)).body as EventsBody).events.filter((e) => ["armed", "paused", "aborted"].includes(e.type));
  const snapshotOf = (row: PersistedAutopilot | null) => (row === null ? null : { status: row.status, mode: row.mode });
  const persisted = async () => snapshotOf(await new AutopilotStateRepo(pool, clock).load());
  const anomalies = () => new AnomalyRepo(pool, clock).listSince(new Date(0), 50);

  describe("persistence", () => {
    it("round-trips every status and mode through the row", async () => {
      const repo = new AutopilotStateRepo(pool, clock);
      expect(await repo.load()).toBeNull();
      const cases: AutopilotSnapshot[] = [
        { status: "armed", mode: "live" },
        { status: "paused", mode: "shadow" },
        { status: "aborted", mode: null },
        { status: "disarmed", mode: null },
        { status: "armed", mode: "shadow" },
      ];
      for (const snapshot of cases) {
        await repo.save(snapshot, "user_test");
        expect(snapshotOf(await repo.load())).toEqual(snapshot);
      }
      const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM autopilot_state");
      expect(Number(rows[0].n)).toBe(1);
    });

    it("refuses a row the restore could misread", async () => {
      const repo = new AutopilotStateRepo(pool, clock);
      await expect(repo.save({ status: "armed", mode: null }, "x")).rejects.toThrow();
      await expect(repo.save({ status: "aborted", mode: "live" }, "x")).rejects.toThrow();
    });

    it("persists every transition the API makes, with the caller as its author", async () => {
      const app = await boot();
      await post(app, "arm", { mode: "shadow" });
      expect(await persisted()).toEqual({ status: "armed", mode: "shadow" });
      await post(app, "arm", { mode: "live" });
      expect(await persisted()).toEqual({ status: "armed", mode: "live" });
      await post(app, "pause");
      expect(await persisted()).toEqual({ status: "paused", mode: "live" });
      await post(app, "abort");
      expect(await persisted()).toEqual({ status: "aborted", mode: null });
      const { rows } = await pool.query<{ updated_by: string | null }>("SELECT updated_by FROM autopilot_state");
      expect(rows[0].updated_by).toEqual(expect.any(String));
      expect(rows[0].updated_by).not.toBe(RESTART_ACTOR);
    });

    it("a refused transition persists nothing", async () => {
      const app = await boot();
      expect((await post(app, "pause")).status).toBe(409);
      expect(await persisted()).toBeNull();
      expect(await lifecycleEvents(app)).toHaveLength(0);
    });
  });

  describe("restart", () => {
    it("armed live comes back armed in shadow, with one anomaly and an armed event from the restart", async () => {
      const first = await boot();
      await post(first, "arm", { mode: "live" });

      clock.advance(60_000);
      const second = await boot();
      expect(await status(second)).toEqual({ status: "armed", mode: "shadow" });
      expect(await persisted()).toEqual({ status: "armed", mode: "shadow" });

      const raised = await anomalies();
      expect(raised).toHaveLength(1);
      expect(raised[0].type).toBe(RESUMED_IN_SHADOW);
      expect(raised[0].detail).toMatchObject({
        message: `autopilot resumed in shadow after restart; was live; re-arm live to continue trading (state last set by ${OPERATOR} at ${START.toISOString()})`,
        was: { status: "armed", mode: "live" },
        now: { status: "armed", mode: "shadow" },
        lastWrittenBy: OPERATOR,
        lastWrittenAt: START.toISOString(),
      });

      const [latest] = await lifecycleEvents(second);
      expect(latest).toMatchObject({
        type: "armed",
        detail: { from: "disarmed", mode: "shadow", actor: RESTART_ACTOR, restoredFrom: { status: "armed", mode: "live" } },
      });
    });

    it("raises the anomaly once, not once per boot, when the process keeps restarting", async () => {
      await post(await boot(), "arm", { mode: "live" });
      await boot();
      await boot();
      const third = await boot();
      expect(await status(third)).toEqual({ status: "armed", mode: "shadow" });
      expect(await anomalies()).toHaveLength(1);
    });

    // Decided: no anomaly. An anomaly is the one way this service asks a human
    // for something, and here there is nothing to ask — the autopilot is doing
    // exactly what the owner last told it to. Paging would also hand ai-service
    // a "problem" no knob can fix, on every deploy. The armed event still
    // records that the restart, not the owner, armed this process.
    it("armed shadow comes back armed in shadow, logged but without an anomaly", async () => {
      await post(await boot(), "arm", { mode: "shadow" });
      const second = await boot();
      expect(await status(second)).toEqual({ status: "armed", mode: "shadow" });
      expect(await anomalies()).toHaveLength(0);
      const [latest] = await lifecycleEvents(second);
      expect(latest).toMatchObject({ type: "armed", detail: { mode: "shadow", actor: RESTART_ACTOR } });
    });

    it("never armed comes back disarmed, writing nothing", async () => {
      await boot();
      const second = await boot();
      expect(await status(second)).toEqual({ status: "disarmed", mode: null });
      expect(await persisted()).toBeNull();
      expect(await lifecycleEvents(second)).toHaveLength(0);
      expect(await anomalies()).toHaveLength(0);
    });

    it("aborted comes back aborted, writing nothing", async () => {
      const first = await boot();
      await post(first, "arm", { mode: "live" });
      await post(first, "abort");
      const second = await boot();
      expect(await status(second)).toEqual({ status: "aborted", mode: null });
      expect(await lifecycleEvents(second)).toHaveLength(2); // the operator's arm and abort, nothing from the restart
      expect(await anomalies()).toHaveLength(0);
    });

    it("paused live comes back paused in shadow, with the anomaly", async () => {
      const first = await boot();
      await post(first, "arm", { mode: "live" });
      await post(first, "pause");
      const second = await boot();
      expect(await status(second)).toEqual({ status: "paused", mode: "shadow" });
      const raised = await anomalies();
      expect(raised).toHaveLength(1);
      expect(raised[0].detail.message).toMatch(
        /^autopilot resumed in shadow after restart; was paused \(live\); re-arm live to continue trading \(state last set by /
      );
      const [latest] = await lifecycleEvents(second);
      expect(latest).toMatchObject({ type: "paused", detail: { from: "disarmed", mode: "shadow", actor: RESTART_ACTOR } });
    });

    it("paused shadow comes back paused in shadow, without an anomaly", async () => {
      const first = await boot();
      await post(first, "arm", { mode: "shadow" });
      await post(first, "pause");
      const second = await boot();
      expect(await status(second)).toEqual({ status: "paused", mode: "shadow" });
      expect(await anomalies()).toHaveLength(0);
    });

    it("a restored autopilot can be paused, aborted and re-armed live", async () => {
      await post(await boot(), "arm", { mode: "live" });
      const second = await boot();
      expect((await post(second, "pause")).body).toEqual({ status: "paused", mode: "shadow" });
      expect((await post(second, "arm", { mode: "live" })).body).toEqual({ status: "armed", mode: "live" });
      expect(await persisted()).toEqual({ status: "armed", mode: "live" });
      expect((await post(second, "abort")).body).toEqual({ status: "aborted", mode: null });
      const third = await boot();
      expect(await status(third)).toEqual({ status: "aborted", mode: null });
    });

    it("an arm that arrives while the process is still restoring lands after the restore and wins", async () => {
      await post(await boot(), "arm", { mode: "live" });

      const second = createTestApp(pool, clock); // restore still in flight
      apps.push(second);
      const [armRes, statusRes] = await Promise.all([post(second, "arm", { mode: "live" }), request(second).get(`${BASE}/status`)]);
      expect(armRes.status).toBe(200);
      expect(armRes.body).toEqual({ status: "armed", mode: "live" });
      // The status read waited for the restore rather than answering "disarmed".
      expect((statusRes.body as AutopilotSnapshot).status).toBe("armed");

      expect(await status(second)).toEqual({ status: "armed", mode: "live" });
      expect(await persisted()).toEqual({ status: "armed", mode: "live" });
      const events = await lifecycleEvents(second);
      // Newest first: the operator's arm, then the restart's.
      expect(events.slice(0, 2).map((e) => e.detail.actor === RESTART_ACTOR)).toEqual([false, true]);
      expect(events[0].detail.from).toBe("armed");
      expect(await anomalies()).toHaveLength(1);
    });

    it("delivers the anomaly through the existing webhook on the next anomaly tick", async () => {
      const received: { type: string; detail: { message: string } }[] = [];
      const hook = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          received.push(JSON.parse(body) as { type: string; detail: { message: string } });
          res.writeHead(204).end();
        });
      });
      await new Promise<void>((resolve) => hook.listen(0, resolve));
      try {
        await post(await boot(), "arm", { mode: "live" });
        const url = `http://127.0.0.1:${String((hook.address() as AddressInfo).port)}/hook`;
        const second = createTestApp(pool, clock, undefined, undefined, { webhookUrl: url, intervalMs: 3_600_000 });
        apps.push(second);
        await autopilotRestored(second);
        await forceAnomalyTick(second);
        const pages = received.filter((r) => r.type === RESUMED_IN_SHADOW);
        expect(pages).toHaveLength(1);
        expect(pages[0].detail.message).toContain("was live");
        expect((await anomalies())[0].deliveredAt).not.toBeNull();
      } finally {
        await new Promise<void>((resolve) => hook.close(() => {
          resolve();
        }));
      }
    });
  });

  describe("failure ordering", () => {
    it("a restore that fails part-way leaves the row live, so the next boot does it again", async () => {
      await post(await boot(), "arm", { mode: "live" });

      const flaky = makeFlakyPool(pool, (sql) => sql.includes("INSERT INTO anomaly"));
      const failed = createTestApp(flaky, clock);
      apps.push(failed);
      await expect(autopilotRestored(failed)).rejects.toThrow(/simulated/);
      expect(await status(failed)).toEqual({ status: "disarmed", mode: null });
      expect(await persisted()).toEqual({ status: "armed", mode: "live" });
      expect(await anomalies()).toHaveLength(0);

      const retried = await boot();
      expect(await status(retried)).toEqual({ status: "armed", mode: "shadow" });
      expect(await anomalies()).toHaveLength(1);
    });

    it("an arm that cannot be persisted does not take effect", async () => {
      const flaky = makeFlakyPool(pool, (sql) => sql.includes("INSERT INTO autopilot_state"));
      const app = createTestApp(flaky, clock);
      apps.push(app);
      await autopilotRestored(app);
      expect((await post(app, "arm", { mode: "live" })).status).toBe(500);
      expect(await status(app)).toEqual({ status: "disarmed", mode: null });
      expect(await persisted()).toBeNull();
    });

    it("a pause that cannot be persisted still pauses", async () => {
      // Shadow, so the restore below writes no row and the one failure is the pause's.
      await post(await boot(), "arm", { mode: "shadow" });
      const flaky = makeFlakyPool(pool, (sql) => sql.includes("INSERT INTO autopilot_state"));
      const app = createTestApp(flaky, clock);
      apps.push(app);
      await autopilotRestored(app);
      expect((await post(app, "pause")).status).toBe(500);
      expect(await status(app)).toEqual({ status: "paused", mode: "shadow" });
    });

    it("an abort that cannot be persisted still aborts", async () => {
      await post(await boot(), "arm", { mode: "shadow" });
      const flaky = makeFlakyPool(pool, (sql) => sql.includes("INSERT INTO autopilot_state"));
      const app = createTestApp(flaky, clock);
      apps.push(app);
      await autopilotRestored(app);
      expect((await post(app, "abort")).status).toBe(500);
      expect(await status(app)).toEqual({ status: "aborted", mode: null });
      // And the row it could not write is one a restart only ever resumes in shadow.
      expect(await persisted()).toEqual({ status: "armed", mode: "shadow" });
    });
  });

  describe("AutopilotLifecycle", () => {
    const lifecycleWith = (startFleet: () => void, stopFleet: () => Promise<void> = () => Promise.resolve()) => {
      const state = new AutopilotState();
      return { state, lifecycle: new AutopilotLifecycle({ state, pool, clock, startFleet, stopFleet }) };
    };

    it.each<[AutopilotSnapshot | null, number]>([
      [null, 0],
      [{ status: "aborted", mode: null }, 0],
      [{ status: "disarmed", mode: null }, 0],
      [{ status: "armed", mode: "live" }, 1],
      [{ status: "armed", mode: "shadow" }, 1],
      [{ status: "paused", mode: "live" }, 1],
    ])("restoring %j starts the fleet loop %i time(s)", async (saved, starts) => {
      if (saved !== null) await new AutopilotStateRepo(pool, clock).save(saved, "user_test");
      const startFleet = jest.fn();
      const { lifecycle } = lifecycleWith(startFleet);
      await lifecycle.restored;
      expect(startFleet).toHaveBeenCalledTimes(starts);
    });

    it("close() waits for an accepted change to persist, then refuses new ones", async () => {
      const { lifecycle, state } = lifecycleWith(() => undefined);
      const armed = lifecycle.arm("live", "user_test");
      await lifecycle.close();
      expect(state.snapshot()).toEqual({ status: "armed", mode: "live" });
      expect(await persisted()).toEqual({ status: "armed", mode: "live" });
      await expect(armed).resolves.toEqual({ status: "armed", mode: "live" });
      await expect(lifecycle.pause("user_test")).rejects.toThrow(/shutting down/);
      expect(state.getStatus()).toBe("armed");
    });

    it("abort stops the fleet before it persists the abort", async () => {
      const order: string[] = [];
      const { lifecycle } = lifecycleWith(
        () => undefined,
        async () => {
          order.push(`stop:${String((await persisted())?.status)}`);
        }
      );
      await lifecycle.arm("live", "user_test");
      await lifecycle.abort("user_test");
      order.push(`after:${String((await persisted())?.status)}`);
      expect(order).toEqual(["stop:armed", "after:aborted"]);
    });
  });

  describe("restoredAfterRestart", () => {
    it.each<[PersistedAutopilot | null, AutopilotSnapshot, boolean]>([
      [null, { status: "disarmed", mode: null }, false],
      [{ status: "disarmed", mode: null }, { status: "disarmed", mode: null }, false],
      [{ status: "aborted", mode: null }, { status: "aborted", mode: null }, false],
      [{ status: "armed", mode: "live" }, { status: "armed", mode: "shadow" }, true],
      [{ status: "armed", mode: "shadow" }, { status: "armed", mode: "shadow" }, false],
      [{ status: "paused", mode: "live" }, { status: "paused", mode: "shadow" }, true],
      [{ status: "paused", mode: "shadow" }, { status: "paused", mode: "shadow" }, false],
      // Fail closed by shape: values the CHECKs should make impossible.
      [{ status: "armed", mode: null }, { status: "armed", mode: "shadow" }, true],
      [{ status: "armed", mode: "LIVE" }, { status: "armed", mode: "shadow" }, true],
      [{ status: "paused", mode: "turbo" }, { status: "paused", mode: "shadow" }, true],
      [{ status: "aborted", mode: "live" }, { status: "aborted", mode: null }, false],
      [{ status: "disarmed", mode: "live" }, { status: "disarmed", mode: null }, false],
      [{ status: "ARMED", mode: "live" }, { status: "disarmed", mode: null }, false],
      [{ status: "running", mode: "live" }, { status: "disarmed", mode: null }, false],
      [{ status: "", mode: null }, { status: "disarmed", mode: null }, false],
    ])("%j restores as %j (downgraded: %s)", (saved, expected, downgraded) => {
      const plan = restoredAfterRestart(saved);
      expect(plan.snapshot).toEqual(expected);
      expect(plan.downgradedFrom).toEqual(downgraded ? saved : null);
    });

    it("never restores live, whatever the row holds", () => {
      const statuses = ["armed", "paused", "aborted", "disarmed", "live", "ARMED", "", "armed "];
      const modes = ["live", "shadow", "LIVE", "", "null", null];
      for (const status of statuses) {
        for (const mode of modes) {
          expect(restoredAfterRestart({ status, mode }).snapshot.mode).not.toBe("live");
        }
      }
    });

    it("restores a garbled row in the table as shadow, with the anomaly", async () => {
      // Bypasses the CHECK the way a manual edit or a future migration could.
      await pool.query("ALTER TABLE autopilot_state DROP CONSTRAINT IF EXISTS autopilot_state_mode_check");
      try {
        await pool.query(
          "INSERT INTO autopilot_state (singleton, status, mode, updated_at, updated_by) VALUES (TRUE, 'armed', 'LIVE', $1, 'user_x')",
          [START]
        );
        const app = await boot();
        expect(await status(app)).toEqual({ status: "armed", mode: "shadow" });
        expect(await anomalies()).toHaveLength(1);
      } finally {
        await pool.query("TRUNCATE autopilot_state");
        await pool.query("ALTER TABLE autopilot_state ADD CONSTRAINT autopilot_state_mode_check CHECK (mode IN ('live', 'shadow'))");
      }
    });

    it("names what was lost in the anomaly", () => {
      expect(resumedInShadowAnomaly({ status: "armed", mode: "live" }).detail.message).toBe(
        "autopilot resumed in shadow after restart; was live; re-arm live to continue trading"
      );
      const withAuthor = resumedInShadowAnomaly({ status: "armed", mode: "live", updatedBy: "user_a", updatedAt: "2026-10-05T09:00:00.000Z" });
      expect(withAuthor.detail).toMatchObject({ lastWrittenBy: "user_a", lastWrittenAt: "2026-10-05T09:00:00.000Z" });
      expect(withAuthor.detail.message).toContain("(state last set by user_a at 2026-10-05T09:00:00.000Z)");
      expect(resumedInShadowAnomaly({ status: "armed", mode: "live" }).type).toBe(RESUMED_IN_SHADOW);
    });
  });
});

import request from "supertest";
import type { Pool } from "pg";
import { createTestApp } from "../testSupport/createTestApp";
import { bearer, machineBearer } from "../testSupport/authTokens";
import { createPool, migrate } from "../db";
import { databaseUrl } from "../testSupport/databaseUrl";
import { resetDatabase } from "../testSupport/resetDatabase";

// Every 4xx answer a controller gives itself (meta#168), pinned by status and exact body.
// The envelope is what a caller parses; the wording is what an operator reads.
describe("controller error answers", () => {
  let pool: Pool;

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

  // The ship route is registered only with a fleet scheduler; nothing here arms it, so no upstream is called.
  const app = () =>
    createTestApp(pool, undefined, {
      agentServiceUrl: "http://127.0.0.1:1",
      fleetServiceUrl: "http://127.0.0.1:1",
      navigationServiceUrl: "http://127.0.0.1:1",
      miningShipSymbol: "MINING-1",
      schedulerIntervalMs: 100_000,
      replanIntervalMs: 300_000,
    });

  const base = "/api/automation/v1";

  it("POST /autopilot/arm answers 400 for an unknown mode", async () => {
    const res = await request(app()).post(`${base}/autopilot/arm`).set("Authorization", bearer()).send({ mode: "turbo" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'mode must be "live" or "shadow"' } });
  });

  it("POST /autopilot/pause answers 409 when not armed", async () => {
    const res = await request(app()).post(`${base}/autopilot/pause`).set("Authorization", bearer());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: "Cannot pause while disarmed" } });
  });

  it("POST /autopilot/abort answers 409 when neither armed nor paused", async () => {
    const res = await request(app()).post(`${base}/autopilot/abort`).set("Authorization", bearer());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { message: "Cannot abort while disarmed" } });
  });

  it("GET /autopilot/ships/:ship answers 404 for a ship with no task", async () => {
    const res = await request(app()).get(`${base}/autopilot/ships/NOPE-1`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "no task for this ship yet" } });
  });

  it("GET /planner/knobs answers 400 for an unknown class", async () => {
    const res = await request(app()).get(`${base}/planner/knobs?class=bogus`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'class must be "model", "policy" or "alert"' } });
  });

  it("PUT /planner/knobs/:name answers 400 for a value that is not a finite number", async () => {
    const res = await request(app()).put(`${base}/planner/knobs/mine.taskWeight`).set("Authorization", bearer()).send({ value: "high" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: "value must be a finite number" } });
  });

  it("PUT /planner/knobs/:name answers 400 for a value outside the knob's range", async () => {
    const res = await request(app()).put(`${base}/planner/knobs/mine.taskWeight`).set("Authorization", bearer()).send({ value: 11 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: "mine.taskWeight must be between 0 and 10, got 11" } });
  });

  it("PUT /planner/knobs/:name answers 403 when the caller's kind may not write the knob's class", async () => {
    const res = await request(app()).put(`${base}/planner/knobs/mine.creditsPerCyclePrior`).set("Authorization", machineBearer()).send({ value: 1 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { message: "mine.creditsPerCyclePrior is a model knob; this caller may only write policy" } });
  });

  it("PUT /planner/knobs/:name answers 404 for an unknown knob", async () => {
    const res = await request(app()).put(`${base}/planner/knobs/no.such.knob`).set("Authorization", bearer()).send({ value: 1 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: 'unknown knob "no.such.knob"' } });
  });

  it("POST /events answers 400 for a type outside the ai_ namespace", async () => {
    const res = await request(app()).post(`${base}/events`).set("Authorization", bearer()).send({ type: "armed" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'type must be a string starting with "ai_"' } });
  });

  it("POST /events answers 400 for a detail that is not an object", async () => {
    const res = await request(app()).post(`${base}/events`).set("Authorization", bearer()).send({ type: "ai_note", detail: [1] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: "detail must be an object" } });
  });
});

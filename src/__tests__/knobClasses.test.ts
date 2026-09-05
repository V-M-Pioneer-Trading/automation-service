import request from "supertest";
import { Pool } from "pg";
import { createTestApp } from "../testSupport/createTestApp";
import { bearer } from "../testSupport/authTokens";
import { createPool, migrate } from "../db";
import { KNOB_DEFINITIONS, syncKnobDefinitions } from "../knobs";
import { resetDatabase } from "../testSupport/resetDatabase";

/**
 * Knob classes are the fence around the AI supervisor: it may write `policy`
 * and nothing else. These cases pin that fence in place, and pin the redeploy
 * behaviour that keeps the knob table honest.
 */
describe("knob classes", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await syncKnobDefinitions(pool);
  });

  const app = () => createTestApp(pool);

  it("every knob declares a class, and every class is represented", () => {
    const classes = new Set(KNOB_DEFINITIONS.map((d) => d.class));
    expect(classes).toEqual(new Set(["model", "policy", "alert"]));
    expect(KNOB_DEFINITIONS.every((d) => d.min <= d.default && d.default <= d.max)).toBe(true);
  });

  /**
   * The floor guards the one failure the game does not let you recover from:
   * no credits, therefore no fuel, therefore no way to earn credits. At 0 the
   * check reduces to "would this take the balance negative" and reserves
   * nothing, so a default of 0 shipped the protection switched off for every
   * fresh deployment. Turning it off should take a deliberate write.
   */
  it("reserves cash by default, rather than shipping the death-spiral guard disabled", async () => {
    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    const floor = res.body.knobs.find((k: { name: string }) => k.name === "credit.reserveFloor");
    expect(floor.default).toBeGreaterThan(0);
    expect(floor.value).toBe(floor.default);
    expect(floor.min).toBe(0); // still switchable off, but only on purpose
  });

  it("lists every knob with its class and description", async () => {
    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    expect(res.status).toBe(200);
    expect(res.body.knobs).toHaveLength(KNOB_DEFINITIONS.length);
    for (const knob of res.body.knobs) {
      expect(["model", "policy", "alert"]).toContain(knob.class);
      expect(knob.description.length).toBeGreaterThan(0);
    }
  });

  it("filters to one class, which is how the supervisor sees only policy knobs", async () => {
    const res = await request(app()).get("/api/automation/v1/planner/knobs?class=policy");
    expect(res.status).toBe(200);
    const names = res.body.knobs.map((k: { name: string }) => k.name);

    expect(names).toContain("mine.taskWeight");
    expect(names).toContain("credit.reserveFloor");
    // Alert thresholds are out of reach: an agent that can widen its own alarms
    // will eventually silence them instead of fixing what tripped them.
    expect(names).not.toContain("anomaly.errorRateThreshold");
    expect(names).not.toContain("anomaly.profitDropFraction");
    // Model values describe the universe; editing one changes belief, not fact.
    expect(names).not.toContain("travel.speedUnitsPerHourPrior");
    expect(res.body.knobs.every((k: { class: string }) => k.class === "policy")).toBe(true);
  });

  it("rejects an unknown class rather than silently returning everything", async () => {
    const res = await request(app()).get("/api/automation/v1/planner/knobs?class=everything");
    expect(res.status).toBe(400);
  });

  it("still lets an operator write a model knob directly", async () => {
    const res = await request(app())
      .put("/api/automation/v1/planner/knobs/travel.speedUnitsPerHourPrior").set("Authorization", bearer())
      .send({ value: 45 });
    expect(res.status).toBe(200);
    expect(res.body.knob.value).toBe(45);
    expect(res.body.knob.class).toBe("model");
  });

  it("deletes knobs dropped from the definitions, so no orphan lever survives a redeploy", async () => {
    await pool.query(
      `INSERT INTO knob (name, knob_class, value, default_value, min_value, max_value)
       VALUES ('legacy.removedKnob', 'policy', 1, 1, 0, 10)`
    );
    await syncKnobDefinitions(pool);

    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    const names = res.body.knobs.map((k: { name: string }) => k.name);
    expect(names).not.toContain("legacy.removedKnob");
  });

  it("clamps a stored value that no longer fits tightened bounds, instead of leaving it unwritable", async () => {
    await pool.query(`UPDATE knob SET max_value = 1000, value = 1000 WHERE name = 'mine.taskWeight'`);
    await syncKnobDefinitions(pool);

    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    const knob = res.body.knobs.find((k: { name: string }) => k.name === "mine.taskWeight");
    expect(knob.max).toBe(10);
    expect(knob.value).toBe(10);
  });

  it("keeps an operator's tuned value across a redeploy", async () => {
    await request(app()).put("/api/automation/v1/planner/knobs/mine.taskWeight").set("Authorization", bearer()).send({ value: 4 });
    await syncKnobDefinitions(pool);

    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    const knob = res.body.knobs.find((k: { name: string }) => k.name === "mine.taskWeight");
    expect(knob.value).toBe(4);
  });
});

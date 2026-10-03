import request from "supertest";
import type { Pool } from "pg";
import { createTestApp } from "../testSupport/createTestApp";
import { bearer, bearerWithoutScope, fleetControlOnlyBearer, machineBearer, TEST_ACTOR, TEST_MACHINE } from "../testSupport/authTokens";
import { createPool, migrate } from "../db";
import { KNOB_DEFINITIONS, syncKnobDefinitions } from "../knobs";
import { resetDatabase } from "../testSupport/resetDatabase";
import { databaseUrl } from "../testSupport/databaseUrl";

interface Knob {
  name: string;
  class: string;
  description: string;
  default: number;
  value: number;
  min: number;
  max: number;
}
interface KnobsBody {
  knobs: Knob[];
}
interface KnobBody {
  knob: Knob;
}
interface ErrorBody {
  error: { message: string };
}
interface EventsBody {
  events: { type: string; detail: unknown }[];
}

function findKnob(body: KnobsBody, name: string): Knob {
  const knob = body.knobs.find((k) => k.name === name);
  if (knob === undefined) throw new Error(`knob ${name} not listed`);
  return knob;
}

function findChanged(body: EventsBody): { type: string; detail: unknown } {
  const changed = body.events.find((e) => e.type === "knob_changed");
  if (changed === undefined) throw new Error("no knob_changed event");
  return changed;
}

/**
 * Knob classes are the fence around the AI supervisor: it may write `policy`
 * and nothing else. These cases pin that fence in place, and pin the redeploy
 * behaviour that keeps the knob table honest.
 */
describe("knob classes", () => {
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
    const floor = findKnob(res.body as KnobsBody, "credit.reserveFloor");
    expect(floor.default).toBeGreaterThan(0);
    expect(floor.value).toBe(floor.default);
    expect(floor.min).toBe(0); // still switchable off, but only on purpose
  });

  it("lists every knob with its class and description", async () => {
    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    expect(res.status).toBe(200);
    expect((res.body as KnobsBody).knobs).toHaveLength(KNOB_DEFINITIONS.length);
    for (const knob of (res.body as KnobsBody).knobs) {
      expect(["model", "policy", "alert"]).toContain(knob.class);
      expect(knob.description.length).toBeGreaterThan(0);
    }
  });

  it("filters to one class, which is how the supervisor sees only policy knobs", async () => {
    const res = await request(app()).get("/api/automation/v1/planner/knobs?class=policy");
    expect(res.status).toBe(200);
    const names = (res.body as KnobsBody).knobs.map((k) => k.name);

    expect(names).toContain("mine.taskWeight");
    expect(names).toContain("credit.reserveFloor");
    // Alert thresholds are out of reach: an agent that can widen its own alarms
    // will eventually silence them instead of fixing what tripped them.
    expect(names).not.toContain("anomaly.errorRateThreshold");
    expect(names).not.toContain("anomaly.profitDropFraction");
    // Model values describe the universe; editing one changes belief, not fact.
    expect(names).not.toContain("travel.speedUnitsPerHourPrior");
    expect((res.body as KnobsBody).knobs.every((k) => k.class === "policy")).toBe(true);
  });

  it("rejects an unknown class rather than silently returning everything", async () => {
    const res = await request(app()).get("/api/automation/v1/planner/knobs?class=everything");
    expect(res.status).toBe(400);
  });

  /**
   * The fence used to be a read filter and nothing more: the supervisor was
   * *shown* only policy knobs and trusted not to name any other. Nothing
   * rejected a write, so the exact move the class model exists to prevent —
   * an agent resolving "the error alarm fired" by making the error alarm
   * unable to fire — landed as an ordinary knob_changed event.
   *
   * The fence keys on the center's `kind`, which is what a Clerk M2M token
   * is reported as (decision 21). It used to key on an `X-Service-Secret`
   * header being present.
   */
  describe("the fence on the write path", () => {
    const machineWrite = (name: string, value: number) =>
      request(app()).put(`/api/automation/v1/planner/knobs/${name}`).set("Authorization", machineBearer()).send({ value });

    it("lets the supervisor write a policy knob", async () => {
      const res = await machineWrite("mine.taskWeight", 2);
      expect(res.status).toBe(200);
      expect((res.body as KnobBody).knob.value).toBe(2);
    });

    it("refuses to let the supervisor widen its own alarm thresholds", async () => {
      const res = await machineWrite("anomaly.errorRateThreshold", 1);
      expect(res.status).toBe(403); // the credential is valid; it just doesn't reach this class
      expect((res.body as ErrorBody).error.message).toMatch(/is an alert knob/);

      const after = await request(app()).get("/api/automation/v1/planner/knobs");
      const knob = findKnob(after.body as KnobsBody, "anomaly.errorRateThreshold");
      expect(knob.value).toBe(0.1); // the rejected write never took effect
    });

    it("refuses to let the supervisor rewrite what the planner believes about the universe", async () => {
      const res = await machineWrite("travel.speedUnitsPerHourPrior", 999);
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error.message).toMatch(/is a model knob/);
    });

    it("fences a machine by kind even when its sub looks like an operator's", async () => {
      // The prefix is Clerk's convention and only the center may read it.
      // A machine is whatever the center says is one.
      const res = await request(app())
        .put("/api/automation/v1/planner/knobs/anomaly.errorRateThreshold")
        .set("Authorization", bearer({ sub: "user_2LooksHuman", kind: "machine", scopes: ["planner:advise"] }))
        .send({ value: 1 });
      expect(res.status).toBe(403);
    });

    // The fence is written "only an operator is unfenced", not "a machine is
    // fenced", so a kind the contract never defined gets the narrower set.
    it("fences a kind it does not know, as if it were a machine", async () => {
      const unknownKind = bearer({ sub: "svc_newKind", kind: "service" as unknown as "machine", scopes: ["planner:advise"] });
      const refused = await request(app())
        .put("/api/automation/v1/planner/knobs/travel.speedUnitsPerHourPrior")
        .set("Authorization", unknownKind)
        .send({ value: 45 });
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.message).toMatch(/model knob/);

      const policy = await request(app())
        .put("/api/automation/v1/planner/knobs/mine.taskWeight")
        .set("Authorization", unknownKind)
        .send({ value: 2 });
      expect(policy.status).toBe(200);
    });

    it("refuses fleet:control alone on every class: the route wants planner:advise", async () => {
      for (const name of ["mine.taskWeight", "travel.speedUnitsPerHourPrior", "anomaly.errorRateThreshold"]) {
        const res = await request(app())
          .put(`/api/automation/v1/planner/knobs/${name}`)
          .set("Authorization", fleetControlOnlyBearer())
          .send({ value: 1 });
        expect(res.status).toBe(403);
        expect((res.body as ErrorBody).error.message).not.toMatch(/knob/);
      }
    });

    it("refuses a caller without planner:advise before the class is considered", async () => {
      const res = await request(app())
        .put("/api/automation/v1/planner/knobs/mine.taskWeight")
        .set("Authorization", bearerWithoutScope())
        .send({ value: 2 });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error.message).not.toMatch(/policy knob/);
    });

    it("treats the retired X-Service-Secret header as no credential", async () => {
      const res = await request(app())
        .put("/api/automation/v1/planner/knobs/mine.taskWeight")
        .set("X-Service-Secret", "anything")
        .send({ value: 2 });
      expect(res.status).toBe(401);
    });

    it("records the supervisor's own sub as the actor, so a tuning change is attributable", async () => {
      await machineWrite("mine.taskWeight", 3);
      const events = await request(app()).get("/api/automation/v1/autopilot/events?limit=10");
      const changed = findChanged(events.body as EventsBody);
      expect(changed.detail).toMatchObject({ name: "mine.taskWeight", newValue: 3, actor: TEST_MACHINE });
    });
  });

  it("still lets an operator write a model knob directly", async () => {
    const res = await request(app())
      .put("/api/automation/v1/planner/knobs/travel.speedUnitsPerHourPrior").set("Authorization", bearer())
      .send({ value: 45 });
    expect(res.status).toBe(200);
    expect((res.body as KnobBody).knob.value).toBe(45);
    expect((res.body as KnobBody).knob.class).toBe("model");
  });

  it("lets an operator write an alert knob too, and records the operator's sub", async () => {
    const res = await request(app())
      .put("/api/automation/v1/planner/knobs/anomaly.errorRateThreshold").set("Authorization", bearer())
      .send({ value: 0.2 });
    expect(res.status).toBe(200);
    expect((res.body as KnobBody).knob.class).toBe("alert");

    const events = await request(app()).get("/api/automation/v1/autopilot/events?limit=10");
    const changed = findChanged(events.body as EventsBody);
    expect(changed.detail).toMatchObject({ name: "anomaly.errorRateThreshold", newValue: 0.2, actor: TEST_ACTOR });
  });

  it("deletes knobs dropped from the definitions, so no orphan lever survives a redeploy", async () => {
    await pool.query(
      `INSERT INTO knob (name, knob_class, value, default_value, min_value, max_value)
       VALUES ('legacy.removedKnob', 'policy', 1, 1, 0, 10)`
    );
    await syncKnobDefinitions(pool);

    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    const names = (res.body as KnobsBody).knobs.map((k) => k.name);
    expect(names).not.toContain("legacy.removedKnob");
  });

  it("clamps a stored value that no longer fits tightened bounds, instead of leaving it unwritable", async () => {
    await pool.query(`UPDATE knob SET max_value = 1000, value = 1000 WHERE name = 'mine.taskWeight'`);
    const clamps = await syncKnobDefinitions(pool);

    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    const knob = findKnob(res.body as KnobsBody, "mine.taskWeight");
    expect(knob.max).toBe(10);
    expect(knob.value).toBe(10);

    // Reported rather than applied in silence: every API-driven change writes
    // a knob_changed event, and a boot that moves an operator's tuned value
    // owes the audit trail the same. The entrypoint logs these as
    // knob_clamped; without it the log still showed 1000 as the last
    // intended value with nothing marking where the two diverged.
    expect(clamps).toEqual([{ name: "mine.taskWeight", previousValue: 1000, newValue: 10, min: 0, max: 10 }]);
  });

  it("reports nothing when a sync changes no value, so a normal boot is quiet", async () => {
    expect(await syncKnobDefinitions(pool)).toEqual([]);
  });

  it("keeps an operator's tuned value across a redeploy", async () => {
    await request(app()).put("/api/automation/v1/planner/knobs/mine.taskWeight").set("Authorization", bearer()).send({ value: 4 });
    await syncKnobDefinitions(pool);

    const res = await request(app()).get("/api/automation/v1/planner/knobs");
    const knob = findKnob(res.body as KnobsBody, "mine.taskWeight");
    expect(knob.value).toBe(4);
  });
});

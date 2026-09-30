import request from "supertest";
import { Pool } from "pg";
import { MESSAGES } from "@v-m-pioneer-trading/introspection-client";
import { createPool, migrate } from "../db";
import { resetDatabase } from "../testSupport/resetDatabase";
import { createTestApp } from "../testSupport/createTestApp";
import {
  bearer,
  bearerWithoutScope,
  expiredBearer,
  fleetControlOnlyBearer,
  foreignBearer,
  machineBearer,
  TEST_ACTOR,
  TEST_MACHINE,
} from "../testSupport/authTokens";

const V1 = "/api/automation/v1";

/**
 * The gate itself. Everything else in this suite exercises behaviour that
 * happens to be behind authentication; this file is about the authentication.
 *
 * The shape being defended: this service's admin API was reachable from the
 * public internet with no credential at all — `GET /planner/knobs` returned the
 * full knob set to anyone who knew the domain, and every mutating route sat
 * under the same CloudFront-routed prefix.
 *
 * Verification itself is auth-service's (decision 21); `createTestApp` answers
 * for it in-process. What is pinned here is which route needs what, and what
 * a handler does with the identity it is handed. `introspectionWiring.test.ts`
 * does the same over real HTTP, against a stub center.
 */
describe("automation-service authentication", () => {
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
  });

  const app = () => createTestApp(pool);

  describe("reads stay public", () => {
    // The dashboard is meant to be watchable without credentials — the event
    // log especially. A fix that walled these off would defeat the point.
    it.each([
      "/autopilot/status",
      "/autopilot/events",
      "/planner/knobs",
      "/planner/model",
    ])("serves GET %s anonymously", async (path) => {
      const res = await request(app()).get(`${V1}${path}`);
      expect(res.status).toBe(200);
    });

    // ignoreCredentials(): the header is never read, so a dead token riding
    // along on a dashboard read is not a 401.
    it.each(["/autopilot/status", "/planner/knobs"])("serves GET %s with an expired token too", async (path) => {
      const res = await request(app()).get(`${V1}${path}`).set("Authorization", expiredBearer());
      expect(res.status).toBe(200);
    });

    it("serves health anonymously", async () => {
      const res = await request(app()).get("/api/automation/health");
      expect(res.status).toBe(200);
    });
  });

  describe("mutating routes require their scope", () => {
    type Agent = ReturnType<typeof request>;
    const mutations: [string, (agent: Agent) => request.Test][] = [
      ["POST /autopilot/arm", (a) => a.post(`${V1}/autopilot/arm`).send({})],
      ["POST /autopilot/pause", (a) => a.post(`${V1}/autopilot/pause`)],
      ["POST /autopilot/abort", (a) => a.post(`${V1}/autopilot/abort`)],
      ["PUT /planner/knobs/:name", (a) => a.put(`${V1}/planner/knobs/mine.taskWeight`).send({ value: 2 })],
      ["POST /events", (a) => a.post(`${V1}/events`).send({ type: "ai_test" })],
    ];

    it.each(mutations)("rejects %s with no token", async (_name, call) => {
      const res = await call(request(app()));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { message: MESSAGES.missingToken } });
    });

    it.each(mutations)("rejects %s with a token the center calls expired", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", expiredBearer());
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { message: MESSAGES.invalidSession } });
    });

    it.each(mutations)("rejects %s with a token the center calls foreign-signed", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", foreignBearer());
      expect(res.status).toBe(401);
    });

    // 403, not 401: the session is valid, so re-authenticating would only
    // loop. The message is the package's, and does not name the scope.
    it.each(mutations)("rejects %s when the scope is missing", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", bearerWithoutScope());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: MESSAGES.missingScope } });
      expect(JSON.stringify(res.body)).not.toContain("fleet:control");
    });

    it("accepts a valid fleet:control session", async () => {
      const res = await request(app()).post(`${V1}/autopilot/arm`).set("Authorization", bearer()).send({});
      expect(res.status).toBe(200);
    });

    // Decision 22, one literal per route: fleet:control alone reaches neither
    // the audit-write route nor the two planner-advice routes.
    it.each([
      ["POST /events", (a: Agent) => a.post(`${V1}/events`).send({ type: "ai_test" })],
      ["PUT /planner/knobs/:name", (a: Agent) => a.put(`${V1}/planner/knobs/mine.taskWeight`).send({ value: 2 })],
    ] as [string, (agent: Agent) => request.Test][])("refuses %s to fleet:control alone: 403", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", fleetControlOnlyBearer());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: MESSAGES.missingScope } });
    });

    // The machine row in auth-service's table has no fleet:control.
    it.each([
      ["POST /autopilot/arm", (a: Agent) => a.post(`${V1}/autopilot/arm`).send({})],
      ["POST /autopilot/pause", (a: Agent) => a.post(`${V1}/autopilot/pause`)],
      ["POST /autopilot/abort", (a: Agent) => a.post(`${V1}/autopilot/abort`)],
    ] as [string, (agent: Agent) => request.Test][])("refuses %s to the machine token: 403", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", machineBearer());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: MESSAGES.missingScope } });
    });

    // /planner/replan exists only with a scheduler; introspectionWiring.test.ts
    // covers it (this app has none, so it would answer 404 here).
    it("lets the machine token write a policy knob", async () => {
      const knob = await request(app()).put(`${V1}/planner/knobs/mine.taskWeight`).set("Authorization", machineBearer()).send({ value: 2 });
      expect(knob.status).toBe(200);
    });

    it("ignores a non-bearer Authorization scheme", async () => {
      const res = await request(app())
        .post(`${V1}/autopilot/abort`)
        .set("Authorization", `Basic ${Buffer.from("a:b").toString("base64")}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { message: MESSAGES.missingToken } });
    });

    // The shared secret is gone, not merely unchecked: presenting it is the
    // same as presenting nothing.
    it("treats the retired X-Service-Secret header as no credential", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("X-Service-Secret", "anything at all")
        .send({ type: "ai_test" });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { message: MESSAGES.missingToken } });
    });
  });

  describe("POST /events takes events:write from any kind of caller", () => {
    it("accepts the supervisor's machine token", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("Authorization", machineBearer())
        .send({ type: "ai_test", detail: { note: "hello" } });
      expect(res.status).toBe(201);
    });

    it("accepts an operator session too", async () => {
      const res = await request(app()).post(`${V1}/events`).set("Authorization", bearer()).send({ type: "ai_test" });
      expect(res.status).toBe(201);
    });

    it("still refuses to let a caller forge a lifecycle event", async () => {
      const res = await request(app()).post(`${V1}/events`).set("Authorization", machineBearer()).send({ type: "armed" });
      expect(res.status).toBe(400);
    });

    it("stamps the verified sub as detail.actor, overriding whatever the caller wrote there", async () => {
      const gateway = app();
      await request(gateway)
        .post(`${V1}/events`)
        .set("Authorization", machineBearer())
        .send({ type: "ai_intervention", detail: { actor: "user_2SomeoneElse", note: "spoof" } });

      const events = (await request(gateway).get(`${V1}/autopilot/events`)).body.events;
      const logged = events.find((e: { type: string }) => e.type === "ai_intervention");
      expect(logged.detail).toEqual({ actor: TEST_MACHINE, note: "spoof" });
    });
  });

  describe("admin actions record who performed them", () => {
    it("stamps the caller's sub on lifecycle transitions", async () => {
      const gateway = app();
      await request(gateway).post(`${V1}/autopilot/arm`).set("Authorization", bearer({ sub: "user_2Specific" })).send({});
      // A machine by kind, holding fleet:control: the actor is the sub either way.
      await request(gateway)
        .post(`${V1}/autopilot/pause`)
        .set("Authorization", bearer({ sub: TEST_MACHINE, kind: "machine", scopes: ["fleet:control"] }));
      await request(gateway).post(`${V1}/autopilot/abort`).set("Authorization", bearer());

      const events = (await request(gateway).get(`${V1}/autopilot/events`)).body.events;
      const actorOf = (type: string) => events.find((e: { type: string }) => e.type === type).detail.actor;
      expect(actorOf("armed")).toBe("user_2Specific");
      expect(actorOf("paused")).toBe(TEST_MACHINE);
      expect(actorOf("aborted")).toBe(TEST_ACTOR);
    });

    it("stamps the actor on knob changes", async () => {
      const gateway = app();
      await request(gateway).put(`${V1}/planner/knobs/mine.taskWeight`).set("Authorization", bearer()).send({ value: 2 });

      const events = (await request(gateway).get(`${V1}/autopilot/events`)).body.events;
      const changed = events.find((e: { type: string }) => e.type === "knob_changed");
      expect(changed.detail.actor).toBe(TEST_ACTOR);
    });

    it("never writes the session token into the audit trail", async () => {
      const gateway = app();
      const token = bearer();
      await request(gateway).post(`${V1}/autopilot/arm`).set("Authorization", token).send({});
      await request(gateway).post(`${V1}/events`).set("Authorization", token).send({ type: "ai_test" });

      const raw = JSON.stringify((await request(gateway).get(`${V1}/autopilot/events`)).body);
      expect(raw).not.toContain(token.replace("Bearer ", ""));
    });
  });

  it("answers an unknown path with the JSON 404, not Express's HTML one", async () => {
    const res = await request(app()).get(`${V1}/nowhere`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "not found" } });
  });
});

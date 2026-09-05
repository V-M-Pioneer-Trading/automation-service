import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../server";
import { createPool, migrate } from "../db";
import { resetDatabase } from "../testSupport/resetDatabase";
import { createTestApp } from "../testSupport/createTestApp";
import {
  bearer,
  bearerWithoutScope,
  expiredBearer,
  foreignBearer,
  TEST_ACTOR,
  TEST_CLERK_JWT_KEY,
  TEST_SERVICE_SECRET,
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

  describe("refusing to start without a trust anchor", () => {
    it("rejects an empty Clerk key rather than defaulting to open", () => {
      expect(() =>
        createApp({ pool, auth: { clerkJwtKeyPem: "", clerkIssuer: null, aiServiceSecret: "s" } })
      ).toThrow(/clerkJwtKeyPem is required/);
    });

    it("rejects an empty service secret rather than leaving the machine route open", () => {
      expect(() =>
        createApp({
          pool,
          auth: { clerkJwtKeyPem: TEST_CLERK_JWT_KEY, clerkIssuer: null, aiServiceSecret: "" },
        })
      ).toThrow(/aiServiceSecret is required/);
    });
  });

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

    it("serves health anonymously", async () => {
      const res = await request(app()).get("/api/automation/health");
      expect(res.status).toBe(200);
    });
  });

  describe("mutating routes require a session", () => {
    type Agent = ReturnType<typeof request>;
    const mutations: [string, (agent: Agent) => request.Test][] = [
      ["POST /autopilot/arm", (a) => a.post(`${V1}/autopilot/arm`).send({})],
      ["POST /autopilot/pause", (a) => a.post(`${V1}/autopilot/pause`)],
      ["POST /autopilot/abort", (a) => a.post(`${V1}/autopilot/abort`)],
      [
        "PUT /planner/knobs/:name",
        (a) => a.put(`${V1}/planner/knobs/mine.taskWeight`).send({ value: 2 }),
      ],
    ];

    it.each(mutations)("rejects %s with no token", async (_name, call) => {
      const res = await call(request(app()));
      expect(res.status).toBe(401);
    });

    it.each(mutations)("rejects %s with an expired token", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", expiredBearer());
      expect(res.status).toBe(401);
    });

    // The important one: a token that is perfectly formed and carries the right
    // scope, but was signed by a key this service never trusted. If this passes,
    // the service is decoding claims rather than verifying them.
    it.each(mutations)("rejects %s signed by an untrusted key", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", foreignBearer());
      expect(res.status).toBe(401);
    });

    it.each(mutations)("rejects %s with a malformed token", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", "Bearer not-a-jwt");
      expect(res.status).toBe(401);
    });

    // 403, not 401: the session is valid, so re-authenticating would only loop.
    it.each(mutations)("rejects %s when the scope is missing", async (_name, call) => {
      const res = await call(request(app())).set("Authorization", bearerWithoutScope());
      expect(res.status).toBe(403);
    });

    it("accepts a valid fleet:control session", async () => {
      const res = await request(app())
        .post(`${V1}/autopilot/arm`)
        .set("Authorization", bearer())
        .send({});
      expect(res.status).toBe(200);
    });

    it("ignores a non-bearer Authorization scheme", async () => {
      const res = await request(app())
        .post(`${V1}/autopilot/abort`)
        .set("Authorization", `Basic ${Buffer.from("a:b").toString("base64")}`);
      expect(res.status).toBe(401);
    });
  });

  describe("the machine route uses a shared secret, not a Clerk session", () => {
    it("rejects POST /events with no secret", async () => {
      const res = await request(app()).post(`${V1}/events`).send({ type: "ai_test" });
      expect(res.status).toBe(401);
    });

    it("rejects POST /events with a wrong secret", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("X-Service-Secret", "not-the-secret")
        .send({ type: "ai_test" });
      expect(res.status).toBe(401);
    });

    // A human session is deliberately not a substitute: ai-service has no user,
    // and Clerk stays scoped to human identity.
    it("rejects POST /events with an operator session instead of the secret", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("Authorization", bearer())
        .send({ type: "ai_test" });
      expect(res.status).toBe(401);
    });

    it("accepts POST /events with the secret", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("X-Service-Secret", TEST_SERVICE_SECRET)
        .send({ type: "ai_test", detail: { note: "hello" } });
      expect(res.status).toBe(201);
    });

    it("still refuses to let a machine caller forge a lifecycle event", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("X-Service-Secret", TEST_SERVICE_SECRET)
        .send({ type: "armed" });
      expect(res.status).toBe(400);
    });
  });

  describe("admin actions record who performed them", () => {
    it("stamps the Clerk user id on lifecycle transitions", async () => {
      const gateway = app();
      await request(gateway)
        .post(`${V1}/autopilot/arm`)
        .set("Authorization", bearer({ sub: "user_2Specific" }))
        .send({});
      await request(gateway).post(`${V1}/autopilot/abort`).set("Authorization", bearer());

      const events = (await request(gateway).get(`${V1}/autopilot/events`)).body.events;
      const armed = events.find((e: { type: string }) => e.type === "armed");
      const aborted = events.find((e: { type: string }) => e.type === "aborted");
      expect(armed.detail.actor).toBe("user_2Specific");
      expect(aborted.detail.actor).toBe(TEST_ACTOR);
    });

    it("stamps the actor on knob changes", async () => {
      const gateway = app();
      await request(gateway)
        .put(`${V1}/planner/knobs/mine.taskWeight`)
        .set("Authorization", bearer())
        .send({ value: 2 });

      const events = (await request(gateway).get(`${V1}/autopilot/events`)).body.events;
      const changed = events.find((e: { type: string }) => e.type === "knob_changed");
      expect(changed.detail.actor).toBe(TEST_ACTOR);
    });

    it("never writes the session token into the audit trail", async () => {
      const gateway = app();
      const token = bearer();
      await request(gateway)
        .post(`${V1}/autopilot/arm`)
        .set("Authorization", token)
        .send({});

      const raw = JSON.stringify((await request(gateway).get(`${V1}/autopilot/events`)).body);
      expect(raw).not.toContain(token.replace("Bearer ", ""));
    });
  });
});

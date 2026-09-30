/**
 * @file automation-service's wiring of the shared introspection client.
 *
 * The package's own conformance suite drives the fixture cases against its
 * client. What it cannot see is how THIS service mounted it: which routes are
 * public, which need `fleet:control`, that the knob fence keys on the center's
 * `kind`, that the audit trail records the center's `sub`, and that an
 * undeclared route refuses to start. Everything here is real HTTP against a
 * stub center (`stubServers.ts`), with the package's real `fetch` client.
 */

import { createExpressAuth, MESSAGES, secured } from "@v-m-pioneer-trading/introspection-client";
import express from "express";
import { connect } from "net";
import type { AddressInfo } from "net";
import { Pool } from "pg";
import request from "supertest";
import { createPool, migrate } from "../db";
import { createApp } from "../server";
import {
  CONTROL_TOKEN,
  fleetControlOnlyBearer,
  INACTIVE_TOKEN,
  MACHINE_TOKEN,
  SESSION_TOKEN,
  TEST_ACTOR,
  TEST_MACHINE,
} from "../testSupport/authTokens";
import { resetDatabase } from "../testSupport/resetDatabase";
import { startStub, startStubCenter, STUB_SECRET, type Stub } from "../testSupport/stubServers";

const V1 = "/api/automation/v1";

/** Every GET this service serves, with lifecycle-only wiring plus metrics and anomaly on. */
const PUBLIC_READS = [
  "/health",
  "/api/automation/health",
  `${V1}/autopilot/status`,
  `${V1}/autopilot/events`,
  `${V1}/planner/knobs`,
  `${V1}/planner/model`,
  `${V1}/metrics/context`,
  `${V1}/anomalies/digest`,
];

describe("introspection wiring", () => {
  let pool: Pool;
  let center: Stub;
  const apps: express.Express[] = [];

  const appWith = (url: string) => {
    const app = createApp({
      pool,
      auth: createExpressAuth({ url, secret: STUB_SECRET }),
      // Metrics and anomaly on so their GETs are registered too. Intervals
      // long enough never to fire; nothing here needs a tick.
      metrics: { rollupIntervalMs: 3_600_000 },
      anomaly: { webhookUrl: null, intervalMs: 3_600_000 },
    });
    apps.push(app);
    return app;
  };
  const app = () => appWith(`${center.url}/auth/v1/introspect`);

  /** A URL on which nothing listens: the center is down. */
  const downUrl = async () => {
    const down = await startStub(() => ({ status: 200, body: {} }));
    await down.close();
    return `${down.url}/auth/v1/introspect`;
  };

  const eventsOf = async (type: string) =>
    (await request(app()).get(`${V1}/autopilot/events?limit=100`)).body.events.filter(
      (e: { type: string }) => e.type === type
    );

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
    center = await startStubCenter();
  });

  afterAll(async () => {
    await center.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    center.calls.length = 0;
  });

  afterEach(async () => {
    for (const a of apps.splice(0)) await a.locals.stopBackgroundSchedulers();
  });

  describe("public reads declare ignoreCredentials()", () => {
    it.each(PUBLIC_READS)("serves GET %s with no header, never asking the center", async (path) => {
      const res = await request(app()).get(path);

      expect(res.status).toBe(200);
      expect(center.calls).toHaveLength(0);
    });

    // Under allowPublic() the inactive and garbage tokens would be a 401 after
    // a center call; ignoreCredentials() never reads the header at all.
    it.each(PUBLIC_READS)("ignores any bearer on GET %s: 200, and the center is never asked", async (path) => {
      for (const header of [`Bearer ${CONTROL_TOKEN}`, `Bearer ${INACTIVE_TOKEN}`, "Bearer garbage", "Bearer abc def"]) {
        const res = await request(app()).get(path).set("Authorization", header);
        expect(res.status).toBe(200);
      }
      expect(center.calls).toHaveLength(0);
    });

    it.each(PUBLIC_READS)("serves GET %s with a bearer while the center is unreachable", async (path) => {
      const res = await request(appWith(await downUrl())).get(path).set("Authorization", `Bearer ${CONTROL_TOKEN}`);

      expect(res.status).toBe(200);
    });
  });

  describe("mutations declare their scope", () => {
    it("refuses a POST with no header: 401, center not asked", async () => {
      const res = await request(app()).post(`${V1}/autopilot/arm`).send({});

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { message: MESSAGES.missingToken } });
      expect(center.calls).toHaveLength(0);
    });

    it("refuses an inactive token: 401 after one center call", async () => {
      const res = await request(app()).post(`${V1}/autopilot/arm`).set("Authorization", `Bearer ${INACTIVE_TOKEN}`).send({});

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { message: "invalid or expired session" } });
      expect(center.calls).toHaveLength(1);
      expect(await eventsOf("armed")).toHaveLength(0);
    });

    it.each([
      ["POST", `${V1}/autopilot/arm`],
      ["POST", `${V1}/autopilot/pause`],
      ["POST", `${V1}/autopilot/abort`],
      ["POST", `${V1}/events`],
      ["PUT", `${V1}/planner/knobs/mine.taskWeight`],
    ])("refuses %s %s to a session without the scope: 403, generic message", async (method, path) => {
      const res = await request(app())
        [method === "PUT" ? "put" : "post"](path)
        .set("Authorization", `Bearer ${SESSION_TOKEN}`)
        .send({ type: "ai_test", value: 2 });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: "this action requires a scope this session does not carry" } });
      expect(center.calls).toHaveLength(1);
    });

    it.each([
      ["POST", `${V1}/events`],
      ["PUT", `${V1}/planner/knobs/mine.taskWeight`],
    ])("refuses %s %s to fleet:control alone: 403 (decision 22, one literal per route)", async (method, path) => {
      const token = fleetControlOnlyBearer();
      const res = await request(app())
        [method === "PUT" ? "put" : "post"](path)
        .set("Authorization", token)
        .send({ type: "ai_test", value: 2 });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: "this action requires a scope this session does not carry" } });
    });

    it("refuses POST /autopilot/arm to the machine token, which holds no fleet:control", async () => {
      const res = await request(app()).post(`${V1}/autopilot/arm`).set("Authorization", `Bearer ${MACHINE_TOKEN}`).send({});

      expect(res.status).toBe(403);
      expect(await eventsOf("armed")).toHaveLength(0);
    });

    it("lets fleet:control through, asking the center exactly once with the form-encoded token", async () => {
      const res = await request(app()).post(`${V1}/autopilot/arm`).set("Authorization", `Bearer ${CONTROL_TOKEN}`).send({});

      expect(res.status).toBe(200);
      expect(center.calls).toHaveLength(1);
      const [asked] = center.calls;
      expect(asked.method).toBe("POST");
      expect(asked.url).toBe("/auth/v1/introspect");
      expect(asked.headers["x-introspection-secret"]).toBe(STUB_SECRET);
      expect(asked.headers.authorization).toBeUndefined();
      expect(new URLSearchParams(asked.body).get("token")).toBe(CONTROL_TOKEN);
    });

    it("records the center's sub as the actor, whatever the body claims", async () => {
      // A caller with fleet:control may not sign someone else's name: arm,
      // pause and abort take the actor from the verified identity only.
      const armed = app();
      for (const action of ["arm", "pause", "abort"]) {
        await request(armed)
          .post(`${V1}/autopilot/${action}`)
          .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
          .send({ actor: "forged" });
      }

      for (const type of ["armed", "paused", "aborted"]) {
        const [event] = await eventsOf(type);
        expect(event.detail.actor).toBe(TEST_ACTOR);
      }
    });

    it("answers 503 with the fixed sentence when the center is down, and does nothing", async () => {
      const res = await request(appWith(await downUrl()))
        .put(`${V1}/planner/knobs/mine.taskWeight`)
        .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
        .send({ value: 7 });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: { message: "the authentication service could not process this request" } });
      expect(await eventsOf("knob_changed")).toHaveLength(0);
    });

    // No retry budget: one attempt against a failing center, then the 503.
    it("asks a failing center once, never retrying", async () => {
      const failing = await startStub(() => ({ status: 500, body: {} }));
      try {
        const res = await request(appWith(`${failing.url}/auth/v1/introspect`))
          .post(`${V1}/autopilot/arm`)
          .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
          .send({});

        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: { message: MESSAGES.centerUnavailable } });
        expect(failing.calls).toHaveLength(1);
      } finally {
        await failing.close();
      }
    });

    // A repeated key is a malformed answer, not a last-one-wins one: the sub
    // must never be picked by parser order. One attempt, then the 503.
    it("answers 503 when the center's answer repeats a key, asking once", async () => {
      const dup = await startStub(() => ({
        status: 200,
        body: '{"active":true,"sub":"user_a","sub":"user_b","scope":"fleet:control","exp":4102444800,"kind":"operator"}',
      }));
      try {
        const res = await request(appWith(`${dup.url}/auth/v1/introspect`))
          .post(`${V1}/autopilot/arm`)
          .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
          .send({});

        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: { message: "the authentication service could not process this request" } });
        expect(dup.calls).toHaveLength(1);
        expect(await eventsOf("armed")).toHaveLength(0);
      } finally {
        await dup.close();
      }
    });

    it("answers 503 when the center rejects our caller secret, never relaying its 401", async () => {
      const res = await request(createApp({ pool, auth: createExpressAuth({ url: `${center.url}/auth/v1/introspect`, secret: "wrong" }) }))
        .post(`${V1}/autopilot/arm`)
        .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: { message: MESSAGES.centerUnavailable } });
    });

    it.each(["Bearer abc def", "Bearer ", "Bearer", "Basic dXNlcjpwYXNz"])(
      "reads %j as no credential: 401, and the center is never asked",
      async (header) => {
        const res = await request(app()).post(`${V1}/autopilot/arm`).set("Authorization", header).send({});

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: { message: MESSAGES.missingToken } });
        expect(center.calls).toHaveLength(0);
      }
    );

    it("answers an unmatched path with the JSON 404, never asking the center", async () => {
      const res = await request(app()).post(`${V1}/nowhere`).set("Authorization", `Bearer ${CONTROL_TOKEN}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: "not found" } });
      expect(center.calls).toHaveLength(0);
    });
  });

  // cors() must run before anything that could answer the preflight: mounted
  // after the router, Express answers OPTIONS itself with no
  // Access-Control-Allow-Origin, and a browser never sends the POST.
  it("answers a browser's preflight for a guarded POST, never asking the center", async () => {
    const res = await request(app())
      .options(`${V1}/autopilot/arm`)
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
    expect(center.calls).toHaveLength(0);
  });

  describe("a body the parser refuses is the caller's fault, not a 500", () => {
    it("answers malformed JSON with 400 in the usual envelope", async () => {
      const res = await request(app())
        .post(`${V1}/autopilot/arm`)
        .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
        .set("Content-Type", "application/json")
        .send("{not json");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { message: "malformed JSON body" } });
    });

    it("answers an oversized body with 413", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("Authorization", `Bearer ${CONTROL_TOKEN}`)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ type: "ai_test", detail: { pad: "x".repeat(200_000) } }));

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ error: { message: "request body too large" } });
    });
  });

  // The two routes registered only when a ship-driving scheduler is wired.
  // Nothing is armed, so the upstream URLs are never called.
  describe("routes that exist only with mining configured", () => {
    const miningApp = () =>
      createApp({
        pool,
        auth: createExpressAuth({ url: `${center.url}/auth/v1/introspect`, secret: STUB_SECRET }),
        mining: {
          navigationServiceUrl: "http://127.0.0.1:1",
          agentServiceUrl: "http://127.0.0.1:1",
          fleetServiceUrl: "http://127.0.0.1:1",
          miningShipSymbol: "SHIP-1",
          schedulerIntervalMs: 3_600_000,
          replanIntervalMs: 3_600_000,
        },
      });

    it("serves GET /autopilot/ships/:s with a garbage bearer, never asking the center", async () => {
      const res = await request(miningApp()).get(`${V1}/autopilot/ships/SHIP-1`).set("Authorization", "Bearer garbage");

      // The handler's own 404 ("no task yet"), not an auth refusal.
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: "no task for this ship yet" } });
      expect(center.calls).toHaveLength(0);
    });

    it("refuses POST /planner/replan without a header, and serves it to planner:advise", async () => {
      const app = miningApp();
      const anonymous = await request(app).post(`${V1}/planner/replan`);
      expect(anonymous.status).toBe(401);
      expect(center.calls).toHaveLength(0);

      const controlOnly = await request(app).post(`${V1}/planner/replan`).set("Authorization", fleetControlOnlyBearer());
      expect(controlOnly.status).toBe(403);

      const scopeless = await request(app).post(`${V1}/planner/replan`).set("Authorization", `Bearer ${SESSION_TOKEN}`);
      expect(scopeless.status).toBe(403);

      const allowed = await request(app).post(`${V1}/planner/replan`).set("Authorization", `Bearer ${MACHINE_TOKEN}`);
      expect(allowed.status).toBe(200);
      expect(allowed.body).toEqual({ requested: true });
    });
  });

  describe("the knob fence keys on kind", () => {
    const write = (token: string, name: string, value: number) =>
      request(app()).put(`${V1}/planner/knobs/${name}`).set("Authorization", `Bearer ${token}`).send({ value });

    it("lets a machine write a policy knob, recording its mch_ sub", async () => {
      const res = await write(MACHINE_TOKEN, "mine.taskWeight", 3);

      expect(res.status).toBe(200);
      const [changed] = await eventsOf("knob_changed");
      expect(changed.detail).toMatchObject({ name: "mine.taskWeight", newValue: 3, actor: TEST_MACHINE });
      expect(changed.detail.actor).toMatch(/^mch_/);
    });

    it.each([
      ["anomaly.errorRateThreshold", /alert knob/],
      ["travel.speedUnitsPerHourPrior", /model knob/],
    ])("refuses a machine the non-policy knob %s with the knob-class 403", async (name, message) => {
      const res = await write(MACHINE_TOKEN, name, 1);

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(message);
      expect(res.body.error.message).not.toBe(MESSAGES.missingScope);
      expect(await eventsOf("knob_changed")).toHaveLength(0);
    });

    it.each([
      ["mine.taskWeight", 4],
      ["anomaly.errorRateThreshold", 0.2],
      ["travel.speedUnitsPerHourPrior", 45],
    ])("lets an operator write %s, recording its user_ sub", async (name, value) => {
      const res = await write(CONTROL_TOKEN, name, value);

      expect(res.status).toBe(200);
      const [changed] = await eventsOf("knob_changed");
      expect(changed.detail).toMatchObject({ name, newValue: value, actor: TEST_ACTOR });
    });
  });

  describe("POST /events", () => {
    it("records detail.actor as the caller's sub, overriding the caller's own", async () => {
      const res = await request(app())
        .post(`${V1}/events`)
        .set("Authorization", `Bearer ${MACHINE_TOKEN}`)
        .send({ type: "ai_intervention", detail: { actor: "ai-service", rationale: "r" } });

      expect(res.status).toBe(201);
      const [logged] = await eventsOf("ai_intervention");
      expect(logged.detail).toEqual({ actor: TEST_MACHINE, rationale: "r" });
    });

    it("records an operator's sub the same way", async () => {
      await request(app()).post(`${V1}/events`).set("Authorization", `Bearer ${CONTROL_TOKEN}`).send({ type: "ai_no_action" });

      const [logged] = await eventsOf("ai_no_action");
      expect(logged.detail).toEqual({ actor: TEST_ACTOR });
    });
  });

  /**
   * Two `Authorization` lines are never a credential (fixture v4, client
   * README P7). Node's parser keeps the first line and discards the rest, so
   * read naively a caller would choose which credential is verified by
   * choosing the order, or turn a credentialed request into a visitor with an
   * empty first line. The client counts the lines in `rawHeaders`, and any
   * count other than one is no credential. The requests are written to a raw
   * socket as real separate lines, because no HTTP client library sends two.
   */
  describe("two Authorization lines are no credential", () => {
    const raw = async (
      method: "GET" | "POST",
      path: string,
      lines: string[]
    ): Promise<{ status: number; body: unknown }> => {
      const server = app().listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const { port } = server.address() as AddressInfo;
      try {
        const response = await new Promise<string>((resolve, reject) => {
          const socket = connect(port, "127.0.0.1");
          let data = "";
          socket.on("data", (chunk) => (data += chunk.toString("utf8")));
          socket.on("end", () => resolve(data));
          socket.on("error", reject);
          const body = method === "POST" ? "{}" : "";
          socket.write(
            [
              `${method} ${path} HTTP/1.1`,
              `Host: 127.0.0.1:${port}`,
              ...lines,
              ...(method === "POST" ? ["Content-Type: application/json"] : []),
              `Content-Length: ${body.length}`,
              "Connection: close",
              "",
              body,
            ].join("\r\n")
          );
        });
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]);
        const text = response.slice(response.indexOf("\r\n\r\n") + 4);
        return { status, body: text.length > 0 ? JSON.parse(text) : null };
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };

    it.each([
      ["both lines the same full credential", [`Authorization: Bearer ${CONTROL_TOKEN}`, `Authorization: Bearer ${CONTROL_TOKEN}`]],
      ["a full first line and an empty second", [`Authorization: Bearer ${CONTROL_TOKEN}`, "Authorization:"]],
      ["an empty first line and a full second", ["Authorization:", `Authorization: Bearer ${CONTROL_TOKEN}`]],
      ["a scopeless session first and fleet:control second", [`Authorization: Bearer ${SESSION_TOKEN}`, `authorization: Bearer ${CONTROL_TOKEN}`]],
    ])("refuses a write carrying %s: 401, and the center is never asked", async (_name, lines) => {
      const res = await raw("POST", `${V1}/autopilot/arm`, lines);

      expect(res).toEqual({ status: 401, body: { error: { message: "a bearer token is required" } } });
      expect(center.calls).toHaveLength(0);
      expect(await eventsOf("armed")).toHaveLength(0);
    });

    it("still serves a public GET carrying two lines: ignoreCredentials() reads neither", async () => {
      const res = await raw("GET", `${V1}/autopilot/status`, [
        `Authorization: Bearer ${CONTROL_TOKEN}`,
        `Authorization: Bearer ${INACTIVE_TOKEN}`,
      ]);

      expect(res.status).toBe(200);
      expect(center.calls).toHaveLength(0);
    });

    // The control case: the same harness with one line is a credential, so
    // the refusals above are about the count, not about the raw socket.
    it("serves the same write carrying one line", async () => {
      const res = await raw("POST", `${V1}/autopilot/arm`, [`Authorization: Bearer ${CONTROL_TOKEN}`]);

      expect(res.status).toBe(200);
      expect(center.calls).toHaveLength(1);
    });
  });

  describe("an undeclared route refuses to start", () => {
    // The same secured() createApp uses on its app and its API router. A
    // route added without a declaration is a boot failure, not an open route.
    it.each(["get", "post", "put"] as const)("refuses %s without a declaration", (method) => {
      const router = secured(express.Router());
      expect(() => router[method]("/new-route", (_req, res) => res.json({}))).toThrow(
        /registered without an authorization declaration/
      );
    });

    it("refuses ignoreCredentials() on a mutation", () => {
      const auth = createExpressAuth({ url: `${center.url}/auth/v1/introspect`, secret: STUB_SECRET });
      const router = secured(express.Router());
      expect(() => router.post("/new-route", auth.ignoreCredentials(), (_req, res) => res.json({}))).toThrow(
        /ignoreCredentials\(\)/
      );
    });

    it("builds the real app without tripping either rule", () => {
      expect(() => app()).not.toThrow();
    });

    // Proof the returned app is secured() rather than a plain Express app: the
    // package refuses a route registered behind its notFound() terminal, which
    // only a secured target checks. A plain app would accept this silently.
    it("hands back an app that is itself secured: a late route is refused", () => {
      const built = app();
      expect(() => built.get("/late-addition", (_req, res) => res.json({}))).toThrow(
        /registered after a notFound\(\) handler/
      );
    });
  });
});

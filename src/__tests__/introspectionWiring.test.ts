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

  describe("mutations declare fleet:control", () => {
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

    it("refuses POST /planner/replan without a header, and serves it to fleet:control", async () => {
      const app = miningApp();
      const anonymous = await request(app).post(`${V1}/planner/replan`);
      expect(anonymous.status).toBe(401);
      expect(center.calls).toHaveLength(0);

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
   * Two `Authorization` lines, written to a raw socket because no client
   * library will send them. Node keeps the FIRST line and discards the rest.
   *
   * Client 1.1.1 (the version installed here) verifies that first line, so a
   * caller chooses which credential is checked by choosing the order. 1.1.2
   * counts `rawHeaders` and reads two lines as no credential: 401, no center
   * call. These assertions pin 1.1.1's behaviour; bumping the pin makes them
   * fail, and the fix then is to assert 1.1.2's answer instead.
   */
  describe("two Authorization lines (client 1.1.1)", () => {
    const raw = async (lines: string[]): Promise<number> => {
      const server = app().listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const { port } = server.address() as AddressInfo;
      try {
        return await new Promise<number>((resolve, reject) => {
          const socket = connect(port, "127.0.0.1");
          let data = "";
          socket.on("data", (chunk) => {
            data += chunk.toString("latin1");
            const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
            if (match) {
              socket.destroy();
              resolve(Number(match[1]));
            }
          });
          socket.on("error", reject);
          socket.write(
            [
              `POST ${V1}/autopilot/arm HTTP/1.1`,
              `Host: 127.0.0.1:${port}`,
              ...lines,
              "Content-Type: application/json",
              "Content-Length: 2",
              "Connection: close",
              "",
              "{}",
            ].join("\r\n")
          );
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    };

    it("verifies the first line only: inactive first is 401", async () => {
      const status = await raw([`Authorization: Bearer ${INACTIVE_TOKEN}`, `authorization: Bearer ${CONTROL_TOKEN}`]);

      expect(status).toBe(401);
      expect(center.calls).toHaveLength(1);
      expect(new URLSearchParams(center.calls[0].body).get("token")).toBe(INACTIVE_TOKEN);
    });

    it("verifies the first line only: control first is served", async () => {
      const status = await raw([`Authorization: Bearer ${CONTROL_TOKEN}`, `authorization: Bearer ${INACTIVE_TOKEN}`]);

      expect(status).toBe(200);
      expect(center.calls).toHaveLength(1);
      expect(new URLSearchParams(center.calls[0].body).get("token")).toBe(CONTROL_TOKEN);
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

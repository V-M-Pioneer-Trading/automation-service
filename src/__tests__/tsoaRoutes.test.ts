import { ValidateError } from "@tsoa/runtime";
import { createExpressAuth } from "@v-m-pioneer-trading/clerk-client";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import request from "supertest";
import { routePolicy } from "../auth";
import { createPool, migrate } from "../db";
import { createApp } from "../server";
import { bearer, inProcessIntrospector } from "../testSupport/authTokens";
import { createTestApp } from "../testSupport/createTestApp";
import { databaseUrl } from "../testSupport/databaseUrl";
import { resetDatabase } from "../testSupport/resetDatabase";

const V1 = "/api/automation/v1";

describe("the tsoa routes in createApp", () => {
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

  const build = (extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
    createApp({ pool, auth: createExpressAuth(inProcessIntrospector), ...extra });

  it("refuses startup when a registered route has no policy entry", () => {
    const withoutHealth = Object.fromEntries(Object.entries(routePolicy).filter(([key]) => key !== "GET /health")) as typeof routePolicy;
    expect(() => build({ policy: withoutHealth })).toThrow(/route GET \/health declares no credential requirement/);
  });

  it("refuses startup for a route registered through the registrar that the policy does not list", () => {
    expect(() =>
      build({
        registerRoutes: (registrar) => {
          (registrar.get as (path: string, h: unknown) => void)("/unlisted", () => undefined);
        },
      })
    ).toThrow(/route GET \/unlisted declares no credential requirement/);
  });

  it("does not register the ship route without a fleet scheduler: the request falls through to notFound()", async () => {
    const res = await request(createTestApp(pool)).get(`${V1}/autopilot/ships/MINING-1`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { message: "not found" } });
  });

  it("answers a tsoa validation error in the service's error shape", async () => {
    const app = build({
      policy: { ...routePolicy, "GET /throwaway": "ignore" },
      registerRoutes: (registrar) => {
        (registrar.get as (path: string, h: unknown) => void)("/throwaway", (_req: Request, _res: Response, next: NextFunction) => {
          next(new ValidateError({ "body.x": { message: "x is required", value: undefined } }, "bad input"));
        });
      },
    });
    const res = await request(app).get("/throwaway");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: "x is required" } });
  });

  it("reads limit itself: a repeated limit is the default, not a 400", async () => {
    const res = await request(createTestApp(pool)).get(`${V1}/autopilot/events?limit=1&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });

  it("answers an arm mode outside the enum in the service's error shape", async () => {
    const res = await request(createTestApp(pool)).post(`${V1}/autopilot/arm`).set("Authorization", bearer()).send({ mode: "turbo" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: 'mode must be "live" or "shadow"' } });
  });
});

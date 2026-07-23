import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../server";
import { createPool, migrate } from "../db";

describe("automation-service health endpoint", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each(["/health", "/api/automation/health"])(
    "returns 200 ok without requiring a token at %s",
    async (path) => {
      const res = await request(createApp(pool)).get(path);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  );

  it("does not emit an ETag, so a client replaying one from an earlier response can't degrade this to a bodyless 304", async () => {
    const res = await request(createApp(pool))
      .get("/health")
      .set("If-None-Match", 'W/"stale-etag-from-a-previous-poll"');

    expect(res.headers["etag"]).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

import { configFromEnv } from "../config";

/**
 * The introspection settings are required: a service that started without
 * the center would answer 503 to every guarded request and look like an auth
 * outage. `configFromEnv()` must refuse, naming the variable, before a port is
 * bound — and never echo the secret while doing so.
 */
describe("configFromEnv: auth-service introspection", () => {
  const SECRET = "s3cr3t-introspection-value";
  const saved = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...saved,
      DATABASE_URL: "postgres://x",
      NAVIGATION_SERVICE_URL: "http://nav",
      AGENT_SERVICE_URL: "http://agent",
      FLEET_SERVICE_URL: "http://fleet",
      MINING_SHIP_SYMBOL: "SHIP-1",
      AUTH_INTROSPECTION_URL: "http://localhost:3005/auth/v1/introspect",
      AUTH_INTROSPECTION_SECRET: SECRET,
    };
  });

  afterAll(() => {
    process.env = saved;
  });

  const refusal = (): Error => {
    try {
      configFromEnv();
    } catch (err) {
      return err as Error;
    }
    throw new Error("configFromEnv() did not refuse");
  };

  it("loads both when set, and passes the URL through verbatim", () => {
    expect(configFromEnv().introspection).toEqual({
      url: "http://localhost:3005/auth/v1/introspect",
      secret: SECRET,
    });
  });

  it("refuses to start without AUTH_INTROSPECTION_URL, without echoing the secret", () => {
    delete process.env.AUTH_INTROSPECTION_URL;

    const err = refusal();
    expect(err.message).toContain("AUTH_INTROSPECTION_URL");
    expect(err.message).not.toContain(SECRET);
  });

  it("refuses to start without AUTH_INTROSPECTION_SECRET", () => {
    delete process.env.AUTH_INTROSPECTION_SECRET;

    expect(refusal().message).toContain("AUTH_INTROSPECTION_SECRET");
  });

  it("refuses a blank secret the same as a missing one", () => {
    process.env.AUTH_INTROSPECTION_SECRET = "   ";

    expect(refusal().message).toContain("AUTH_INTROSPECTION_SECRET");
  });

  it("refuses a malformed URL without echoing the secret", () => {
    process.env.AUTH_INTROSPECTION_URL = "not a url";

    const err = refusal();
    expect(err.message).toContain("AUTH_INTROSPECTION_URL");
    expect(err.message).not.toContain(SECRET);
  });
});

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
      AUTH_M2M_TOKEN_URL: "http://localhost:3005/auth/v1/m2m-token",
      AUTH_M2M_CALLER_SECRET: "s3cr3t-caller-value",
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

/**
 * The webhook body format (#47): unset is the original generic body, and a
 * value that is not one of the three is refused at boot rather than every
 * page being rejected by the chat service later.
 */
describe("configFromEnv: ANOMALY_WEBHOOK_FORMAT", () => {
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
      AUTH_INTROSPECTION_SECRET: "introspection-secret",
      AUTH_M2M_TOKEN_URL: "http://localhost:3005/auth/v1/m2m-token",
      AUTH_M2M_CALLER_SECRET: "s3cr3t-caller-value",
    };
    delete process.env.ANOMALY_WEBHOOK_FORMAT;
  });

  afterAll(() => {
    process.env = saved;
  });

  it.each([undefined, ""])("defaults to generic when %p", (value) => {
    if (value !== undefined) process.env.ANOMALY_WEBHOOK_FORMAT = value;
    expect(configFromEnv().anomalyWebhookFormat).toBe("generic");
  });

  it.each(["generic", "discord", "slack"])("accepts %s", (format) => {
    process.env.ANOMALY_WEBHOOK_FORMAT = format;
    expect(configFromEnv().anomalyWebhookFormat).toBe(format);
  });

  it.each(["Discord", "teams", " slack"])("refuses %p at startup, naming the variable", (format) => {
    process.env.ANOMALY_WEBHOOK_FORMAT = format;
    expect(() => configFromEnv()).toThrow(/^ANOMALY_WEBHOOK_FORMAT must be one of generic, discord, slack/);
  });
});

/**
 * The machine-token variables are checked here too, not only when the source
 * is built, because the entrypoint runs `migrate()` between the two: a
 * deployment missing them must be refused before it touches the database.
 */
describe("configFromEnv: auth-service machine token", () => {
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
      AUTH_INTROSPECTION_SECRET: "introspection-secret",
      AUTH_M2M_TOKEN_URL: "http://localhost:3005/auth/v1/m2m-token",
      AUTH_M2M_CALLER_SECRET: "s3cr3t-caller-value",
    };
  });

  afterAll(() => {
    process.env = saved;
  });

  it("loads with both set", () => {
    expect(() => configFromEnv()).not.toThrow();
  });

  it.each(["AUTH_M2M_TOKEN_URL", "AUTH_M2M_CALLER_SECRET"])("refuses to start without %s", (name) => {
    Reflect.deleteProperty(process.env, name);

    expect(() => configFromEnv()).toThrow(`${name} must be set`);
  });

  it.each(["AUTH_M2M_TOKEN_URL", "AUTH_M2M_CALLER_SECRET"])("refuses an empty %s", (name) => {
    process.env[name] = "";

    expect(() => configFromEnv()).toThrow(`${name} must be set`);
  });

  it("does not echo the caller secret when refusing", () => {
    delete process.env.AUTH_M2M_TOKEN_URL;

    expect(() => configFromEnv()).not.toThrow(/s3cr3t-caller-value/);
  });
});

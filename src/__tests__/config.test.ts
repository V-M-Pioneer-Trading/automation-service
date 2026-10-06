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
 * value that is not one of the two is refused at boot rather than every
 * page being rejected by the chat service later. Telegram needs a chat id,
 * and a chat id needs Telegram.
 */
describe("configFromEnv: ANOMALY_WEBHOOK_FORMAT and ANOMALY_TELEGRAM_CHAT_ID", () => {
  const BOT_TOKEN = "987654321:AAH-SECRETtokenPART_xyz";
  const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

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
    delete process.env.ANOMALY_TELEGRAM_CHAT_ID;
    delete process.env.ANOMALY_WEBHOOK_URL;
  });

  const refusal = (): string => {
    try {
      configFromEnv();
    } catch (err) {
      return String(err);
    }
    throw new Error("configFromEnv() did not refuse");
  };

  afterAll(() => {
    process.env = saved;
  });

  it.each([undefined, ""])("defaults to generic when %p", (value) => {
    if (value !== undefined) process.env.ANOMALY_WEBHOOK_FORMAT = value;
    expect(configFromEnv().anomalyWebhookFormat).toBe("generic");
  });

  it("accepts generic, with no chat id", () => {
    process.env.ANOMALY_WEBHOOK_FORMAT = "generic";
    expect(configFromEnv()).toMatchObject({ anomalyWebhookFormat: "generic", anomalyTelegramChatId: null });
  });

  it.each(["123456789", "-1001234567890", "@my_channel"])("accepts telegram with chat id %p and a Bot API URL", (chatId) => {
    process.env.ANOMALY_WEBHOOK_FORMAT = "telegram";
    process.env.ANOMALY_TELEGRAM_CHAT_ID = chatId;
    process.env.ANOMALY_WEBHOOK_URL = TELEGRAM_URL;
    expect(configFromEnv()).toMatchObject({ anomalyWebhookFormat: "telegram", anomalyTelegramChatId: chatId, anomalyWebhookUrl: TELEGRAM_URL });
  });

  it.each(["discord", "slack", "Telegram", "teams", " generic"])("refuses %p at startup, naming the variable", (format) => {
    process.env.ANOMALY_WEBHOOK_FORMAT = format;
    expect(() => configFromEnv()).toThrow(/^ANOMALY_WEBHOOK_FORMAT must be one of generic, telegram,/);
  });

  it.each([undefined, ""])("refuses telegram without a chat id (%p)", (chatId) => {
    process.env.ANOMALY_WEBHOOK_FORMAT = "telegram";
    if (chatId !== undefined) process.env.ANOMALY_TELEGRAM_CHAT_ID = chatId;
    expect(refusal()).toContain("ANOMALY_TELEGRAM_CHAT_ID must be set when ANOMALY_WEBHOOK_FORMAT is telegram");
  });

  it.each(["12a", "@abc", "-", "--5", "@has-dash", "1".repeat(21), "@" + "a".repeat(33), "123 ", "+123"])("refuses chat id %p", (chatId) => {
    process.env.ANOMALY_WEBHOOK_FORMAT = "telegram";
    process.env.ANOMALY_TELEGRAM_CHAT_ID = chatId;
    expect(refusal()).toContain("ANOMALY_TELEGRAM_CHAT_ID must be a numeric chat id");
  });

  it.each([undefined, "generic"])("refuses a chat id when the format is %p", (format) => {
    if (format !== undefined) process.env.ANOMALY_WEBHOOK_FORMAT = format;
    process.env.ANOMALY_TELEGRAM_CHAT_ID = "123456789";
    expect(refusal()).toContain("ANOMALY_TELEGRAM_CHAT_ID is set but ANOMALY_WEBHOOK_FORMAT is not telegram");
  });

  it.each([
    `http://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`,
    `https://evil.example/bot${BOT_TOKEN}/sendMessage`,
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=1`,
    "https://discord.com/api/webhooks/1/x",
  ])("refuses telegram with a URL that is not a Bot API sendMessage URL, without quoting it (%#)", (url) => {
    process.env.ANOMALY_WEBHOOK_FORMAT = "telegram";
    process.env.ANOMALY_TELEGRAM_CHAT_ID = "123456789";
    process.env.ANOMALY_WEBHOOK_URL = url;
    const message = refusal();
    expect(message).toContain("ANOMALY_WEBHOOK_URL must be https://api.telegram.org/bot<token>/sendMessage");
    expect(message).not.toContain(BOT_TOKEN.split(":")[1]);
    expect(message).not.toContain("discord.com");
  });

  it("allows telegram with no URL: detection runs, nothing is sent", () => {
    process.env.ANOMALY_WEBHOOK_FORMAT = "telegram";
    process.env.ANOMALY_TELEGRAM_CHAT_ID = "123456789";
    expect(configFromEnv()).toMatchObject({ anomalyWebhookUrl: null, anomalyWebhookFormat: "telegram" });
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

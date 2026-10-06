import type { Anomaly } from "../anomaly";
import { CHAT_MESSAGE_MAX_CHARS, WebhookDelivery, anomalyLine, chatBody, type WebhookFormat } from "../webhookDelivery";

/**
 * The webhook body formats (#47). Discord and Slack reject the generic body
 * with 400, and the raw `detail` must never reach a chat channel: some types
 * carry upstream error text (#45) or free text. No database needed.
 */

const DETECTED_AT = "2026-10-06T12:34:56.000Z";

const anomaly = (type: string, detail: Record<string, unknown>): Anomaly => ({
  id: "42",
  type,
  dedupeKey: `${type}:key`,
  detectedAt: DETECTED_AT,
  detail,
  deliveredAt: null,
  deliveryAttempts: 0,
});

/** Every anomaly type with the detail shape its producer writes (anomaly.ts, autopilotLifecycle.ts, scheduler.ts). */
const SAMPLES: Record<string, Record<string, unknown>> = {
  ship_idle: { shipSymbol: "VMPT-1", idleMinutes: 42.4, thresholdMinutes: 10, phase: "TRAVEL_TO_ASTEROID", waitingUntil: null },
  earnings_stalled: { reasons: ["profit_drop", "no_earnings"], latestCreditsPerHour: 10, avg6hCreditsPerHour: 100, fraction: 0.5 },
  consecutive_failures: { shipSymbol: "VMPT-1", failureCount: 3, limit: 3 },
  error_rate: { rate: 0.25, threshold: 0.1, windowMinutes: 5, totalEvents: 8, errorEvents: 2 },
  market_stale: { market: "X1-AB12-C3", staleMinutes: 45, lastRefreshedAt: "2026-10-06T11:49:56.000Z", thresholdMinutes: 30 },
  repeated_denied: {
    shipSymbol: "VMPT-1",
    configuredShipSymbol: "VMPT-1",
    source: "tick",
    request: "GET /ships/VMPT-1: 403 Agent does not own ship",
    consecutiveFailures: 5,
  },
  autopilot_resumed_in_shadow: {
    message: "autopilot resumed in shadow after restart; was live; re-arm live to continue trading",
    was: { status: "armed", mode: "live" },
    now: { status: "armed", mode: "shadow" },
    lastWrittenBy: "user_2abc",
    lastWrittenAt: "2026-10-06T10:00:00.000Z",
    actor: "system:restart",
  },
};

const EXPECTED_SUMMARIES: Record<string, string> = {
  ship_idle: "ship `VMPT-1`, idle 42 min, threshold 10 min, phase `TRAVEL_TO_ASTEROID`",
  earnings_stalled: "reasons `profit_drop` `no_earnings`",
  consecutive_failures: "ship `VMPT-1`, 3 failures in a row, limit 3",
  error_rate: "error rate 25.0%, threshold 10.0%, 2 of 8 events, over 5 min",
  market_stale: "market `X1-AB12-C3`, 45 min since read, threshold 30 min",
  repeated_denied: "ship `VMPT-1`, source `tick`, 5 denied in a row",
  autopilot_resumed_in_shadow: "was `armed` `live`, now shadow; re-arm live to continue trading",
};

/** Replaces every string anywhere in a detail with `value`, keeping its shape. */
const poison = (detail: unknown, value: string): unknown => {
  if (typeof detail === "string") return value;
  if (Array.isArray(detail)) return detail.map((d) => poison(d, value));
  if (typeof detail === "object" && detail !== null) {
    return Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, poison(v, value)]));
  }
  return detail;
};

describe("webhook body formats", () => {
  let posted: { url: string; body: string }[];
  let status: number;

  beforeEach(() => {
    posted = [];
    status = 204;
    jest.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      posted.push({ url: input instanceof Request ? input.url : input.toString(), body: typeof init?.body === "string" ? init.body : "" });
      return Promise.resolve(new Response(null, { status }));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const deliver = async (format: WebhookFormat | undefined, a: Anomaly): Promise<Record<string, unknown>> => {
    const delivery = new WebhookDelivery({ url: "http://hook.test/x", format, sleep: () => Promise.resolve() });
    expect(await delivery.deliver(a)).toBe(true);
    expect(posted).toHaveLength(1);
    return JSON.parse(posted[0].body) as Record<string, unknown>;
  };

  it("keeps the original generic body, raw detail included, when no format is given", async () => {
    const a = anomaly("repeated_denied", SAMPLES.repeated_denied);
    expect(await deliver(undefined, a)).toEqual({
      id: "42",
      type: "repeated_denied",
      dedupeKey: "repeated_denied:key",
      detectedAt: DETECTED_AT,
      detail: SAMPLES.repeated_denied,
    });
  });

  it("sends Discord {content} with mentions disabled, and nothing else", async () => {
    const body = await deliver("discord", anomaly("ship_idle", SAMPLES.ship_idle));
    expect(body).toEqual({
      content: `automation-service anomaly \`ship_idle\` at ${DETECTED_AT}: ${EXPECTED_SUMMARIES.ship_idle}`,
      allowed_mentions: { parse: [] },
    });
  });

  it("sends Slack {text}, and nothing else", async () => {
    const body = await deliver("slack", anomaly("error_rate", SAMPLES.error_rate));
    expect(body).toEqual({ text: `automation-service anomaly \`error_rate\` at ${DETECTED_AT}: ${EXPECTED_SUMMARIES.error_rate}` });
  });

  it.each(Object.keys(SAMPLES))("summarizes %s from its safe fields", (type) => {
    expect(anomalyLine(anomaly(type, SAMPLES[type]))).toBe(`automation-service anomaly \`${type}\` at ${DETECTED_AT}: ${EXPECTED_SUMMARIES[type]}`);
  });

  it("names a market never read in person", () => {
    expect(anomalyLine(anomaly("market_stale", { ...SAMPLES.market_stale, staleMinutes: null }))).toContain("never read in person");
  });

  it("falls back to just the type for a type it does not know", () => {
    const line = anomalyLine(anomaly("brand_new_check", { message: "anything", count: 3 }));
    expect(line).toBe(`automation-service anomaly \`brand_new_check\` at ${DETECTED_AT}`);
  });

  it("does not treat inherited object keys as anomaly types", () => {
    expect(anomalyLine(anomaly("constructor", {}))).toBe(`automation-service anomaly \`constructor\` at ${DETECTED_AT}`);
  });

  const LEAK = "https://internal.example:8443/ships/VMPT-1?token=abc";

  it.each(
    (["discord", "slack"] as const).flatMap((format) => [...Object.keys(SAMPLES), "brand_new_check"].map((type) => [format, type] as const))
  )("%s: a URL in any string field of %s's detail never reaches the body", async (format, type) => {
    const detail = poison(SAMPLES[type] ?? { message: "x" }, LEAK) as Record<string, unknown>;
    const a = { ...anomaly(type, detail), dedupeKey: LEAK };
    const raw = JSON.stringify(await deliver(format, a));
    expect(raw).not.toContain("internal.example");
    expect(raw).not.toContain("://");
    expect(raw).not.toContain("token=abc");
    expect(raw).toContain(`\`${type}\``);
  });

  it("drops the upstream request text from repeated_denied even when it is not a URL", async () => {
    const raw = JSON.stringify(await deliver("discord", anomaly("repeated_denied", SAMPLES.repeated_denied)));
    expect(raw).not.toContain("does not own");
    expect(raw).not.toContain("/ships/");
  });

  it("drops the free-text message and caller identity from the resume alert", async () => {
    const raw = JSON.stringify(await deliver("slack", anomaly("autopilot_resumed_in_shadow", SAMPLES.autopilot_resumed_in_shadow)));
    expect(raw).not.toContain("user_2abc");
    expect(raw).not.toContain("after restart");
  });

  it("cannot be made to ping by a field value", async () => {
    const detail = { ...SAMPLES.consecutive_failures, shipSymbol: "@everyone" };
    expect(JSON.stringify(await deliver("discord", anomaly("consecutive_failures", detail)))).not.toContain("@everyone");
  });

  it("cannot be made to ping a Slack channel by a field value", async () => {
    const detail = { ...SAMPLES.market_stale, market: "<!channel>" };
    expect(JSON.stringify(await deliver("slack", anomaly("market_stale", detail)))).not.toContain("<!channel>");
  });

  it("retries a chat body with backoff like the generic one", async () => {
    status = 400;
    const delays: number[] = [];
    const delivery = new WebhookDelivery({
      url: "http://hook.test/x",
      format: "discord",
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(await delivery.deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toBe(false);
    expect(posted).toHaveLength(3);
    expect(delays).toEqual([200, 400]);
  });
});

describe("chat message length cap", () => {
  it.each(["discord", "slack"] as const)("%s: caps a long message at 2000 characters", (format) => {
    const body = chatBody(format, "x".repeat(CHAT_MESSAGE_MAX_CHARS + 1000));
    const text = String(format === "discord" ? body.content : body.text);
    expect(CHAT_MESSAGE_MAX_CHARS).toBe(2000);
    expect(text).toHaveLength(2000);
    expect(text.endsWith("...")).toBe(true);
  });

  it("leaves a message of exactly the limit untouched", () => {
    const exact = "y".repeat(CHAT_MESSAGE_MAX_CHARS);
    expect(chatBody("discord", exact).content).toBe(exact);
  });
});

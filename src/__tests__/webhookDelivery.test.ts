import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Anomaly } from "../anomaly";
import {
  CHAT_MESSAGE_MAX_CHARS,
  TELEGRAM_TEXT_MAX_CHARS,
  WebhookDelivery,
  anomalyLine,
  describeFetchFailure,
  telegramBody,
  type WebhookFormat,
} from "../webhookDelivery";

/**
 * The webhook body formats (#47). Telegram's Bot API rejects the generic body,
 * the raw `detail` must never reach a chat (some types carry free text, and
 * before #45 `repeated_denied` carried upstream error text), and the Telegram
 * URL holds the bot token, so it must never reach a log line. No database
 * needed, and no real Telegram: every POST goes to a mock or to localhost.
 */

const DETECTED_AT = "2026-10-06T12:34:56.000Z";
const CHAT_ID = "-1001234567890";
/** Shaped like a real Bot API URL; the token parts are what the log assertions look for. */
const BOT_TOKEN = "987654321:AAH-SECRETtokenPART_xyz";
const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

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
    request: "GET /api/agent/v1/ships/VMPT-1: 403 (code 4214)",
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

const telegramOk = (): Response => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
const telegramError = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ ok: false, ...body }), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Everything written to the console during a test, one string. */
const spyConsole = (): (() => string) => {
  const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
  return () => spies.flatMap((s) => s.mock.calls.map((args: unknown[]) => args.map((a) => (a instanceof Error ? `${String(a)} ${String(a.stack)}` : String(a))).join(" "))).join("\n");
};

const delivery = (format: WebhookFormat | undefined, extra: { sleep?: (ms: number) => Promise<void>; url?: string } = {}): WebhookDelivery =>
  new WebhookDelivery({
    url: extra.url ?? (format === "telegram" ? TELEGRAM_URL : "http://hook.test/x"),
    format,
    telegramChatId: format === "telegram" ? CHAT_ID : undefined,
    sleep: extra.sleep ?? (() => Promise.resolve()),
  });

const recordingSleep = (): { delays: number[]; sleep: (ms: number) => Promise<void> } => {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
};

describe("webhook body formats", () => {
  let posted: { url: string; body: string }[];
  let respond: () => Response;
  let logs: () => string;

  beforeEach(() => {
    posted = [];
    respond = () => new Response(null, { status: 204 });
    logs = spyConsole();
    jest.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      posted.push({ url: input instanceof Request ? input.url : input.toString(), body: typeof init?.body === "string" ? init.body : "" });
      return Promise.resolve(respond());
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const deliver = async (format: WebhookFormat | undefined, a: Anomaly): Promise<Record<string, unknown>> => {
    if (format === "telegram") respond = telegramOk;
    expect(await delivery(format).deliver(a)).toEqual({ delivered: true, rateLimited: false });
    expect(posted).toHaveLength(1);
    return JSON.parse(posted[0].body) as Record<string, unknown>;
  };

  it("keeps the original generic body, raw detail included, when no format is given", async () => {
    const a = anomaly("repeated_denied", SAMPLES.repeated_denied);
    await deliver(undefined, a);
    // Byte-identical to the pre-#47 body, key order included.
    expect(posted[0].body).toBe(
      JSON.stringify({ id: "42", type: "repeated_denied", dedupeKey: "repeated_denied:key", detectedAt: DETECTED_AT, detail: SAMPLES.repeated_denied })
    );
  });

  it("posts Telegram sendMessage {chat_id, text, disable_web_page_preview} to the configured URL, with no parse_mode", async () => {
    const body = await deliver("telegram", anomaly("ship_idle", SAMPLES.ship_idle));
    expect(posted[0].url).toBe(TELEGRAM_URL);
    expect(body).toEqual({
      chat_id: CHAT_ID,
      text: `automation-service anomaly \`ship_idle\` at ${DETECTED_AT}: ${EXPECTED_SUMMARIES.ship_idle}`,
      disable_web_page_preview: true,
    });
    expect(body).not.toHaveProperty("parse_mode");
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

  it("leaves out a detectedAt that is not an ISO instant", () => {
    const a = { ...anomaly("consecutive_failures", SAMPLES.consecutive_failures), detectedAt: "soon https://x.example/" };
    const line = anomalyLine(a);
    expect(line).toBe("automation-service anomaly `consecutive_failures`: " + EXPECTED_SUMMARIES.consecutive_failures);
    expect(line).not.toContain("x.example");
  });

  it("does not treat inherited object keys as anomaly types", () => {
    expect(anomalyLine(anomaly("constructor", {}))).toBe(`automation-service anomaly \`constructor\` at ${DETECTED_AT}`);
  });

  const LEAK = "https://internal.example:8443/ships/VMPT-1?token=abc";

  it.each([...Object.keys(SAMPLES), "brand_new_check"])("a URL in any string field of %s's detail never reaches the Telegram text", async (type) => {
    const detail = poison(SAMPLES[type] ?? { message: "x" }, LEAK) as Record<string, unknown>;
    const a = { ...anomaly(type, detail), dedupeKey: LEAK };
    const body = await deliver("telegram", a);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("internal.example");
    expect(raw).not.toContain("://");
    expect(raw).not.toContain("token=abc");
    expect(String(body.text)).toContain(`\`${type}\``);
  });

  it("keeps repeated_denied's request line out of the Telegram text, even in its post-#45 shape", async () => {
    const raw = JSON.stringify(await deliver("telegram", anomaly("repeated_denied", SAMPLES.repeated_denied)));
    expect(raw).not.toContain("/ships/");
    expect(raw).not.toContain("4214");
  });

  it("drops the free-text message and caller identity from the resume alert", async () => {
    const raw = JSON.stringify(await deliver("telegram", anomaly("autopilot_resumed_in_shadow", SAMPLES.autopilot_resumed_in_shadow)));
    expect(raw).not.toContain("user_2abc");
    expect(raw).not.toContain("after restart");
  });

  it.each([
    ["a mention", "@everyone"],
    ["a username mention", "@owner_account"],
    ["a bot command", "/start"],
    ["a hashtag", "#alert"],
    ["HTML", "<b>x</b>"],
    ["Markdown", "*bold*"],
    ["a bare domain", "evil.example"],
    ["a backtick break-out", "x` @everyone `y"],
  ])("cannot be made to carry %s by a field value", async (_what, value) => {
    const detail = { ...SAMPLES.consecutive_failures, shipSymbol: value };
    const body = await deliver("telegram", anomaly("consecutive_failures", detail));
    expect(String(body.text)).not.toContain(value);
    expect(String(body.text)).not.toMatch(/[@#<>*/]/);
  });

  it("a 2xx answer without \"ok\": true is not a delivery", async () => {
    respond = () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), { status: 200 });
    expect(await delivery("telegram").deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toEqual({ delivered: false, rateLimited: false });
    expect(posted).toHaveLength(3);
  });

  it("a 2xx answer that is not JSON is not a delivery", async () => {
    respond = () => new Response("<html>proxy</html>", { status: 200 });
    expect(await delivery("telegram").deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toEqual({ delivered: false, rateLimited: false });
  });

  it("Telegram 400 \"chat not found\": not delivered, retried with backoff, logged as status and error_code only", async () => {
    // A description that echoes input, as some Bot API errors do.
    respond = () => telegramError(400, { error_code: 400, description: "Bad Request: chat not found ECHOED-INPUT" });
    const { delays, sleep } = recordingSleep();
    expect(await delivery("telegram", { sleep }).deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toEqual({ delivered: false, rateLimited: false });
    expect(posted).toHaveLength(3);
    expect(delays).toEqual([200, 400]);
    const out = logs();
    expect(out).toContain("anomaly webhook delivery failed: anomaly 42, attempt 1/3, HTTP 400 error_code 400");
    expect(out).toContain("attempt 3/3, HTTP 400 error_code 400");
    expect(out).not.toContain("chat not found");
    expect(out).not.toContain("ECHOED-INPUT");
    expect(out).not.toContain(BOT_TOKEN.split(":")[1]);
  });

  it.each([
    ["retry_after 2", { parameters: { retry_after: 2 } }, {}, 2000],
    ["retry_after 60, capped", { parameters: { retry_after: 60 } }, {}, 5000],
    ["retry_after over the header", { parameters: { retry_after: 1 } }, { "Retry-After": "4" }, 1000],
    ["Retry-After header only", {}, { "Retry-After": "3" }, 3000],
    ["neither", {}, {}, 200],
    ["a non-numeric retry_after", { parameters: { retry_after: "soon" } }, {}, 200],
  ])("Telegram 429 with %s waits accordingly and reports rate limiting", async (_what, extra, headers, expected) => {
    let first = true;
    respond = () => {
      if (!first) return telegramOk();
      first = false;
      return telegramError(429, { error_code: 429, description: "Too Many Requests: retry after N", ...extra }, headers);
    };
    const { delays, sleep } = recordingSleep();
    expect(await delivery("telegram", { sleep }).deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toEqual({ delivered: true, rateLimited: true });
    expect(delays).toEqual([expected]);
    expect(logs()).toContain("HTTP 429 error_code 429");
  });

  it("an error_code 429 inside a 2xx is rate limiting too", async () => {
    respond = () => telegramError(200, { error_code: 429, parameters: { retry_after: 1 } });
    const { delays, sleep } = recordingSleep();
    expect(await delivery("telegram", { sleep }).deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toEqual({ delivered: false, rateLimited: true });
    expect(delays).toEqual([1000, 1000]);
  });

  it.each([
    ["2", 2000],
    ["0.5", 500],
    ["60", 5000],
    ["soon", 200],
    [null, 200],
  ])("generic: on 429 waits Retry-After %p (capped at 5s), else the usual backoff", async (retryAfter, expected) => {
    let first = true;
    respond = () => {
      if (!first) return new Response(null, { status: 204 });
      first = false;
      return new Response(null, { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } });
    };
    const { delays, sleep } = recordingSleep();
    expect(await delivery(undefined, { sleep }).deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toEqual({ delivered: true, rateLimited: true });
    expect(delays).toEqual([expected]);
  });
});

describe("the Telegram URL never reaches a log line", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const SECRET_PARTS = [BOT_TOKEN, BOT_TOKEN.split(":")[0], BOT_TOKEN.split(":")[1], "api.telegram.org", "/bot", "sendMessage"];

  const expectNoSecret = (out: string) => {
    for (const part of SECRET_PARTS) expect(out).not.toContain(part);
  };

  it("on connection refused (real fetch, a closed localhost port)", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((r) => server.close(() => { r(); }));
    const logs = spyConsole();

    const url = `http://127.0.0.1:${String(port)}/bot${BOT_TOKEN}/sendMessage`;
    const result = await delivery("telegram", { url }).deliver(anomaly("ship_idle", SAMPLES.ship_idle));

    expect(result).toEqual({ delivered: false, rateLimited: false });
    const out = logs();
    expect(out).toContain("attempt 1/3, TypeError ECONNREFUSED");
    expectNoSecret(out);
  });

  it.each([
    // undici puts the whole URL in these errors' messages; neither reaches the network.
    ["an unparseable URL", `https://[api.telegram.org/bot${BOT_TOKEN}/sendMessage`],
    ["a URL with credentials", `https://user:pw@api.telegram.org/bot${BOT_TOKEN}/sendMessage`],
  ])("on %s (real fetch, whose error message quotes the URL)", async (_what, url) => {
    // Proof the hazard is real: the raw error does carry the token.
    const raw = await fetch(url, { method: "POST" }).then(
      () => "",
      (err: unknown) => String(err)
    );
    expect(raw).toContain(BOT_TOKEN);

    const logs = spyConsole();
    expect(await delivery("telegram", { url }).deliver(anomaly("ship_idle", SAMPLES.ship_idle))).toEqual({ delivered: false, rateLimited: false });
    const out = logs();
    expect(out).toContain("attempt 3/3, TypeError");
    expectNoSecret(out);
  });

  it.each([
    ["a DNS failure", Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), { code: "ENOTFOUND", hostname: "api.telegram.org" }) }), "TypeError ENOTFOUND"],
    ["a timeout", new DOMException("The operation was aborted due to timeout", "TimeoutError"), "TimeoutError"],
    ["an error naming the URL in its code", Object.assign(new Error(TELEGRAM_URL), { code: TELEGRAM_URL }), "Error"],
    ["an error whose name is the URL", Object.assign(new Error("x"), { name: TELEGRAM_URL }), "Error"],
    ["a thrown string", TELEGRAM_URL, "Error"],
  ])("on %s (mocked fetch)", async (_what, error, expected) => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(error);
    const logs = spyConsole();
    await delivery("telegram").deliver(anomaly("ship_idle", SAMPLES.ship_idle));
    const out = logs();
    expect(out).toContain(`attempt 1/3, ${expected}`);
    expectNoSecret(out);
  });

  it("describeFetchFailure keeps only an identifier-shaped class name and code", () => {
    const err = Object.assign(new TypeError(`Failed to parse URL from ${TELEGRAM_URL}`), { cause: { code: "ERR_INVALID_URL", input: TELEGRAM_URL } });
    expect(describeFetchFailure(err)).toBe("TypeError ERR_INVALID_URL");
  });
});

describe("telegram configuration", () => {
  it.each([undefined, "", "12a", "@abc", "-", "@has-dash", "123 "])("refuses telegram with chat id %p", (telegramChatId) => {
    expect(() => new WebhookDelivery({ url: TELEGRAM_URL, format: "telegram", telegramChatId })).toThrow(/telegram format needs a valid telegramChatId/);
  });

  it.each(["123456789", "-1001234567890", "@my_channel"])("accepts chat id %p", (telegramChatId) => {
    expect(() => new WebhookDelivery({ url: TELEGRAM_URL, format: "telegram", telegramChatId })).not.toThrow();
  });

  it("refuses a chat id without the telegram format", () => {
    expect(() => new WebhookDelivery({ url: "http://hook.test/x", telegramChatId: CHAT_ID })).toThrow(/only meaningful with the telegram format/);
  });

  it("names neither the URL nor the token when it refuses", () => {
    try {
      new WebhookDelivery({ url: TELEGRAM_URL, format: "telegram" });
    } catch (err) {
      expect(String(err)).not.toContain(BOT_TOKEN.split(":")[1]);
      return;
    }
    throw new Error("did not refuse");
  });
});

describe("stopping a delivery round", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("wakes a Retry-After sleep and makes no further attempt once the signal aborts", async () => {
    let posts = 0;
    let posted!: () => void;
    const firstPost = new Promise<void>((r) => {
      posted = r;
    });
    jest.spyOn(globalThis, "fetch").mockImplementation(() => {
      posts++;
      posted();
      return Promise.resolve(telegramError(429, { error_code: 429, parameters: { retry_after: 5 } }));
    });
    spyConsole();
    const controller = new AbortController();
    // Real sleep: the point is that it wakes.
    const round = new WebhookDelivery({ url: TELEGRAM_URL, format: "telegram", telegramChatId: CHAT_ID }).deliver(
      anomaly("ship_idle", SAMPLES.ship_idle),
      controller.signal
    );
    await firstPost;
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    controller.abort();

    expect(await round).toEqual({ delivered: false, rateLimited: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(posts).toBe(1);
  });

  it("cancels an in-flight POST when the signal aborts, and logs no failure for the stop", async () => {
    let posted!: () => void;
    const inFlight = new Promise<void>((r) => {
      posted = r;
    });
    // A webhook that never answers: only the abort can end this POST.
    jest.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      posted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const logs = spyConsole();
    const controller = new AbortController();
    const round = new WebhookDelivery({ url: TELEGRAM_URL, format: "telegram", telegramChatId: CHAT_ID }).deliver(
      anomaly("ship_idle", SAMPLES.ship_idle),
      controller.signal
    );
    await inFlight;
    const started = Date.now();
    controller.abort();

    expect(await round).toEqual({ delivered: false, rateLimited: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(logs()).toBe("");
  });

  it("makes no attempt on a signal that is already aborted", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    const result = await new WebhookDelivery({ url: "http://hook.test/x" }).deliver(anomaly("ship_idle", SAMPLES.ship_idle), controller.signal);
    expect(result).toEqual({ delivered: false, rateLimited: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("chat message length cap", () => {
  it("keeps the summary's 2000-character cap, under Telegram's 4096", () => {
    expect(CHAT_MESSAGE_MAX_CHARS).toBe(2000);
    expect(TELEGRAM_TEXT_MAX_CHARS).toBe(4096);
    const text = String(telegramBody(CHAT_ID, "x".repeat(TELEGRAM_TEXT_MAX_CHARS + 1000)).text);
    expect(text).toHaveLength(2000);
    expect(text.endsWith("...")).toBe(true);
  });

  it("leaves a message of exactly the limit untouched", () => {
    const exact = "y".repeat(CHAT_MESSAGE_MAX_CHARS);
    expect(telegramBody(CHAT_ID, exact).text).toBe(exact);
  });
});

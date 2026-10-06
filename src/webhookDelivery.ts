import type { Anomaly } from "./anomaly";

const DELIVERY_TIMEOUT_MS = 10_000;
/** Longest a 429's retry hint is honoured for; one delivery round must stay short. */
const MAX_RETRY_AFTER_MS = 5_000;
/** A Bot API answer is a few hundred bytes; anything far larger is not one and is not parsed. */
const MAX_RESPONSE_CHARS = 64 * 1024;

const capRetryAfter = (seconds: number): number | null =>
  Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;

/**
 * A 429's `Retry-After` header in seconds, honoured up to MAX_RETRY_AFTER_MS.
 * Anything unparseable (including the HTTP-date form) falls back to the usual
 * backoff.
 */
const retryAfterHeaderMs = (res: Response): number | null => {
  if (res.status !== 429) return null;
  const raw = res.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return null;
  return capRetryAfter(Number(raw));
};

/**
 * The body shape the webhook expects (issue #47). `generic` is the original
 * `{id, type, dedupeKey, detectedAt, detail}` JSON; `telegram` is a Bot API
 * `sendMessage` call, the bot token in the URL's path and the chat in
 * `ANOMALY_TELEGRAM_CHAT_ID`. Discord and Slack formats existed briefly and
 * were replaced by Telegram, the owner's choice.
 */
export const WEBHOOK_FORMATS = ["generic", "telegram"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Telegram refuses `text` over 4096 characters. */
export const TELEGRAM_TEXT_MAX_CHARS = 4096;
/** The summary's own cap from #47. Lower than Telegram's, and a page is one line anyway. */
export const CHAT_MESSAGE_MAX_CHARS = Math.min(2000, TELEGRAM_TEXT_MAX_CHARS);

/**
 * A Telegram chat: a numeric id (negative for groups and channels) or a public
 * `@channelusername`. Checked at startup, so a typo is a config error rather
 * than every page answered "chat not found".
 */
export const TELEGRAM_CHAT_ID = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

/**
 * What a Bot API `sendMessage` URL looks like. The bot token is the path
 * segment after `bot`, which is why the URL is a secret and is never logged,
 * not even in part.
 */
export const TELEGRAM_SEND_MESSAGE_URL = /^https:\/\/api\.telegram\.org\/bot\d+:[A-Za-z0-9_-]+\/sendMessage$/;

/**
 * A string field is only ever put into a chat message if it is a short plain
 * token: ship symbols, waypoints, phases, statuses. Anything else — a URL, a
 * sentence, upstream error text — is dropped. No `@`, `#`, `/`, `.`, `:`,
 * whitespace or backtick can pass, so a value can neither mention anyone
 * (`@username`), nor read as a bot command (`/start`), nor become a link
 * Telegram detects in plain text, nor break out of the backticks it is shown
 * in. The message is sent without `parse_mode`, so those backticks are literal
 * characters and nothing in the text is read as Markdown or HTML.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const token = (value: unknown): string | null => (typeof value === "string" && SAFE_TOKEN.test(value) ? `\`${value}\`` : null);

const num = (value: unknown, digits = 0): string | null =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : null;

const percent = (value: unknown): string | null => {
  const n = num(typeof value === "number" ? value * 100 : value, 1);
  return n === null ? null : `${n}%`;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Joins the parts that survived; a part with any null input is left out whole. */
const parts = (...items: (string | null | false)[]): string => items.filter((p): p is string => typeof p === "string" && p !== "").join(", ");

const when = (label: string, ...values: (string | null)[]): string | null => (values.every((v) => v !== null) ? label : null);

/**
 * One summary per anomaly type, each naming the `detail` fields it reads.
 * The raw `detail` is never sent: some types carry free text (the resume
 * alert's `message`), and before #45 `repeated_denied`'s `request` was a
 * prefix of the upstream's error text. A field added to a detail later is not
 * reviewed for a chat channel, so every field here is chosen on purpose and
 * validated. A type not listed gets no summary, only its name.
 */
const SUMMARIES: Record<string, (d: Record<string, unknown>) => string> = {
  ship_idle: (d) => {
    const ship = token(d.shipSymbol);
    const idle = num(d.idleMinutes);
    const limit = num(d.thresholdMinutes);
    const phase = token(d.phase);
    return parts(when(`ship ${String(ship)}`, ship), when(`idle ${String(idle)} min`, idle), when(`threshold ${String(limit)} min`, limit), when(`phase ${String(phase)}`, phase));
  },
  earnings_stalled: (d) => {
    const reasons = Array.isArray(d.reasons) ? d.reasons.map(token).filter((r): r is string => r !== null) : [];
    return reasons.length === 0 ? "" : `reasons ${reasons.join(" ")}`;
  },
  consecutive_failures: (d) => {
    const ship = token(d.shipSymbol);
    const count = num(d.failureCount);
    const limit = num(d.limit);
    return parts(when(`ship ${String(ship)}`, ship), when(`${String(count)} failures in a row`, count), when(`limit ${String(limit)}`, limit));
  },
  error_rate: (d) => {
    const rate = percent(d.rate);
    const threshold = percent(d.threshold);
    const errors = num(d.errorEvents);
    const total = num(d.totalEvents);
    const window = num(d.windowMinutes);
    return parts(
      when(`error rate ${String(rate)}`, rate),
      when(`threshold ${String(threshold)}`, threshold),
      when(`${String(errors)} of ${String(total)} events`, errors, total),
      when(`over ${String(window)} min`, window)
    );
  },
  market_stale: (d) => {
    const market = token(d.market);
    const stale = num(d.staleMinutes);
    const limit = num(d.thresholdMinutes);
    return parts(
      when(`market ${String(market)}`, market),
      d.staleMinutes === null ? "never read in person" : when(`${String(stale)} min since read`, stale),
      when(`threshold ${String(limit)} min`, limit)
    );
  },
  repeated_denied: (d) => {
    // Not `request`, kept out as defense in depth. Since #45 it is a built
    // line (`GET /api/agent/v1/ships/X: 403 (code 4214)`, PUBLIC_REQUEST_PATTERN)
    // with no upstream text, but its path is unbounded and allows `.`, `%`
    // and `~`, so it is not a short token, and it adds nothing the digest
    // does not already show.
    const ship = token(d.shipSymbol);
    const source = token(d.source);
    const count = num(d.consecutiveFailures);
    return parts(when(`ship ${String(ship)}`, ship), when(`source ${String(source)}`, source), when(`${String(count)} denied in a row`, count));
  },
  autopilot_resumed_in_shadow: (d) => {
    // Not `message` (free text) and not `lastWrittenBy` (a caller identity).
    const was = record(d.was);
    const status = token(was.status);
    const mode = token(was.mode);
    return parts(when(`was ${String(status)} ${String(mode)}`, status, mode), "now shadow; re-arm live to continue trading");
  },
};

/** The one line a chat shows for an anomaly: type, when, and a summary built from safe fields only. */
export function anomalyLine(anomaly: Anomaly): string {
  const type = token(anomaly.type) ?? "`unknown`";
  const detectedAt = ISO_INSTANT.test(anomaly.detectedAt) ? ` at ${anomaly.detectedAt}` : "";
  const summarize = Object.hasOwn(SUMMARIES, anomaly.type) ? SUMMARIES[anomaly.type] : null;
  const summary = summarize === null ? "" : summarize(record(anomaly.detail));
  return `automation-service anomaly ${type}${detectedAt}${summary === "" ? "" : `: ${summary}`}`;
}

/** Truncates to `max` characters, marking the cut. */
export function capLength(text: string, max: number = CHAT_MESSAGE_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * The Bot API `sendMessage` body for a line of text, capped. Plain text on
 * purpose: no `parse_mode`, so nothing in it is read as Markdown or HTML, and
 * no link preview.
 */
export function telegramBody(chatId: string, text: string): Record<string, unknown> {
  return { chat_id: chatId, text: capLength(text), disable_web_page_preview: true };
}

export function webhookBody(anomaly: Anomaly, format: WebhookFormat, telegramChatId?: string): Record<string, unknown> {
  if (format === "generic") {
    return {
      id: anomaly.id,
      type: anomaly.type,
      dedupeKey: anomaly.dedupeKey,
      detectedAt: anomaly.detectedAt,
      detail: anomaly.detail,
    };
  }
  if (telegramChatId === undefined || !TELEGRAM_CHAT_ID.test(telegramChatId)) throw new Error("telegram format needs a valid chat id");
  return telegramBody(telegramChatId, anomalyLine(anomaly));
}

export interface WebhookDeliveryConfig {
  /** A secret for `telegram` (the bot token is in its path). Never logged. */
  url: string;
  /** Defaults to `generic`, the original body. */
  format?: WebhookFormat;
  /** Required with `format: "telegram"`, refused with any other format. */
  telegramChatId?: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  /**
   * Injectable so tests don't have to burn real wall-clock time on retry
   * backoff. Must resolve early when `signal` aborts.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What one round of `deliver()` came to. */
export interface DeliveryResult {
  /** The webhook accepted the post: 2xx, and for Telegram also `"ok": true`. */
  delivered: boolean;
  /**
   * Some attempt in the round was rate-limited (HTTP 429, or Telegram's
   * `error_code` 429). The caller sends nothing more this tick: the chat
   * service is rate-limiting us, and the rest of a batch would only collect
   * more 429s and burn its delivery rounds.
   */
  rateLimited: boolean;
}

/** Resolves after `ms`, or at once when `signal` aborts, so a stop never waits out a backoff. */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** How one answered attempt went. */
interface Answer {
  delivered: boolean;
  rateLimited: boolean;
  /** How long the service asked us to wait, already capped; null for the usual backoff. */
  waitMs: number | null;
  /** Telegram's numeric `error_code`, the only part of its error answer ever logged. */
  errorCode: number | null;
}

/**
 * Reads a Bot API answer: `{"ok": true, ...}` or
 * `{"ok": false, "error_code": 429, "description": "...", "parameters": {"retry_after": N}}`.
 * A 2xx without `"ok": true` is not a delivery. `description` is never read:
 * it can echo what we sent.
 */
const telegramAnswer = async (res: Response): Promise<Answer> => {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await res.text();
    if (text.length <= MAX_RESPONSE_CHARS) parsed = record(JSON.parse(text));
  } catch {
    // not JSON, or the body read failed or was aborted: judged on the status alone
  }
  const errorCode = Number.isSafeInteger(parsed.error_code) ? (parsed.error_code as number) : null;
  const rateLimited = res.status === 429 || errorCode === 429;
  const retryAfter = record(parsed.parameters).retry_after;
  const waitMs = !rateLimited
    ? null
    : typeof retryAfter === "number"
      ? capRetryAfter(retryAfter)
      : res.headers.get("retry-after") !== null
        ? capRetryAfter(Number(res.headers.get("retry-after")))
        : null;
  return { delivered: res.ok && parsed.ok === true, rateLimited, waitMs, errorCode };
};

const genericAnswer = (res: Response): Answer => ({
  delivered: res.ok,
  rateLimited: res.status === 429,
  waitMs: retryAfterHeaderMs(res),
  errorCode: null,
});

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * What a failed fetch may say in the log: the error's class name and a
 * Node/undici error code, each only if identifier-shaped. Never its message
 * and never `String(err)`: undici puts the whole URL in the message of a
 * parse failure ("Failed to parse URL from https://api.telegram.org/bot<token>/...")
 * and of a URL with credentials, and the URL holds the bot token.
 */
export const describeFetchFailure = (err: unknown): string => {
  // Duck-typed, not `instanceof Error`: undici's errors and DOMException can
  // come from another realm (they do under Jest), and would all read "Error".
  const fields = record(err);
  const name = typeof fields.name === "string" && IDENTIFIER.test(fields.name) ? fields.name : "Error";
  const rawCode = record(fields.cause).code ?? fields.code;
  const code = typeof rawCode === "string" && IDENTIFIER.test(rawCode) ? rawCode : null;
  return code === null ? name : `${name} ${code}`;
};

/** POSTs an anomaly to a configured webhook URL, retrying with exponential backoff on failure. */
export class WebhookDelivery {
  private readonly url: string;
  private readonly format: WebhookFormat;
  private readonly telegramChatId: string | undefined;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(config: WebhookDeliveryConfig) {
    this.url = config.url;
    this.format = config.format ?? "generic";
    this.telegramChatId = config.telegramChatId;
    // Messages name no value: the chat id is not secret, but the URL is.
    if (this.format === "telegram" && (this.telegramChatId === undefined || !TELEGRAM_CHAT_ID.test(this.telegramChatId))) {
      throw new Error("WebhookDelivery: telegram format needs a valid telegramChatId");
    }
    if (this.format !== "telegram" && this.telegramChatId !== undefined) {
      throw new Error("WebhookDelivery: telegramChatId is only meaningful with the telegram format");
    }
    this.maxAttempts = config.maxAttempts ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 200;
    this.sleep = config.sleep ?? realSleep;
  }

  /**
   * One round: up to `maxAttempts` POSTs with backoff. `signal` is the
   * caller's stop: once it aborts, the in-flight POST is cancelled, any
   * backoff or Retry-After sleep wakes, and no further attempt is made, so a
   * shutdown is never held up by a round (#47 review: two capped 429 waits
   * alone are 10 s, past the 8 s shutdown deadline).
   *
   * A failed attempt logs one line: the anomaly's id, the attempt, and the
   * status and Telegram `error_code`, or the fetch error's class and code.
   * Never the URL, a response body, or an error's message.
   */
  async deliver(anomaly: Anomaly, signal?: AbortSignal): Promise<DeliveryResult> {
    const payload = JSON.stringify(webhookBody(anomaly, this.format, this.telegramChatId));
    let rateLimited = false;
    // A call, not a property read: TypeScript would keep the narrowing from the
    // first check across the awaits after it.
    const stopped = (): boolean => signal?.aborted === true;
    const id = /^\d{1,20}$/.test(anomaly.id) ? anomaly.id : "?";

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (stopped()) break;
      let waitMs: number | null = null;
      let failure: string;
      try {
        const timeout = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        });
        const answer = this.format === "telegram" ? await telegramAnswer(res) : genericAnswer(res);
        if (answer.delivered) return { delivered: true, rateLimited };
        if (answer.rateLimited) rateLimited = true;
        waitMs = answer.waitMs;
        failure = `HTTP ${String(res.status)}${answer.errorCode === null ? "" : ` error_code ${String(answer.errorCode)}`}`;
      } catch (err) {
        // network error, timeout or stop — fall through to retry (or the stop check)
        failure = describeFetchFailure(err);
      }
      if (stopped()) break; // a stop is not a failure worth a log line
      console.warn(`anomaly webhook delivery failed: anomaly ${id}, attempt ${String(attempt)}/${String(this.maxAttempts)}, ${failure}`);
      if (attempt < this.maxAttempts) {
        await this.sleep(waitMs ?? this.baseDelayMs * 2 ** (attempt - 1), signal);
      }
    }
    return { delivered: false, rateLimited };
  }
}

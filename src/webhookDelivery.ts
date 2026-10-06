import type { Anomaly } from "./anomaly";

const DELIVERY_TIMEOUT_MS = 10_000;
/** Longest a 429's Retry-After is honoured for; one delivery round must stay short. */
const MAX_RETRY_AFTER_MS = 5_000;

/**
 * Discord and Slack answer a rate-limited post with 429 and `Retry-After` in
 * seconds. Honoured up to MAX_RETRY_AFTER_MS; anything unparseable (including
 * the HTTP-date form) falls back to the usual backoff.
 */
const retryAfterMs = (res: Response): number | null => {
  if (res.status !== 429) return null;
  const raw = res.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
};

/**
 * The body shape the webhook expects (issue #47). `generic` is the original
 * `{id, type, dedupeKey, detectedAt, detail}` JSON; `discord` and `slack` are
 * the chat services' incoming-webhook bodies, which reject the generic one
 * with 400.
 */
export const WEBHOOK_FORMATS = ["generic", "discord", "slack"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Discord refuses `content` over 2000 characters; Slack's own limit is higher, so one cap serves both. */
export const CHAT_MESSAGE_MAX_CHARS = 2000;

/**
 * A string field is only ever put into a chat message if it is a short plain
 * token: ship symbols, waypoints, phases, statuses. Anything else — a URL, a
 * sentence, upstream error text — is dropped. No `@`, `<`, `/`, whitespace or
 * backtick can pass, so a value can neither ping (Discord `@everyone`, Slack
 * `<!channel>`), nor link, nor break out of the inline code it is shown in.
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

/** The one line a chat webhook shows for an anomaly: type, when, and a summary built from safe fields only. */
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

/** The chat body for a line of text, capped. Discord's `allowed_mentions: {parse: []}` means nothing in it can ping. */
export function chatBody(format: Exclude<WebhookFormat, "generic">, text: string): Record<string, unknown> {
  const capped = capLength(text);
  return format === "discord" ? { content: capped, allowed_mentions: { parse: [] } } : { text: capped };
}

export function webhookBody(anomaly: Anomaly, format: WebhookFormat): Record<string, unknown> {
  if (format === "generic") {
    return {
      id: anomaly.id,
      type: anomaly.type,
      dedupeKey: anomaly.dedupeKey,
      detectedAt: anomaly.detectedAt,
      detail: anomaly.detail,
    };
  }
  return chatBody(format, anomalyLine(anomaly));
}

export interface WebhookDeliveryConfig {
  url: string;
  /** Defaults to `generic`, the original body. */
  format?: WebhookFormat;
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
  /** The webhook answered 2xx. */
  delivered: boolean;
  /**
   * Some attempt in the round was answered 429. The caller sends nothing more
   * this tick: the chat service is rate-limiting us, and the rest of a batch
   * would only collect more 429s and burn its delivery rounds.
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

/** POSTs an anomaly to a configured webhook URL, retrying with exponential backoff on failure. */
export class WebhookDelivery {
  private readonly url: string;
  private readonly format: WebhookFormat;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(config: WebhookDeliveryConfig) {
    this.url = config.url;
    this.format = config.format ?? "generic";
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
   */
  async deliver(anomaly: Anomaly, signal?: AbortSignal): Promise<DeliveryResult> {
    const payload = JSON.stringify(webhookBody(anomaly, this.format));
    let rateLimited = false;
    // A call, not a property read: TypeScript would keep the narrowing from the
    // first check across the awaits after it.
    const stopped = (): boolean => signal?.aborted === true;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (stopped()) break;
      let waitMs: number | null = null;
      try {
        const timeout = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        });
        if (res.ok) return { delivered: true, rateLimited };
        if (res.status === 429) rateLimited = true;
        waitMs = retryAfterMs(res);
      } catch {
        // network error, timeout or stop — fall through to retry (or the stop check)
      }
      if (attempt < this.maxAttempts && !stopped()) {
        await this.sleep(waitMs ?? this.baseDelayMs * 2 ** (attempt - 1), signal);
      }
    }
    return { delivered: false, rateLimited };
  }
}

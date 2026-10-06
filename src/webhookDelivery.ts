import type { Anomaly } from "./anomaly";

const DELIVERY_TIMEOUT_MS = 10_000;

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
 * alert's `message`, `repeated_denied`'s `request`, which is upstream error
 * text — #45), so every field here is chosen on purpose and validated. A type
 * not listed gets no summary, only its name.
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
    // Not `request`: it is the upstream's own error text.
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
  /** Injectable so tests don't have to burn real wall-clock time on retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** POSTs an anomaly to a configured webhook URL, retrying with exponential backoff on failure. */
export class WebhookDelivery {
  private readonly url: string;
  private readonly format: WebhookFormat;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: WebhookDeliveryConfig) {
    this.url = config.url;
    this.format = config.format ?? "generic";
    this.maxAttempts = config.maxAttempts ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 200;
    this.sleep = config.sleep ?? realSleep;
  }

  /** Returns true once the webhook responds 2xx, false if every attempt failed. */
  async deliver(anomaly: Anomaly): Promise<boolean> {
    const payload = JSON.stringify(webhookBody(anomaly, this.format));

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        if (res.ok) return true;
      } catch {
        // network error or timeout — fall through to retry
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    return false;
  }
}

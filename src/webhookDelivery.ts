import { Anomaly } from "./anomaly";

const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookDeliveryConfig {
  url: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Injectable so tests don't have to burn real wall-clock time on retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** POSTs an anomaly to a configured webhook URL, retrying with exponential backoff on failure. */
export class WebhookDelivery {
  private readonly url: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: WebhookDeliveryConfig) {
    this.url = config.url;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 200;
    this.sleep = config.sleep ?? realSleep;
  }

  /** Returns true once the webhook responds 2xx, false if every attempt failed. */
  async deliver(anomaly: Anomaly): Promise<boolean> {
    const payload = JSON.stringify({
      id: anomaly.id,
      type: anomaly.type,
      dedupeKey: anomaly.dedupeKey,
      detectedAt: anomaly.detectedAt,
      detail: anomaly.detail,
    });

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

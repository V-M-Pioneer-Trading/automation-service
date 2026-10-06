/**
 * What a failure may say outside this process.
 *
 * An upstream failure's text is `METHOD http://internal-host/path: STATUS body`
 * (see `callJson` in gameClients.ts): the internal host, and as much of the
 * upstream's response body as it sent. Event `detail` is served to anyone by
 * `GET /autopilot/events` and leaves in anomaly webhooks, so neither belongs
 * there. Every event or page that describes a failure stores
 * `describeFailure(err)` as its `request`; the full text goes to the
 * container log, once, through `logFailure`.
 */

const PREFIX_CHARS = 200;

/** Any absolute http(s) URL's scheme and authority, wherever it appears. */
const ORIGIN = /https?:\/\/[^\s/"'<>]*/gi;

const stripOrigins = (text: string): string => text.replace(ORIGIN, "");

/**
 * Request method and path, status and the start of the text. Never an upstream
 * host, which is internal — not in the request line and not inside the body —
 * and never more than a short prefix of the upstream's body.
 */
export function describeFailure(err: unknown): string {
  const text = String(err);
  const m = /^(?:Error: )?([A-Z]+) (\S+?): (.*)$/s.exec(text);
  if (m === null) return stripOrigins(text).slice(0, PREFIX_CHARS);
  let path = m[2];
  try {
    path = new URL(m[2]).pathname;
  } catch {
    // not an absolute URL; keep as is
  }
  return `${m[1]} ${stripOrigins(path)}: ${stripOrigins(m[3]).slice(0, PREFIX_CHARS)}`;
}

/**
 * Writes the full failure to the container log and returns the public
 * `describeFailure` of it. Call it once per failure, at the event that records
 * it — not again for a second event about the same failure.
 */
export function logFailure(eventType: string, err: unknown): string {
  console.error(`automation-service: ${eventType}:`, err);
  return describeFailure(err);
}

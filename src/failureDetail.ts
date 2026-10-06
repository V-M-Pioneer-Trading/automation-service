import { UpstreamCallError } from "./gameClients";

/**
 * What a failure may say outside this process.
 *
 * Event `detail` is served to anyone by `GET /autopilot/events` and leaves in
 * anomaly webhooks and the AI supervisor's digest. A failure's text does not
 * belong there: an upstream failure's message is the internal URL plus the
 * upstream's whole response body, and any other error's message can name a
 * database host, a connection string or an internal service (#45).
 *
 * So no text from an error reaches the public detail at all — not trimmed, not
 * scrubbed. Scrubbing was tried first and lost: hosts arrive as `ws://`,
 * `//authority`, bare IPs, `localhost:80`, percent-encoded, JSON-escaped, or
 * as plain prose ("st-gateway did not answer"), and a deny-list cannot know
 * them all. What is shown is built only from values this service chose
 * (method, path) or that parse as numbers or identifiers (status, the game's
 * numeric `error.code`, a Node error code):
 *
 * - an `UpstreamCallError` → its `requestLine`, e.g. `GET /ships/X: 403 (code 4225)`
 *   or `POST /ships/X/orbit: no response (ECONNREFUSED)`
 * - anything else → its `code` (`ECONNREFUSED`, a Postgres SQLSTATE) or its
 *   class name (`TypeError`), else `Error`
 *
 * Everything else is in the container log, once, through `logFailure`.
 */

/** An identifier, not prose: nothing with a dot, colon, slash or space can pass. */
const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

/** `err.code`, else the cause's code, else the class name — whichever is identifier-shaped first; `Error` if none. */
export function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "Error";
  const { code, name, cause } = err as { code?: unknown; name?: unknown; cause?: unknown };
  const causeCode = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  for (const candidate of [code, causeCode, name]) {
    if (typeof candidate === "string" && SAFE_CODE.test(candidate)) return candidate;
  }
  return "Error";
}

export function describeFailure(err: unknown): string {
  if (err instanceof UpstreamCallError) {
    if (err.requestLine === undefined) return `upstream call failed (${err.kind})`;
    return err.cause === undefined ? err.requestLine : `${err.requestLine} (${errorCode(err.cause)})`;
  }
  return errorCode(err);
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

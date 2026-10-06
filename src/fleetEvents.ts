/**
 * The event vocabulary: which `event_log.type` values mean "the fleet did
 * something", "something failed", and "credits arrived".
 *
 * This exists because the answers were previously written out separately in
 * `anomaly.ts` and `metrics.ts`, and the two drifted into agreeing with each
 * other about the wrong thing. Both asked their questions in mining's terms
 * while the events they counted as errors are logged for *every* task kind, so
 * a contract-only window produced errors with no denominator to divide by, and
 * a contract-earning fleet looked like it had earned nothing at all.
 *
 * The rule: a consumer asking one of these questions imports the predicate. It
 * does not write its own `type LIKE …`. A new task kind is then one edit here
 * rather than a silent skew in two alarms and an operator-facing rollup.
 */

/**
 * A tick of a ship task made progress — any task kind. This is the denominator
 * for the error rate, so it has to span exactly the same ground the error types
 * below do.
 *
 * The underscore is escaped (`\\_` here is `\_` in the SQL, and Postgres' default
 * LIKE escape is a backslash) so it matches a literal `_` rather than any single
 * character. The previous copies wrote `'mining\_%'` inside a template literal,
 * where JavaScript drops the unknown escape — so the SQL got `mining_%` and the
 * `_` was silently a wildcard. Harmless with today's type names, and not
 * something to leave lying around.
 */
export const TASK_EVENT_PREDICATE =
  "(type LIKE 'mining\\_%' OR type LIKE 'contract\\_%' OR type LIKE 'scout\\_%')";

/**
 * A dispatched action failed.
 *
 * Both names say "mining" and neither means it: `mining_tick_error` is what the
 * scheduler's interval loop and `handleTickFailure` log for a mining, contract
 * or scout task alike, and `mining_task_failed` is logged when any task exceeds
 * its retry limit. They are misnamed rather than mining-specific, and renaming
 * them would strand every historical row, so the names stay and this comment
 * carries the truth.
 */
export const ACTION_ERROR_PREDICATE = "type IN ('mining_tick_error', 'mining_task_failed')";

/**
 * Credits actually arrived.
 *
 * Mining earns on a sell. Contracts earn twice — an advance when the contract is
 * accepted and the balance when it is fulfilled — and neither is a sell, which
 * is why a fleet running contracts profitably used to read as "no earnings".
 */
export const EARNING_EVENT_PREDICATE =
  "type IN ('mining_sell', 'contract_accepted', 'contract_fulfilled')";

/**
 * What the operator last said they wanted. Not a thing the fleet did — a thing
 * the fleet was told — which is why the only check that asserts a *positive*
 * condition (`no_earnings`) measures its window from here rather than from the
 * last time anything happened.
 */
export const LIFECYCLE_EVENT_TYPES = ["armed", "paused", "aborted"];

/**
 * The fleet's own reading of its balance, written by the anomaly scheduler
 * while armed and live. The one number in the log that is a level rather than
 * an increment, which is what makes "credits went nowhere" answerable at all.
 */
export const CREDITS_SNAPSHOT_TYPE = "agent_credits_snapshot";

/**
 * A sell leg picked a market, and `detail.marketsChecked` says which ones it
 * priced on the way. That list is how "in active use" is defined for the
 * staleness alarm — a market nobody is pricing against cannot be deciding
 * anything on stale numbers.
 */
export const MARKET_SELECTION_TYPE = "mining_market_selected";

/**
 * Credits earned by one event, for summing into revenue.
 *
 * `COALESCE` on the contract payments is load-bearing for history rather than
 * for correctness going forward: rows written before the payment was recorded
 * have no `payment` key, and `->>` on a missing key is NULL, which would make
 * `SUM` return NULL for an entire window that contained one old row. They
 * contribute 0 instead, so an old window under-reports rather than breaking.
 */
export const EVENT_REVENUE_SQL = `CASE
    WHEN type = 'mining_sell' THEN COALESCE((detail->>'totalPrice')::double precision, 0)
    WHEN type IN ('contract_accepted', 'contract_fulfilled')
      THEN COALESCE((detail->>'payment')::double precision, 0)
    ELSE 0
  END`;

/**
 * What the fleet scheduler logs when a run of identical `denied` failures
 * reaches its threshold; `AnomalyChecker` turns it into a `repeated_denied`
 * anomaly. Deliberately not a `mining_` name: it is not a task outcome, so it
 * must not count in the error rate.
 */
export const REPEATED_DENIED_EVENT = "repeated_denied_tripped";

/** The anomaly `AnomalyChecker` raises from `REPEATED_DENIED_EVENT`. */
export const REPEATED_DENIED_ANOMALY = "repeated_denied";

/**
 * Event types that stored raw error text as `detail.message` before #45: the
 * internal URL of the service called and the upstream's whole response body.
 * Nothing writes `message` on them any more; see `legacyErrorTextRemoved`.
 */
export const LEGACY_ERROR_TEXT_TYPES: readonly string[] = ["mining_tick_error", "contract_discovery_error", "observation_write_error"];

/**
 * The only shape a public failure `request` may have: what
 * `UpstreamCallError.requestLine` builds, or `describeFailure`'s fallback for
 * an upstream error without one. Written so Postgres (ARE) and JavaScript read
 * it the same — no backslashes (`[(]` for a literal parenthesis) and no single
 * quote, because `db.ts` puts it in DDL.
 *
 * #43's `repeated_denied` `request` was the first 200 characters of the
 * upstream's text, which can name internal hosts. None of those rows match:
 * the old value always carried text after the status.
 */
export const PUBLIC_REQUEST_PATTERN =
  "^((GET|POST|PATCH|PUT|DELETE) /([A-Za-z0-9_.~%-][A-Za-z0-9/_.~%-]*)?: ([0-9]{3}( [(]code [0-9]+[)])?|no response( [(][A-Za-z0-9_]{1,40}[)])?|machine token unavailable)|upstream call failed [(][a-z]+[)])$";

const PUBLIC_REQUEST = new RegExp(PUBLIC_REQUEST_PATTERN);

/**
 * Rows still carrying pre-#45 error text, in `event_log`. Scrubbed in the
 * background by `LegacyErrorTextScrubber` (legacyScrub.ts). Unqualified
 * column names, so it reads the same inside that UPDATE ... FROM.
 */
export const LEGACY_ERROR_TEXT_PREDICATE = `((type IN (${LEGACY_ERROR_TEXT_TYPES.map((t) => `'${t}'`).join(", ")}) AND detail ? 'message')
  OR (type = '${REPEATED_DENIED_EVENT}' AND detail ? 'request' AND NOT COALESCE((detail->>'request') ~ '${PUBLIC_REQUEST_PATTERN}', false)))`;

/**
 * `detail` without pre-#45 error text, for any reader of `event_log` or
 * `anomaly`. The rows are scrubbed in the background after startup, which on
 * production takes minutes; this is what keeps the public routes clean
 * meanwhile, and afterwards for a row the scrub never saw (a restored backup). `event_log` and `anomaly` types share no names, so one function covers both.
 */
export function legacyErrorTextRemoved(type: string, detail: Record<string, unknown>): Record<string, unknown> {
  if (LEGACY_ERROR_TEXT_TYPES.includes(type) && "message" in detail) {
    const rest = { ...detail };
    delete rest.message;
    return rest;
  }
  if ((type === REPEATED_DENIED_EVENT || type === REPEATED_DENIED_ANOMALY) && "request" in detail) {
    const request = detail.request;
    if (typeof request === "string" && PUBLIC_REQUEST.test(request)) return detail;
    const rest = { ...detail };
    delete rest.request;
    return rest;
  }
  return detail;
}

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

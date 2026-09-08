# automation-service — implementation notes

Working notes for contributors and coding agents. The [README](README.md) says
*what* the service does and why; this file says how the code is put together,
which invariants it depends on, and what will bite you. Keep it current: when
you change an invariant, change it here in the same PR.

## Commands

```bash
docker run --rm -d --name automation-service-test-db -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=automation_test postgres:16-alpine
npm test                      # full suite; needs the Postgres above (jest.env.js defaults DATABASE_URL to it)
npx jest src/__tests__/x.test.ts
npm run typecheck             # tsc --noEmit; run before every commit, strict mode is on
npm run replay -- --set mine.taskWeight=2 --since 6h --verbose
```

CI (`.github/workflows/container.yml`) runs `npm test` on PRs against a fresh
Postgres 16, and builds/pushes the image only on merge to `main`.

## Module map

| File | Owns | Depends on |
|---|---|---|
| `server.ts` | `createApp(options)`: wiring, routes, auth guards, `app.locals` test hooks | everything below |
| `scheduler.ts` | `FleetScheduler`: the tick (replan → assign → advance one FSM step → persist) | planner, discovery, FSMs, repos |
| `planner.ts` | `Planner`: one `DecisionContext` per decision, scores mining/contract/scout, pure `evaluateContract` | scoring, routeCost, observations, repos |
| `scoring.ts` | The credits-per-hour arithmetic. Pure, no imports from the rest of `src` | nothing |
| `routeCost.ts` | `fuelAwareRoute`: Dijkstra over waypoints with fuel constraints. Pure | nothing |
| `contractDiscovery.ts` | See/evaluate/accept contracts, called inline by the scheduler before each assignment | planner, contractRepo |
| `taskFsm.ts` | Shared FSM pieces: `TickResult`, `TaskContext`, travel/dock/refuel/wait resolution | gameClients, shipTaskRepo |
| `miningTask.ts`, `contractTask.ts`, `scoutTask.ts` | One `advance*Task(ctx)` each, one action per call | taskFsm |
| `observations.ts` | `ObservationRepo` + `calibrate()`: measured model with priors as fallback | knobs (types only) |
| `knobs.ts` | `KNOB_DEFINITIONS` (source of `KnobName`), `KnobRepo`, `syncKnobDefinitions` | transaction |
| `db.ts` | `createPool`, `migrate` (idempotent DDL) | knobs (for the sync) |
| `transaction.ts` | `withTransaction(pool, fn)` | pg |
| `intervalLoop.ts` | `IntervalLoop`: the one guarded timer every scheduler runs on | nothing |
| `dispatchLock.ts` | `DispatchLock`: Postgres advisory lock making "one process drives this ship" true across processes | pg, crypto |
| `fleetEvents.ts` | The event vocabulary: task progress, failed actions, credits arriving. SQL predicates only, no I/O | nothing |
| `anomaly.ts` | `AnomalyRepo`, `AnomalyChecker` (five read-only checks) | knobs, marketIntel, fleetEvents |
| `anomalyScheduler.ts` | Runs checks, dedupes, persists, delivers, requests replans | anomaly, webhookDelivery |
| `metrics.ts`, `metricsScheduler.ts` | Rollups over `event_log` windows | eventLog table, fleetEvents |
| `testSupport/fakeClock.ts`, `testSupport/fakeGameClients.ts` | The adapters for the `Clock` and `GameClients` seams. One each, shared — not one per test file | test-only |
| `shipTaskRepo.ts`, `contractRepo.ts`, `marketIntelRepo.ts`, `eventLog.ts` | Row ↔ object repos. Repos taking `Pool \| PoolClient` can join a transaction | clock |
| `autopilotState.ts` | In-memory status/mode/token. Never persisted by design | nothing |
| `auth.ts` | Networkless Clerk JWT verification, service-secret guard | jose |
| `config.ts` | `configFromEnv()`; every numeric env var validated positive | fs |
| `gameClients.ts` | Typed fetch wrappers for the three upstream services, 15s timeout. **Owns the failure taxonomy**: every upstream error is classified here into one `UpstreamFailureKind` | m2mToken, fetch |
| `m2mToken.ts` | Mints/caches this service's own Clerk M2M token for outbound `Authorization` | fetch, crypto |
| `replay.ts` | CLI: re-score logged decisions under knob overrides | scoring, knobs |

Dependency direction is strictly downward in that table's spirit: `scoring`
and `routeCost` import nothing local; FSMs never import repos except the
`ShipTask` type and `idleTask`; `knobs.ts` and `db.ts` must not import each
other (that cycle existed once; `transaction.ts` exists to break it).

## Invariants the scheduler depends on

- **One atomic action per tick per ship.** Assign a target, *or* dispatch one
  command, *or* resolve one elapsed wait. `FleetScheduler.tick` returns after
  whichever happens first. A replan that considered the configured ship counts
  as that ship's action for the tick (`maybeReplan` returns the set it touched).
- **One process drives a ship.** `IntervalLoop`'s guard only covers this
  process; `DispatchLock` covers the rest. A tick that cannot take the lock
  logs `dispatch_standby` once and does nothing. `stop()` drains the loop
  *before* releasing, or a standby would start dispatching alongside an
  in-flight tick. The lock holds a pooled connection for as long as it is
  held, so a `pool.end()` without a preceding `stop()` will wait forever.
- **Contract discovery runs once per tick, not once per ship.** What is on
  offer belongs to the agent, not to whichever ship is idle. `assignTarget`
  takes an already-read ship so one assignment costs one ship read.
- **FSMs are DB-free and return the next task.** `advance*Task(ctx)` takes
  `{task, ship, clients, clock}` and returns `TickResult | null`
  (`null` = wait still pending). Anything worth remembering rides on
  `result.observations`; the scheduler persists it. Never query Postgres from
  an FSM.
- **Persist order: task → observations → event.** Readers of an event can
  trust the state it describes is already visible. Observation writes are
  best-effort (caught, logged as `observation_write_error`); the task save is
  not.
- **Discard after abort.** A dispatch can't be un-sent, but if status is
  `aborted` or mode is `shadow` by the time it returns, the result is logged as
  `mining_discarded_after_abort` and *not* saved. `paused` still lets the
  in-flight result land (that is what pause means). See `isStillLive()`.
- **Idle predicate** is `asteroid_waypoint IS NULL AND contract_id IS NULL`
  (`isIdle`, `ShipTaskRepo.listIdle`). Only idle ships are ever (re)assigned;
  running work is never preempted.
- **`idleTask(task)` is the base for every assignment and every completion.**
  It resets task kind, phase, all targets, `failureCount`, and the cycle
  tallies. Don't build a fresh task any other way; a stale `cycleRevenue`
  carried into a new cycle corrupts the observation written at its end.
- **`asteroidWaypoint` is "where the planner sent me" for every task kind**,
  including scouts (the scout target lives there). `marketWaypoint` is the sell
  market for mining and the procurement market for contracts; `tradeSymbol` is
  the extracted good or the deliverable. Renaming the columns means a
  migration plus a change to the `/autopilot/ships/:s` response shape.
- **Two failure counters, two budgets.** `failureCount` counts consecutive
  failures that are evidence about the target (`rejected`, `malformed`,
  `internal`) and is spent against `mine.failureRetryLimit`;
  `unrelatedFailureCount` counts the ones that are evidence about the plumbing
  (`unavailable`, `credentials`) and is spent against
  `mine.failureRetryLimit × UNRELATED_FAILURE_RETRY_MULTIPLIER`. Both reset to
  0 on any successful action. At either limit the task is abandoned via
  `idleTask` *unless* cargo is at stake: for mining that's `tradeSymbol !==
  null`; for contracts it's phase `CONTRACT_TRAVEL_TO_DESTINATION` or later (a
  purchase has happened). An abandoned contract goes back to status `accepted`.

  They are two columns and not one because one number cannot be spent against
  two budgets. Five ticks of an outage on a shared counter leaves the next
  genuine refusal one strike from abandoning a target it has never once failed
  against — and a recovery is exactly when refusals arrive, because the game
  state has moved on while the ship sat there. Fleet-wide, on the same tick.

  The multiplier is a number rather than "never give up" on purpose. A ship
  pinned to a permanently broken upstream answer is real — navigation-service
  serves a deterministic 500 for a market whose cached row it cannot parse, and
  nothing here ever asks it to refresh — and a scout has no cargo at stake to
  justify retrying forever. It is a tick count, not a duration: dropped timer
  fires and the 15s call timeout make 300 ticks anywhere from 25 minutes to a
  few hours, all of which outlast a deploy.
- **A failed tick must not stamp `updated_at`.** `ShipTaskRepo.recordFailure`
  writes the counters and nothing else, because `updated_at` is what
  `ship_idle` measures from: stamping it made a ship that had been failing for
  half an hour look like one that had just done something. Use `save()` for a
  state change and `recordFailure()` for a failure.
- **The verdict, not the status code, is what anything branches on.**
  `gameClients.ts` classifies every failed call once, where the transport error
  and the response are both still in hand, into `unavailable` (never reached
  the game), `credentials` (we cannot authenticate), `malformed` (our request
  was wrong) or `rejected` (the game refused the action). `handleTickFailure`
  is the only consumer that branches, and `UpstreamCallError` no longer carries
  a status code at all. `server.ts`'s error handler used to re-serve one, which
  was both unreachable (no route calls an upstream service) and misleading,
  since it implied an operator's `401` might be the fleet's own expired token.

  `scheduler.ts` widens the type to `FailureVerdict` with one more case,
  `internal`: our own code threw. Use `verdictOf(err)` rather than testing
  `instanceof` again.

  This exists because all four used to be one thing: an expired M2M token or a
  ten-minute fleet-service outage ticked `failureCount` on every ship until the
  retry limit abandoned every task in the fleet, then re-planned them onto
  targets that were never the problem (auth-design.md decision 19).

  Two classification details match documented upstream behaviour rather than
  guesses, and both are *bonus* signals — the status alone already lands on a
  safe verdict. `400` is `rejected` unless the body carries `error.fields`,
  which **only fleet-service emits** (tsoa validation); agent-service answers
  plain text and navigation-service answers RFC 9457, so their own validation
  failures read `rejected` and simply get the full retry budget. `503` is
  `credentials` only when the message says the credential is not configured,
  the sole thing separating st-gateway's two 503s — and that signal does not
  survive navigation-service, which collapses every upstream 5xx into its own
  `502`. Those gaps cost precision in an event's `failureKind`, never safety.

  What must not be done is give `malformed` a shorter fuse than `rejected`:
  fleet-service and agent-service answer `404` for any unrouted path, so a
  rolling deploy produces one, and treating that as a proven-permanent bug
  would abandon the whole fleet on a single bad tick — the same failure by
  another route.
- **A foreign phase throws.** `advanceMiningTask` on a `SCOUT_*` phase throws
  rather than returning `null`, so a corrupt row is counted as a failure and
  eventually reassigned instead of stalling silently forever.
- **Contract assignment is transactional** (`withTransaction`): contract status
  → `assigned` and the `ship_task` write commit together, or neither does.
  `listAccepted()` only returns `accepted`, so an orphaned `assigned` row is
  invisible to the planner forever.
- **Errors from `getShip` and other pre-FSM calls are infra errors**, caught by
  the loop's `onError` → `mining_tick_error` without a failure count. Only
  throws inside `advance()` count against the target.

## Scheduler tick order

`tick()` in `scheduler.ts`, in order: status not armed/paused → return; no
token → return; shadow mode → run shadow cycle (armed only), return; armed →
`maybeReplan` (both a debounced request and the periodic interval are checked
here; the request flag is cleared either way); if this ship was replanned →
return; load/create task; idle → assign (armed only), return; paused and not
waiting → return; `getShip`; `advance`; discard check; persist.

Replan debounce: `lastReplanAt` gates requests (`replan.debounceSeconds`), the
periodic fallback is measured from `lastReplanAt ?? startedAt` so a fresh arm
never fires one immediately.

## IntervalLoop

Every scheduler (`FleetScheduler`, `AnomalyScheduler`, `MetricsScheduler`)
wraps an `IntervalLoop`. Semantics you can rely on:

- A timer firing while a tick is in flight is dropped, not queued.
- `stop()` sets `stopped`, clears the timer, and resolves only after the
  in-flight tick finishes. Long ticks poll `loop.stopped` between awaits to
  avoid writing after a stop (the anomaly tick does this before every write).
- `start()` clears `stopped`. **This is the fix for "re-arm after abort never
  ticks again"**; if you add a scheduler, use `IntervalLoop`, don't hand-roll.
- `runOnce()` drains any in-flight tick then runs exactly one. Exposed to tests
  as `app.locals.forceAnomalyTick`. There is deliberately no `await` between
  a test's state mutation and `forceTick`, so no timer tick can interleave.
- The error callback's own rejection is swallowed (it is usually an event-log
  write, which can itself fail).

## Planner and scoring

- `Planner.loadContext(systemSymbol)` is one waypoint fetch, one
  agent fetch, one knob read, one calibration. Every arm of a decision scores
  against the *same* context. `assignTarget` loads it once; contract discovery
  loads one more when there is something new to evaluate (and reads every
  market once, then calls the *pure* `evaluateContract` per contract).
- Viability = reachable ∧ not breaching the reserve floor ∧ **score > 0**.
  Zero-weight task kinds and non-positive-profit contracts are therefore never
  assigned. Ties: contract must strictly beat both others; scout beats mining
  strictly and contracts on ties.
- The reserve-floor cost estimate for a contract is
  `totalPayment − expectedProfit` (procurement + travel, not broken out on the
  record). A record with `procurementMarket === null` is unworkable and is
  skipped outright; its `expectedProfit` is `-Infinity`, which Postgres float8
  accepts and `JSON.stringify` turns into `null` inside event detail.
- **Log shape matters to `replay.ts`.** A mining or `none` decision logs
  `candidates`, `knobsUsed`, `model`, `currentCredits`, `chosen` flat in
  `detail`; a contract or scout decision nests all of that under
  `detail.miningDetail`. `loadDecisions` accepts both; don't add a third shape.
- Scouting staleness for a never-seen market is `stalenessThresholdHours × 10`
  (finite on purpose).
- `scoring.ts` must stay free of I/O and of imports from the rest of `src`.

## Observations and calibration

- `travel_observation` rows are dual-purpose: `(distance, hours)` from a
  flight (`measureFlight` needs `route.departureTime` and both endpoints'
  `x`/`y`, else the flight is silently unmeasured), or `(distance, fuel_credits)`
  from a refuel where `distance` is the **units bought** (units == distance in
  cruise flight; see `refuelIfNeeded`). Each calibration reads only the rows
  that carry its field.
- `mining_observation` is written once per completed cycle from the task's
  running tallies (`cycleStartedAt` starts at the first *navigate*, not at
  assignment; `cycleTravelDistance` and `cycleUnitsExtracted` accumulate).
  Overhead is calibrated as `cycleHours − travelDistance/speed`, clamped at 0.
- `calibrate()` reads at most 14 days back, recency-weighted by
  `observation.halfLifeHours`. Travel is capped at 500 rows fleet-wide; mining
  is capped **per waypoint** (`ROW_NUMBER() OVER (PARTITION BY ...)`), because
  a global cap silently erased a rarely-mined field's own history on a busy
  fleet. Rates (speed, fuel) are `weightedRatio` (sum/sum), not means of
  per-sample ratios.
- Per-field revenue is shrunk toward `fleetCreditsPerCycle` by
  `FLEET_PRIOR_WEIGHT` pseudo-observations. Decay alone does not stop a single
  cycle setting a field's estimate outright — a weighted mean over one sample
  is that sample. Changing that constant changes how fast the planner commits
  to a newly-measured field; the tests that pin it seed enough cycles to
  outweigh it deliberately, so re-tune both together.
- Mining overhead (`cycle.overheadHoursPrior`, measured as a residual)
  includes survey, extraction and cooldown. Scout and contract cycles do none
  of those and are charged `cycle.transactOverheadHoursPrior` instead. Do not
  reuse the mining figure for a task kind that only docks and transacts.
- A contract's `expectedProfit` is frozen at discovery (it depends on prices
  the decision has not re-read); its cycle time is **re-derived** from the
  stored `travel_distance` under the current model, because mining is always
  scored on the current model and comparing the two otherwise drifts.
- `priorsFromKnobs(knobs)` is the only way priors should be built from knob
  values; `/planner/model` and the planner both go through it.

## Market freshness

`market_intel.last_refreshed_at` means "a ship of ours read this market while
docked there". It is written from `TickObservations.marketsRefreshed`: the
scout refresh, and the mining `SELL` step's `getMarket` (both the sell and the
reselect branch). `findBestMarket`'s from-afar reads are **not** refreshes;
they only feed `mining_market_selected.detail.marketsChecked`, which is what
`market_stale` uses to define "in active use" (24h lookback, hard-coded).
Both the planner's scout scoring and the `market_stale` check read
`market_intel`; keep it that way or they will disagree again.

## Knobs

- `KNOB_DEFINITIONS` is `as const satisfies readonly KnobDefinition[]`, so
  `KnobName` is a union of the literal names and `KnobRepo.get`/`getValues`
  are typed. `getValues()` throws if any defined knob is missing from the
  table. `set(name: string)` stays stringly typed because it takes API input.
- Adding a knob: add the definition (name, class, default, min ≤ default ≤
  max, description). `migrate()` → `syncKnobDefinitions()` inserts it on boot;
  removing it deletes the row; tightened bounds clamp the stored value.
  `knobClasses.test.ts` asserts every class is represented and bounds are sane.
- Classes are a security boundary, enforced on **both** paths. Reads: the
  `?class=` filter. Writes: `KnobRepo.set(name, value, allowedClasses?)`
  checks the class inside the same row lock as the write and throws
  `KnobClassForbiddenError` (→ 403). A Clerk `fleet:control` caller passes no
  restriction and may write any class; a machine caller (`X-Service-Secret`)
  is restricted to `policy`. Never move an `alert` or `model` knob to `policy`
  casually, and never call `set` without `allowedClasses` on a path a
  non-operator can reach.
- A default is a safety decision. `credit.reserveFloor` defaults to a real
  reserve because at `0` the check reserves nothing, and the failure it guards
  is unrecoverable in-game. Changing a default only affects rows that don't
  exist yet: `syncKnobDefinitions` updates `default_value` but preserves
  `value`, since it cannot tell a deliberately-set value from a stale default.
- `resetDatabase()` in tests resets all knobs to defaults **and sets
  `scout.creditsPerRefresh` to 0** unless `{ enableScouting: true }`; a test
  that unexpectedly sees a scout assignment usually forgot this.

## Events

`event_log` is append-only and is the audit trail, the metrics source, and
part of the API. Type names are consumed outside this repo (command-interface,
ai-service); treat them as public. Things that depend on specific types:

| Consumer | Reads |
|---|---|
| `fleetEvents.ts` | **Owns the vocabulary.** Which types mean task progress, a failed action, and credits arriving |
| `MetricsRepo` | `mining_extract.units`, plus `fleetEvents`' revenue and error-rate predicates |
| `AnomalyChecker.checkErrorRate` | `fleetEvents`' task-progress and error predicates |
| `AnomalyChecker.detectCreditsFlat` | `agent_credits_snapshot.credits`, written by the anomaly scheduler only while armed & live |
| `AnomalyChecker.detectNoEarnings` | `fleetEvents`' earning predicate, and `armed`/`paused`/`aborted` as the operator's stated intent |
| `AnomalyChecker.checkMarketStaleness` | `mining_market_selected.marketsChecked` |
| `replay.ts` | `planner_assignment`, `planner_shadow_assignment` (shape above) |
| `/anomalies/digest` | `NOTABLE_EVENT_TYPES` in `server.ts`. The test for inclusion is "would someone be wrong about the fleet without it, and does nothing else say it?" — not "is it an error". Routine per-tick events stay out; a bounded list nobody reads is worse than no list |

**Ask `fleetEvents.ts`, never write your own `type LIKE …`.** Both alarms and
the rollup used to spell these questions out separately, and drifted into
agreeing with each other about the wrong thing: they counted errors that every
task kind logs against a denominator of mining events only, so a contract-only
window read as a 100% error rate; and they proved earnings with `mining_sell`
alone, so a fleet earning on contracts read as earning nothing.

Scheduler-level errors are logged as `mining_tick_error` for every task kind —
the name is historical and means "a tick failed", not "a mining tick failed".
Renaming it would strand every historical row, so it stays; what must not
happen again is a *denominator* that reads the name literally.
`mining_tick_error`, `mining_task_failed` and `contract_discovery_error` each
carry a `failureKind` — the verdict above — so a digest can say *why* the fleet
is failing without anyone re-deriving it from a message string. That includes
the `mining_tick_error`s written by the loop's own error callback, which are
most of them during an outage (every `getShip` and planner call fails there,
before any FSM runs) — though only `mining_task_failed` and
`contract_discovery_error` are in `NOTABLE_EVENT_TYPES`, so the digest sees
those two and the raw event feed carries the rest.

Event `detail` must never contain a token or anything token-shaped; `actor`
is the Clerk `sub` only.

## Database

- `migrate()` is idempotent DDL run on every boot: `CREATE TABLE IF NOT
  EXISTS` plus `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for later columns.
  There is no migration runner and no down migrations. Add columns the same
  way; never rename or drop in place.
- Adding a table: add it to `STATE_TABLES` in
  `src/testSupport/resetDatabase.ts` or tests will leak state between files.
- Numeric columns come back from `pg` as strings for `NUMERIC` and as numbers
  for `DOUBLE PRECISION`; the row mappers `Number(...)` everything to be safe.
- `ship_task.updated_at` is stamped by every `save()` and is what `ship_idle`
  measures from (together with `waiting_until`). `recordFailure()` deliberately
  does not stamp it — see the invariant above.

## Upstream services and SpaceTraders facts

- Reads and buy/sell go to **agent-service** (`/ships/:s`, `/agent`,
  `/contracts`, `/ships/:s/sell|purchase`); ship movement and mining actions
  go to **fleet-service** (`/ships/:s/orbit|dock|navigate|survey|extract/survey|refuel`,
  `/contracts/:id/deliver`); waypoints and markets go to
  **navigation-service**.
- **One header on every outbound call** (auth-design.md decisions 5/19).
  `Authorization: Bearer <M2M token>` is *this service's own* Clerk machine
  token, minted and cached by `m2mToken.ts` and fetched inside `callJson`. No
  game credential exists in this service: st-gateway injects it. Nothing is
  threaded through the scheduler, planner or FSMs for auth — `TaskContext` has
  no token field and `AutopilotState` holds only status and mode. Reintroducing
  either is a regression.
- M2M token sources: `createClerkM2MTokenSource` (production, mints via
  Clerk's Backend API against `CLERK_M2M_SECRET_KEY`, cached and refreshed at
  half its lifetime, prefers a stale-but-unexpired token over a failed
  refresh) and `createLocalM2MTokenSource` (local dev via
  `DEV_M2M_SIGNING_KEY_FILE`, and tests via an ephemeral keypair in
  `createTestApp`). `createApp` falls back to a throwaway local signer when
  `mining` is set without `authTokenSource`; that fails safe, since nothing
  production trusts it. Test stub servers don't verify either header.
- `getMarket` returns `tradeGoods` only when one of our ships is at the
  waypoint; otherwise navigation-service serves whatever it has cached.
- A ship `IN_TRANSIT` flips to `IN_ORBIT` by itself once `route.arrival`
  passes; `travelTo` treats "at destination and not in transit" as arrived and
  resumes a wait from `route.arrival` after a restart.
- `navigate` requires `IN_ORBIT` (so `travelTo` orbits first); `sell`,
  `purchase`, `refuel`, `deliver`, `getMarket`-as-refresh require `DOCKED`.
- Refuel responses may or may not include `transaction.units`/`totalPrice`;
  absence means no fuel observation, never an error.
- Every upstream call has a 15s timeout (`AbortSignal.timeout`) so a hung
  service can't wedge the one-tick-at-a-time guard forever. A timeout is
  `unavailable`, so it costs the ship a tick and nothing else.

## Testing

- Real Postgres, one shared database, `maxWorkers: 1` in `jest.config.js`.
  Every file calls `resetDatabase(pool)` in `beforeEach`.
- Integration tests spin up three stub `http` servers (agent, fleet, nav) on
  port 0 and a `FakeClock`; the stubs mutate a shared `ship` object so the
  next `getShip` reflects the action. Copy an existing file's `beforeEach`
  rather than inventing a new harness.
- `taskFsm.test.ts` is the fast path: drives `advance*Task` with a `Proxy`
  fake `GameClients` that rejects any unstubbed call. Prefer it for FSM edge
  cases; use the HTTP loop only for scheduler/planner behaviour.
- Cleanup order matters: `afterEach` must `stopBackgroundSchedulers()` (metrics
  and anomaly loops are *not* tied to abort) and `POST /autopilot/abort` (which
  awaits the fleet loop's drain) before closing stubs or truncating.
- **Tests drive every tick; nothing runs on a wall clock.** All three loops —
  fleet, anomaly and metrics — are created with an interval long enough never
  to fire, and the test advances them explicitly with
  `app.locals.forceFleetTick()`, `forceAnomalyTick()` and `forceMetricsTick()`. Each forces exactly one tick and awaits it to
  completion, so a `FakeClock` jump can never be straddled by a background tick
  judging a half-arranged window.

  This replaced every `while (Date.now() < deadline)` poll and every
  `setTimeout` sleep in the suite — there are now **zero** of either —
  which were the source of every flake this suite has had: `669b101` (poll and
  tick periods aliasing, so a one-tick phase was invisible), `649d266`
  (`credits_flat` racing a `FakeClock` jump), and a 2026-09-06 recurrence where
  two `taskFsm` assertions failed only in full runs.

  Two rules follow. **Never sleep to let the loop work** — a sleep proves time
  passed, not that anything ticked, so an assertion that "nothing happened"
  passes vacuously. Force the ticks instead. And **never `stop()` a loop and
  then force a tick**: `runOnce()` throws on a stopped loop rather than
  silently not ticking, which is the trap it exists to catch.
- Remaining timing pitfalls: polling for a phase that resolves within a single
  tick (poll for the *next* one instead); reusing a "wait is set" check across
  two consecutive waits (`waitForNewWait`); polling for the first of several
  anomalies when the assertion needs all of them (anomalies persist one at a
  time with a webhook delivery in between).
- Auth is never bypassed in tests: `createTestApp` supplies an ephemeral RSA
  keypair (`authTokens.ts`) and `bearer()` signs real tokens with it.
- `contract.test.ts`'s `makeFlakyPool` proxies a `Pool` to fail exactly one
  matching query, including inside a transaction; reuse it for
  "crash between two writes" cases.
- **A stub that fails a ship action must pick a status that means what the test
  means.** A `500` is `unavailable`, which buys the target a hundred times the
  usual patience, so "this target keeps failing" simulated with one will time
  out rather than reassign — two tests in this suite did exactly that. Use a
  `400` with the game's envelope (`{ error: { message } }`) for a refusal.

## Conventions

- Comments explain *why*, and name the `meta#NN` issue when a behaviour exists
  because of one. Keep them; the CHANGELOG links decisions to issues the same
  way.
- `createApp` takes an options object; add fields there, not positional
  params. `createTestApp` keeps its positional signature for the tests.
- Schedulers take a deps object (`FleetSchedulerDeps`, `AnomalySchedulerDeps`).
- New background work goes on an `IntervalLoop`. New task kinds add a phase
  union to `shipTaskRepo.ts`, a `PHASE_AFTER_WAIT` entry per waiting phase, an
  `advance*Task`, a `case` in `FleetScheduler.advance`, and a `resetDatabase`
  consideration if they need a knob to compete.
- Update README (human-facing) and this file (implementation) together with
  the code; add a CHANGELOG entry for anything a reviewer of a later PR would
  want explained.

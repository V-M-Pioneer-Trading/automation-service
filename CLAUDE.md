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
| `anomaly.ts` | `AnomalyRepo`, `AnomalyChecker` (five read-only checks) | knobs, marketIntel |
| `anomalyScheduler.ts` | Runs checks, dedupes, persists, delivers, requests replans | anomaly, webhookDelivery |
| `metrics.ts`, `metricsScheduler.ts` | Rollups over `event_log` windows | eventLog table |
| `shipTaskRepo.ts`, `contractRepo.ts`, `marketIntelRepo.ts`, `eventLog.ts` | Row ↔ object repos. Repos taking `Pool \| PoolClient` can join a transaction | clock |
| `autopilotState.ts` | In-memory status/mode/token. Never persisted by design | nothing |
| `auth.ts` | Networkless Clerk JWT verification, service-secret guard | jose |
| `config.ts` | `configFromEnv()`; every numeric env var validated positive | fs |
| `gameClients.ts` | Typed fetch wrappers for the three upstream services, 15s timeout, dual auth headers | m2mToken, fetch |
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
- **FSMs are DB-free and return the next task.** `advance*Task(ctx)` takes
  `{task, ship, clients, clock, spaceTradersToken}` and returns `TickResult | null`
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
- **`failureCount` resets to 0 on any successful action** and increments on any
  FSM throw. At `mine.failureRetryLimit` the task is abandoned via `idleTask`
  *unless* cargo is at stake: for mining that's `tradeSymbol !== null`; for
  contracts it's phase `CONTRACT_TRAVEL_TO_DESTINATION` or later (a purchase
  has happened). An abandoned contract goes back to status `accepted`.
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

- `Planner.loadContext(systemSymbol, spaceTradersToken)` is one waypoint fetch, one
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
- `calibrate()` reads at most 500 rows per table, at most 14 days old,
  recency-weighted by `observation.halfLifeHours`. Rates (speed, fuel) are
  `weightedRatio` (sum/sum), not means of per-sample ratios.
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
- Classes are a security boundary: `GET /planner/knobs?class=policy` is the AI
  supervisor's entire write surface. Never move an `alert` or `model` knob to
  `policy` casually.
- `resetDatabase()` in tests resets all knobs to defaults **and sets
  `scout.creditsPerRefresh` to 0** unless `{ enableScouting: true }`; a test
  that unexpectedly sees a scout assignment usually forgot this.

## Events

`event_log` is append-only and is the audit trail, the metrics source, and
part of the API. Type names are consumed outside this repo (command-interface,
ai-service); treat them as public. Things that depend on specific types:

| Consumer | Reads |
|---|---|
| `MetricsRepo` | `mining_sell.totalPrice`, `mining_extract.units`, all `mining\_%` for the error-rate denominator, `mining_tick_error` + `mining_task_failed` as errors |
| `AnomalyChecker.checkErrorRate` | same `mining\_%` split (note the escaped underscore in `LIKE`) |
| `AnomalyChecker.detectCreditsFlat` | `agent_credits_snapshot.credits`, written by the anomaly scheduler only while armed & live |
| `AnomalyChecker.checkMarketStaleness` | `mining_market_selected.marketsChecked` |
| `replay.ts` | `planner_assignment`, `planner_shadow_assignment` (shape above) |
| `/anomalies/digest` | `NOTABLE_EVENT_TYPES` in `server.ts` |

Scheduler-level errors are logged as `mining_tick_error` for every task kind
(historical name; renaming it changes the metrics and anomaly denominators).
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
  measures from (together with `waiting_until`).

## Upstream services and SpaceTraders facts

- Reads and buy/sell go to **agent-service** (`/ships/:s`, `/agent`,
  `/contracts`, `/ships/:s/sell|purchase`); ship movement and mining actions
  go to **fleet-service** (`/ships/:s/orbit|dock|navigate|survey|extract/survey|refuel`,
  `/contracts/:id/deliver`); waypoints and markets go to
  **navigation-service**.
- **Two headers on every outbound call** (auth-design.md decisions 18/19).
  `Authorization: Bearer <M2M token>` is *this service's own* Clerk machine
  token, minted and cached by `m2mToken.ts` and fetched inside `callJson`;
  `X-SpaceTraders-Token` is the raw game token the operator armed with. The
  value threaded through the scheduler, planner and FSMs is the **raw game
  token** (`spaceTradersToken`), never a pre-built Authorization value — do
  not wrap it in `Bearer `. `AutopilotState.getToken()` returns it as-is.
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
  service can't wedge the one-tick-at-a-time guard forever.

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
- Timing pitfalls that have caused flakes before: polling for a phase that
  resolves within a single tick (poll for the *next* one instead); reusing a
  "wait is set" check across two consecutive waits (`waitForNewWait`); polling
  for the first of several anomalies when the assertion needs all of them
  (anomalies persist one at a time with a webhook delivery in between); a real
  tick spanning a `FakeClock` jump (use `forceAnomalyTick`).
- Auth is never bypassed in tests: `createTestApp` supplies an ephemeral RSA
  keypair (`authTokens.ts`) and `bearer()` signs real tokens with it.
- `contract.test.ts`'s `makeFlakyPool` proxies a `Pool` to fail exactly one
  matching query, including inside a transaction; reuse it for
  "crash between two writes" cases.

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

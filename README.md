# automation-service

Autopilot lifecycle, mining loop, planner, shadow mode, metrics rollups,
anomaly detection, and append-only event log for the SpaceTraders fleet
([meta#8](https://github.com/V-M-Pioneer-Trading/meta/issues/8),
[meta#9](https://github.com/V-M-Pioneer-Trading/meta/issues/9),
[meta#10](https://github.com/V-M-Pioneer-Trading/meta/issues/10),
[meta#14](https://github.com/V-M-Pioneer-Trading/meta/issues/14),
[meta#15](https://github.com/V-M-Pioneer-Trading/meta/issues/15),
[meta#21](https://github.com/V-M-Pioneer-Trading/meta/issues/21)).

## What it does

- **Arm**: `POST /autopilot/arm { token, mode? }` holds the SpaceTraders
  account token **in memory only** — nothing token-shaped is ever written to
  Postgres or echoed back. A restart always disarms; there is no
  auto-resume. Arming is allowed from any status (including re-arming after
  a pause or abort), and starts the mining scheduler if one is configured.
  `mode` is `"live"` (default) or `"shadow"` — see below. Switching between
  them always goes through an explicit re-arm; there's no other way to
  change it.
- **Pause**: `POST /autopilot/pause` — only valid while armed. The scheduler
  keeps polling so an already-dispatched wait (a transit or a cooldown) gets
  to finish and its result gets recorded, but no *new* action is dispatched
  afterward — the ship idles at whatever phase that wait resolved into.
- **Abort**: `POST /autopilot/abort` — valid while armed or paused, clears
  the held token and stops the scheduler immediately (no further dispatch,
  not even finishing an in-flight wait).
- **Status**: `GET /autopilot/status` — current lifecycle state and mode
  (`mode` is `null` whenever no token is held, i.e. disarmed or aborted).
- **Event log**: every transition and every mining action is appended to
  Postgres (`GET /autopilot/events?limit=`, newest first) and survives
  restarts even though the lifecycle state itself does not.

Invalid transitions (e.g. pausing while disarmed) return `409` naming the
current status. A DB failure on the event-log write returns `500` rather
than hanging the request — but note the in-memory status has already
transitioned by that point (arm/pause/abort mutate state, then persist the
event), so a failed write can leave status and the audit trail briefly
diverged. Acceptable for now (single-row insert, no distributed transaction
available between memory and Postgres); revisit if it proves troublesome
once real dispatch traffic exists.

## Mining loop (meta#9)

While armed, one configured ship runs travel → survey → extract → travel to
market → sell → refuel → repeat, driven entirely through navigation-service,
agent-service, and fleet-service — this service never calls SpaceTraders
directly. Per-ship progress persists to Postgres (`ship_task`), so a restart
+ re-arm resumes from the last completed phase instead of starting over.

`GET /autopilot/ships/:shipSymbol` returns the ship's current phase, wait
state, and in-progress survey/market data.

**Deliberate tracer-bullet simplifications** (this ticket proves the FSM
end-to-end for one ship; picking *which* asteroid field to mine is the
planner's job, [meta#10](https://github.com/V-M-Pioneer-Trading/meta/issues/10)):

- The ship is fixed by config (`MINING_SHIP_SYMBOL`); which field it mines is
  chosen dynamically by the planner (see below). Multi-ship, fleet-wide
  dispatch is still future work — the planner's `assignMiningTarget` is
  already per-ship, so extending to N ships is mostly scheduler wiring, not
  new scoring logic.
- "Best nearby market" is real (queries navigation-service for every
  in-system marketplace and picks the highest sell price for whatever was
  extracted) but has no route-cost/BFS awareness — "nearby" just means
  "in the same system." The planner's fuel-aware routing (meta#10) only
  governs which asteroid field is chosen, not the sell-side market leg.
- Tracks only the single most-recently-extracted trade good. If a survey
  yields more than one resource type before cargo fills, market selection
  and selling only account for the last one — a sell that fails because the
  chosen market doesn't buy an earlier-extracted good surfaces as a repeating
  `mining_tick_error` rather than being resolved automatically. That's the
  intended fallback for now: this is exactly the sustained-failure pattern
  [meta#11](https://github.com/V-M-Pioneer-Trading/meta/issues/11) (anomaly
  detection) is meant to catch and surface, rather than something this ticket
  should silently paper over.

The scheduler ticks on a fixed interval (`SCHEDULER_INTERVAL_MS`) and
performs **at most one atomic action per tick** — dispatch a command, resolve
an elapsed wait, or get a planner assignment, never more than one of those.
That granularity is what makes pause take effect between actions instead of
admin-killing something mid-flight. Abort stops the scheduler's timer
immediately, but an action already in flight when abort lands can't be
un-sent — its result is discarded (not persisted, not logged as a real
action; a `mining_discarded_after_abort` event marks it) rather than
silently taking effect after the operator asked to stop.

## Planner (meta#10)

Whenever a ship has no assigned asteroid field — a brand new task, the moment
a cycle completes, or after a target has failed out (see below) — the
scheduler's very next tick asks the planner for one, instead of waiting on
any separate periodic process. That's the scheduler's one atomic action for
that tick; dispatch toward the new target starts the tick after.

**Scoring**: every `ASTEROID_FIELD` waypoint in the ship's system is scored
in expected credits/hour. Route cost from the ship's current position (and
back) is computed with a fuel-aware Dijkstra search
([`routeCost.ts`](src/routeCost.ts)) over the system's waypoint graph — a leg
longer than the ship's fuel range is infeasible, and a multi-leg route may
only pass through waypoints with a fuel station (a `MARKETPLACE` trait,
in practice) except at its final stop. Unreachable fields score nothing.
Reachable fields are scored `(expectedCreditsPerCycle × taskWeight) /
cycleHours`, where `cycleHours` comes from round-trip distance over an
assumed travel speed plus a fixed survey/extract/cooldown/sell overhead — all
knob-configurable. The planner never assigns a field whose estimated
round-trip fuel cost would drop the agent's credits below the configured
reserve floor; if every reachable field would breach it, no assignment is
made (`planner_no_viable_target`) and the ship idles until conditions change.

Every assignment decision — every candidate considered, its distance,
reachability, score, and reserve-floor check, plus the knob values used — is
logged as a `planner_assignment` event, so any decision can be replayed from
`GET /autopilot/events`.

**v1 simplification**: `expectedCreditsPerCycle` is a flat knob-configured
estimate, not yet derived from real per-good extraction yield and market
price data — scoring which field is *fastest to reach* is real; scoring which
field is *most profitable to mine* is future work. Fuel-station detection
also just checks the `MARKETPLACE` trait rather than confirming the market
actually stocks `FUEL`.

**Failure-driven reassignment**: if working the assigned target keeps
failing (`mine.failureRetryLimit` consecutive tick errors, default 3), the
scheduler resets the ship to a fresh planner assignment on its very next
tick — unless the ship is already holding cargo extracted from that target
and hasn't sold it yet, in which case it keeps retrying the same target
indefinitely rather than stranding that cargo.

### Knobs

`GET /planner/knobs` lists every knob (`name`, `value`, `default`, `min`,
`max`). `PUT /planner/knobs/:name { value }` updates one — `404` for an
unknown name, `400` for a value outside `[min, max]`.

| Knob | Default | Meaning |
|---|---|---|
| `mine.taskWeight` | `1` | Multiplier applied to every mining-task score. |
| `mine.expectedCreditsPerCycle` | `5000` | Flat estimated revenue per cycle (v1 simplification above). |
| `travel.speedUnitsPerHour` | `30` | Assumed ship speed for travel-time estimates. |
| `cycle.fixedOverheadHours` | `0.3` | Fixed survey+extract+cooldown+sell time per cycle. |
| `fuel.creditsPerUnitDistance` | `5` | Assumed credits cost per unit of travel distance. |
| `credit.reserveFloor` | `0` | The planner never assigns work that would drop credits below this. |
| `mine.failureRetryLimit` | `3` | Consecutive tick failures on one target before reassigning away from it. |

## Contract loop (meta#11)

A ship that needs a target is offered contracts alongside asteroid fields —
whichever scores higher in the same expected-credits/hour units wins. A
second FSM (`advanceContractTask`, mirroring the mining FSM's one-atomic-
action-per-tick discipline) carries an accepted contract through
`CONTRACT_TRAVEL_TO_MARKET → CONTRACT_PURCHASE → CONTRACT_TRAVEL_TO_DESTINATION
→ CONTRACT_DELIVER → CONTRACT_FULFILL`, reusing the mining FSM's travel/dock
helpers since traveling for a contract behaves identically to traveling to
mine. Both FSMs share one `ship_task` row (`task_kind` distinguishes them) —
a ship works one target at a time, whichever kind it is.

**Discovery and evaluation**: right before every scoring decision, the
scheduler calls `discoverAndEvaluateContracts` synchronously — fetches
contracts not yet seen, evaluates each deterministically
(`Planner.evaluateContract`: cheapest in-system market selling the
deliverable good, fuel-aware route cost from the ship's position through that
market to the delivery destination, `expectedProfit = totalPayment -
procurementCost - travelCost`), and accepts or declines immediately based on
`contract.minProfitThreshold`. This is a plain function, not a background
scheduler — an earlier draft used one, and it raced the mining scheduler's
own assignment: a fresh, higher-scoring contract could still be mid-
evaluation when the ship got locked into mining instead. Calling it inline
guarantees discovery is always caught up before a decision is made. A
discovery failure (upstream hiccup) is caught and logged
(`contract_discovery_error`) rather than blocking mining — contracts are
additive on top of mining, never a hard dependency of it.

**Scoring**: an accepted contract's score is `(expectedProfit × taskWeight) /
cycleHours`, using the values frozen at evaluation time. The planner never
lets a contract win assignment if `currentCredits - (totalPayment -
expectedProfit)` would drop below `credit.reserveFloor` — the same
protection mining candidates get via their fuel-cost check, using
`totalPayment - expectedProfit` (procurement + travel cost combined) as a
conservative upper bound on what accepting would spend.

Every assignment decision — mining candidates, the best accepted contract's
score, and which one won — is logged as `planner_assignment`, same event
type mining-only decisions already used (the "none"/"mine" branches flatten
the mining detail rather than nesting it, so existing consumers reading
`detail.candidates` keep working unchanged when there are no contracts in
play).

**Failure and abandonment**: a contract task that fails out
(`mine.failureRetryLimit` consecutive errors, same knob as mining) releases
the contract back to `accepted` status rather than leaving it permanently
`assigned` to a ship that's given up on it, then resets the ship to a fresh
planner assignment — same pattern as mining's failure-driven reassignment.
Cargo already purchased toward a contract is treated the same as mining's
"cargo at stake" rule: the ship keeps retrying rather than abandoning a
target while cargo it can't easily dispose of sits in the hold.

**v1 simplifications**:

- Only the contract's **first** deliverable is evaluated/worked — multi-good
  contracts are not yet supported.
- No standalone background scheduler for contract discovery — see above.
  With one ship that can only work one target at a time, there's no benefit
  to ahead-of-time discovery; revisit once multiple ships mean contracts
  should be pursued ahead of any one ship actually needing work.
- `discoverAndEvaluateContracts` runs on every assignment tick with no cheap
  pre-check or cooldown — acceptable given how infrequently a ship actually
  needs a fresh assignment (once per idle-ship tick, not every scheduler
  tick), but would need one if that assumption stops holding.
- Purchase quantity math (`dispatchPurchase`) treats the ship's entire cargo
  hold as belonging to the contract's trade good — correct for a
  contract-dedicated ship with an empty hold at assignment time (mining
  always sells out before handing a ship back to the planner), but would
  undercount if a ship ever carried an unrelated good into a contract task.
- The reserve-floor check for contracts uses `totalPayment - expectedProfit`
  as a combined procurement+travel cost estimate rather than the
  procurement cost alone, since `ContractRecord` doesn't persist them
  separately — conservative (may decline a contract mining's equivalent
  check would allow), not permissive.

### New knobs

| Knob | Default | Meaning |
|---|---|---|
| `contract.taskWeight` | `1` | Multiplier applied to every contract-task score, same role as `mine.taskWeight`. |
| `contract.minProfitThreshold` | `0` | Minimum `expectedProfit` for a contract to be accepted. |

## Shadow mode (meta#21)

Arming with `mode: "shadow"` runs the planner's full scoring/assignment cycle
on the same schedule as live mode, and logs every decision as a
`planner_shadow_assignment` event (same scoring-input detail shape as live's
`planner_assignment`) — but never touches `ship_task` and never calls
`advanceMiningTask`, which is where every ship-action call to fleet-service
lives. Nothing is ever "assigned" for real in shadow, so the same cycle
recomputes and re-logs every tick: a continuous preview of what live mode
would decide, safe to run unattended before trusting it with a live session.

Switching from shadow to live (or back) always requires an explicit re-arm —
there's no other way to change `mode`, so an operator can't accidentally
drift from dry-run into live dispatch mid-session. Switching live to shadow
while a live dispatch is genuinely in flight (a real navigate/extract/sell
call already sent) doesn't undo that call — SpaceTraders has already acted
on it — but the scheduler discards its result rather than persisting or
logging it as something the (now-shadow) autopilot did; the ship's
`ship_task` phase resumes from wherever it was before the switch the next
time the operator re-arms live.

## Metrics rollups (meta#14)

Independent of autopilot arm/pause/abort — metrics, including the error
rate, are meaningful whether or not the fleet is currently armed — a
background scheduler computes and persists one rollup per tick
(`METRICS_ROLLUP_INTERVAL_MS`, default one minute in production), each
covering the window since the previous rollup ended. Resuming from the last
persisted rollup's `window_end` after a restart means no gap and no
double-counted window, same as `ship_task`'s restart-resumability.

Each rollup has:

- `creditsPerHour` — total `mining_sell` transaction revenue in the window,
  divided by the window's duration in hours. v1 simplification: revenue
  only, not netted against fuel or other costs.
- `extractionUnits` — total units extracted (`mining_extract`) in the window.
- `errorRate` — the fraction of all `mining_*` events in the window that were
  a `mining_tick_error` or `mining_task_failed`.

**v1 simplifications**: the "resume from the last persisted rollup" restart
logic assumes exactly one running instance — there's no distributed lock, so
two live instances (two replicas, or an old process not yet drained during a
restart) would each bootstrap from the same `window_end` and double-count
that window's activity. `metrics_rollup` also has no retention/pruning yet;
it grows one row per tick indefinitely.

`GET /metrics/context?rollupLimit=&eventLimit=` returns rollups and recent
event-log entries together in one bounded response (default 10 rollups / 20
events, capped at 200 / 100) — shaped to fit an AI context window, which is
what the future AI supervisor (meta#19) and MCP server (meta#20) will read.

## Anomaly detection (meta#15)

Independent of autopilot arm/pause/abort, once `ANOMALY_WEBHOOK_URL` is
configured — a background scheduler runs six deterministic health checks on a
fixed interval (`ANOMALY_INTERVAL_MS`), every threshold a bounded, AI-tunable
knob:

| Check | Fires when | Knob(s) |
|---|---|---|
| `ship_idle` | A mining ship's task hasn't changed phase in over N minutes, while armed and live | `anomaly.shipIdleMinutes` |
| `profit_drop` | The latest metrics rollup's credits/hour drops below a fraction of the trailing 6h average | `anomaly.profitDropFraction` |
| `consecutive_failures` | A ship's consecutive tick-failure count reaches a limit (regardless of arm state — a broken ship stays broken until investigated) | `anomaly.consecutiveFailureLimit` |
| `error_rate` | The fraction of `mining_*` events that are errors, in a trailing window, exceeds a threshold | `anomaly.errorRateThreshold`, `anomaly.errorRateWindowMinutes` |
| `credits_flat` | Agent credits show no net increase across a trailing window | `anomaly.creditsFlatWindowHours` |
| `market_stale` | A market priced in the last 24h (i.e. "in active use") hasn't been repriced in over N minutes | `anomaly.marketStalenessMinutes` |

Each anomaly is **persisted before** its webhook delivery is attempted —
`POST`ed as `{ id, type, dedupeKey, detectedAt, detail }` with up to 3 retries
and exponential backoff (`WebhookDelivery`). Repeat firings of the same
underlying condition (by `dedupeKey`) are suppressed for
`anomaly.dedupeCooldownMinutes` rather than paging the webhook every tick a
problem stays open. `GET /anomalies/digest?windowMinutes=&anomalyLimit=&eventLimit=`
returns anomalies plus notable lifecycle/failure events (not every routine
mining tick) for a requested window — the source for an hourly pull review.

**v1 simplifications**:

- `consecutive_failures` and `credits_flat` are **not** gated on the autopilot
  being currently armed/live, unlike `ship_idle` — a ship that failed
  repeatedly before an operator paused to investigate, or a credits trend from
  before a disarm, is still worth surfacing. This is deliberate, not an
  oversight.
- Within one tick, multiple newly-detected anomalies are persisted and
  delivered **sequentially**, not in parallel — if several checks trip at once
  against a slow/down webhook, later anomalies in that tick wait out the
  earlier ones' full retry/backoff budget before being persisted. Acceptable
  for the expected cadence (rarely more than one distinct condition trips in
  the same tick); revisit if that assumption stops holding.
- `market_stale`'s "in active use" window is a fixed 24h lookback, not itself
  a knob.
- The credits-flat check's only data source is a snapshot of agent credits
  logged each tick while armed and live — an anomaly-only deployment with no
  `MINING_SHIP_SYMBOL` configured never gets these snapshots, so
  `credits_flat` (and `ship_idle`/`consecutive_failures`, which need a ship
  task) stay permanently inert in that configuration.

## Configuration

| Env var | Meaning |
|---|---|
| `PORT` | Listen port (default `3003`) |
| `DATABASE_URL` | Postgres connection string (required) |
| `NAVIGATION_SERVICE_URL` | e.g. `http://navigation-service:8080/api/v1` (required) |
| `AGENT_SERVICE_URL` | e.g. `http://agent-service:80/api/agent` (required) |
| `FLEET_SERVICE_URL` | e.g. `http://fleet-service:3001/api/fleet` (required) |
| `MINING_SHIP_SYMBOL` | Ship symbol to fly (required) |
| `SCHEDULER_INTERVAL_MS` | Tick cadence (default `5000`) |
| `ANOMALY_WEBHOOK_URL` | Webhook URL for anomaly delivery — anomaly detection is disabled entirely if unset |
| `ANOMALY_INTERVAL_MS` | Anomaly check cadence (default `60000`) |
| `METRICS_ROLLUP_INTERVAL_MS` | Metrics rollup cadence (default `60000`) |

The asteroid field is no longer configured — the planner (below) chooses it
dynamically. Tune its scoring via the knobs API instead of env vars.

## Develop

Tests run against a real Postgres — no mocked DB layer, per the project's
testing decisions (drive the REST boundary, one seam) — with in-process stub
HTTP servers standing in for navigation/agent/fleet-service and an injectable
clock so multi-minute transits and cooldowns resolve instantly.

```bash
docker run --rm -d --name automation-service-test-db -p 5433:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=automation_test postgres:16-alpine

npm install
npm test        # jest + supertest against the REST boundary + real Postgres
npm run dev      # build + start (needs DATABASE_URL + the service URLs above)
```

Test files share one Postgres database, so `jest.config.js` pins
`maxWorkers: 1` — running files in parallel races one file's `TRUNCATE`
against another's inserts.

# Changelog

How this service got here. The [README](README.md) describes what it does
*now*, [CLAUDE.md](CLAUDE.md) describes how the code is put together, and this
file is the provenance — which `meta` issue introduced each piece, and which
decisions were later reversed.

Issues live in the [meta tracker](https://github.com/V-M-Pioneer-Trading/meta/issues).

## Each task kind writes its own opening shape too

The entry below stopped the scheduler *interpreting* per-kind column meanings,
and named `assignTarget` as the mirror half it was leaving. That half: the
scheduler wrote the opening task inline per kind — `tradeSymbol`,
`marketWaypoint`, `destinationWaypoint` and the starting phase — so the module
deciding that `tradeSymbol` is the deliverable for a contract and the extracted
good for mining was the scheduler, while the modules reading it were the FSMs.

Each kind exports a `start*Task` now, built on `idleTask`, and `assignTarget`
calls one of the three. The scheduler keeps the transaction a contract
assignment is written inside (meta#30) — the task and the contract's `assigned`
status have to land together — which is *when* to write, not *what*.

`assignTarget`'s switch also gained an exhaustiveness guard. Unlike `advance`
and `cargoAtStake` it returns `void`, so TypeScript was content to let a missing
arm fall straight through: a new task kind would have been planned, matched
nothing, saved nothing, and left the ship idle to be replanned every tick with
no event and no error. The contributor checklist had started claiming the
compiler catches this, which it did not.

What remains of meta#75 B7 is the row itself: three kinds sharing one 18-field
shape, which needs a migration and a change to the `/autopilot/ships/:s`
response.

## Each task kind says what it means by the shared columns

Three task kinds share one `ship_task` row, and they mean different things by
the same columns: `tradeSymbol` is the extracted good for mining and the
deliverable for a contract, set at different moments; `asteroidWaypoint` is
wherever the planner sent the ship, including a scout's market.

That is not what this change fixes — the row is still flat, and splitting it is
migration-shaped. What it fixes is where the *scheduler* had to know the
difference in order to decide something: whether abandoning a target would
strand cargo, worked out by enumerating contract phase names inline. A scheduler
reading FSM internals to make a decision the FSMs are the authority on.

`assignTarget` is the mirror half and is deliberately left: it writes
`tradeSymbol`, `marketWaypoint` and the opening phase per kind inline, so the
scheduler is still the *author* of the meanings the FSMs now interpret. Fixing
that means the FSM modules construct their own opening task, which is a bigger
change and closer to the row split the issue actually asks for.

Each FSM module exports its own predicate now — `miningCargoAtStake`,
`contractCargoAtStake`, `scoutCargoAtStake` — and the scheduler switches over
the three, the same shape as `advance`. Adding a task kind fails to compile
until it answers.

The scout case turns out to have been wrong rather than merely implicit. The old
conditional applied mining's rule (`tradeSymbol !== null`) to every non-contract
task, which gave the right answer for a scout only because nothing sets that
column on one. A scout row that somehow carried a `tradeSymbol` would have been
retried on the same target forever, on the strength of cargo a scout cannot
hold. It says `false` now, and a test pins it.

The three contract phases were untested individually — dropping any one of them
from the list left the suite green, while stranding whatever had been bought.
Each is pinned now, along with the phase before the purchase, where giving up is
the correct answer.

## One knob snapshot per anomaly tick

The planner has had this rule since it existed: `DecisionContext` is one fetch
of everything a decision depends on, so every arm of it scores against the same
numbers. The invariant stopped at the planner's edge. An anomaly tick made
**nine** separate `knobs.get()` round trips — eight inside the checks, all of
them concurrent, and a ninth for the dedupe window after they returned.

No single threshold was ever read twice, so the hazard is not one alarm
disagreeing with itself. It is two *different* knobs coming from either side of
an operator's edits, and the ninth read is the plainest case: a cooldown change
landing while the checks ran meant a tick that judged the fleet under one policy
and suppressed the result under another.

`AnomalyScheduler.tick` now reads `getValues()` once and passes it down.
`AnomalyChecker` takes a `KnobValues`, not a `KnobRepo` — with the `Pool` that
went in the previous change, it now holds the judgement and none of the
retrieval at all.

Pinned by counting reads rather than by racing a write, because the failure it
prevents is a race: the test asserts exactly one `getValues()` and no `get()`
per tick, and that `runChecks` actually received a complete snapshot. Its
fixture arms the autopilot with a ship and seeds enough rollups that every check
reaches its threshold read — without that, three of the eight are unreachable
and a check reading its own knob passes unnoticed.

The anomaly loop also has an error callback now. The fleet loop has always had
one; this loop did not, so a throwing tick was swallowed by `IntervalLoop`'s
default and detection stopped dead with nothing in the log. A tick that now
depends on the whole knob table is one more way to throw.

## The event log answers questions instead of handing out its table

`fleetEvents.ts` already owned which types mean task progress, a failed action
and credits arriving. `AnomalyChecker` was still issuing six queries of its own
against `event_log` and two against `metrics_rollup` — reaching past the modules
that own those tables, and restating the vocabulary on the way through.

`EventLog` now answers the questions the checks actually ask: what the balance
read at an instant, when the fleet first started recording it, what the operator
last said they wanted, what was earned in a window, how much of what the fleet
did in a window failed, which markets it is pricing against. `MetricsRepo` and
`replay.ts` still read the table directly, and both are aggregating rather than
asking; `AnomalyChecker` now issues no SQL at all. `MetricsRepo`
answers the one the profit-drop check asks — the latest rollup against its own
trailing average, which is one method because the two numbers only mean
anything together. `AnomalyChecker` has **no `Pool`**: it contains the judgement
and none of the retrieval. `fleetEvents.ts` gained the three vocabulary items
that were still written out as literals (`LIFECYCLE_EVENT_TYPES`,
`CREDITS_SNAPSHOT_TYPE`, `MARKET_SELECTION_TYPE`).

## The decision record is one type, and replay applies the planner's own rule

A planner decision is logged in one of two layouts — flat when mining or
nothing won, nested under `miningDetail` when a contract or scout did, because a
flat `chosen` there would name an asteroid field the ship was never sent to.
Both were declared independently in `planner.ts` and `replay.ts`, with a note in
`CLAUDE.md` asking future readers not to add a third. `plannerDecision.ts` owns
the type, both layouts, and the writer/reader pair; the layouts stay, because
normalising them would strand the archive replay exists to read.

The drift that was already there: replay spelled out the reserve-floor half of
the planner's assignability rule and not the `score > 0` half. So a replay of
`mine.taskWeight=0` — the knob's documented off switch — reported a chosen
field for every decision the planner had logged as `planner_no_viable_target`.
Both now call `isViableCandidate`, and replay calls `breachesReserveFloor`
rather than re-deriving it. Replay is what the knob-tuning workflow rests on;
a confident wrong answer there is worse than no answer.

## Upstream failures are classified, and the retry limit means what it says

`mine.failureRetryLimit` answers one question — "is this target not working
out?" — but every failure used to count toward it. `UpstreamCallError` carried
a status code whose only reader was an error handler no route could reach, so
an expired M2M token, st-gateway holding no SpaceTraders credential, a
fleet-service outage and the game refusing an action in this ship state were
all the same event to the scheduler: three or four ticks each, then every task
in the fleet abandoned and re-planned onto targets that were never the problem.
That is the failure mode auth-design.md decision 19 describes, and it is worst
exactly when it is least recoverable, because a re-plan needs the same upstream
that is down.

`gameClients.ts` now classifies each failure once, at the call, into an
`UpstreamFailureKind`: `unavailable`, `credentials`, `malformed` or `rejected`;
`scheduler.ts` adds `internal` for "our own code threw". Every failure still
counts — their sum is what lets the `consecutive_failures` alarm name a stuck
ship whatever is stucking it — but on *two* counters, against two budgets.
`rejected`, `malformed` and `internal` spend `mine.failureRetryLimit`,
unchanged. `unavailable` and `credentials` spend a hundred times that on
`ship_task.unrelated_failure_count`, a new column. Cargo in the hold still
outranks all five.

Two counters and not one, because one number cannot be spent against two
budgets: five ticks of an outage would leave the next genuine refusal one
strike from abandoning a target it had never once failed against — and a
recovery is precisely when refusals arrive, since the game state moved on while
the ship sat there. That is the same fleet-wide storm, one tick later.

300 ticks is at least 25 minutes and can be hours: a dropped timer fire during
an in-flight tick and the 15s call timeout both stretch it, and the retry-limit
knob goes to 20. All of them outlast a deploy, a restart or a credential
refresh, which is the whole requirement.

A failed tick also stopped stamping `ship_task.updated_at`, via a new
`recordFailure`. `ship_idle` measures from that column, so writing it on every
failure hid the longest stuck state this service can enter behind the one check
whose job is to notice it. That masking lasted three ticks before; with the new
budget it would have lasted the whole outage.

Not "retry forever", because an upstream can be permanently broken in a way
that looks transient — navigation-service serves a deterministic 500 for a
corrupt cached market until an operator clears it, and a scout has no cargo at
stake to justify sitting on it for the rest of the run.

Not a *shorter* fuse for `malformed` either, tempting as it is for a request
that will fail identically forever: fleet-service and agent-service answer
`404` for any unrouted path, so a rolling deploy produces one, and it is
indistinguishable from a permanently wrong request at every layer. Zero retries
there would abandon the whole fleet on a single bad tick — the same failure
reached another way.

Two boundaries use documented upstream behaviour on top of the status, both as
bonus precision rather than as the rule. `400` means the game said no unless
the body carries `error.fields`, which only fleet-service emits (agent-service
answers plain text, navigation-service RFC 9457). `503` means a missing
credential only when the message says so — the sole difference between
st-gateway's two 503s, and a signal that does not survive navigation-service,
which collapses every upstream 5xx into its own `502`. Both gaps cost a
`failureKind` label, never safety.

Two existing tests simulated a bad target with a `500`, which the taxonomy
exposed as testing something else: they proved "reassignment happens" from an
outage that now correctly doesn't cause one. Both use a `400` game refusal now.

## The test suite stops racing a wall clock

Both loops now expose a way to force exactly one tick, and tests use it instead
of running a 15ms interval and polling to see what happened. `IntervalLoop`
already had `runOnce()`; the anomaly loop already exposed it as
`forceAnomalyTick`. The fleet loop — mining, contracts, scouting, replan,
shadow mode — did not, which is why its flakes kept coming back while the
anomaly loop's were fixed properly.

Every flake this suite has had came from that gap: `669b101` (poll and tick
periods aliasing, so a phase lasting one tick was invisible and `contract.test`
passed about 30% of the time), `649d266` (`credits_flat` racing a `FakeClock`
jump), and a recurrence on 2026-09-06 where two `taskFsm` assertions failed only
in full runs and passed in isolation — indistinguishable from a real breakage
without re-running.

Also fixed here: `runOnce()` was a silent no-op on a stopped loop, so a test
that stopped the schedulers and then forced a tick passed without ticking. It
throws now. That is the exact failure the method exists to prevent.

Two sleeps turned out to be hiding vacuous assertions — "no dispatch while
paused" and "no re-dispatch on resume" both slept and then asserted that nothing
had happened, on a loop that no longer ticked at all. They force ticks now, so
they assert what they claim to.

Ten sleeps turned out to be hiding vacuous assertions of that kind, found by
auditing every sleep that sat inside a *passing* test rather than only fixing
the ones that failed. Each now forces ticks; the metrics resume assertion, for
instance, fails under a mutation of the resume guard where before it could not.

`FakeClock` had ten copies (nine identical, one missing `advance`) and
`GameClients` had one good in-test fake; both are now single shared adapters
under `testSupport/`. `MetricsScheduler` gained the `forceTick` the other two
loops had. Suite time went from ~56s to ~35s, and three consecutive runs are
clean.

## Anomaly detection no longer needs somewhere to page

Detection was gated on `ANOMALY_WEBHOOK_URL`: no URL meant no `AnomalyScheduler`,
so no checks ran and `GET /anomalies/digest` was never registered. That coupled
*noticing* a problem to *having somewhere to send it*.

Production had been in exactly that state. ai-service is not deployed, so the
variable was never set, so the entire subsystem was off — no checks, no digest,
and no context source for the AI supervisor. It was invisible because a missing
route reaches the browser as the dashboard HTML (CloudFront maps origin 404s to
`index.html`), so it looked like a working page rather than a 404.

Detection and delivery are now independent. With no URL configured the checks
run, anomalies are recorded, and the digest serves them; only the page is
skipped. An operator reading the digest is a perfectly good audience on its own.

A missing webhook is deliberately **not** counted as a failed delivery. Doing so
would spend the anomaly's `MAX_DELIVERY_ROUNDS` budget against a webhook nobody
asked, so anything recorded before a URL was configured would already be past
its ceiling and would never be sent once one appeared.

## The digest was dropping what it existed to show

Five event types were written to the log and then filtered out of
`/anomalies/digest` — the surface an operator reviews hourly and the AI
supervisor reads for context. The record existed; the page never showed it.

`contract_discovery_error` is the one with a scar: decision 19's outage took
the entire autonomous loop down, and it was found by grepping the raw event log
for exactly this type, because the digest filtered it. `observation_write_error`
is the subtler one — calibration stops recording, and the planner goes on
scoring against the last values it measured, confident and drifting.

Also added: `dispatch_standby` (another replica holds the lock, logged once per
spell), `knob_changed`, and `knob_clamped` — the last of which the audit had
introduced specifically so a deploy silently pulling a tuned value back inside
new bounds would stop being invisible, which left that fix half-finished.

The inclusion rule is now written down: not "is this an error", but "would
someone be wrong about the fleet without it, and does nothing else say it?"
The digest is bounded and read by a human, so routine per-tick chatter staying
out is half the point, and there is now a test for each half.

## Two alarms that read the event log in mining's terms

Both were the same root cause: the event vocabulary was written out separately
in `anomaly.ts` and `metrics.ts`, so each consumer decided for itself what
counted. `fleetEvents.ts` now owns those answers.

- **The error-rate alarm fired at 100% on a healthy contract fleet.** Its
  denominator counted `mining_%` events; its numerator counted
  `mining_tick_error` and `mining_task_failed`, which the scheduler logs for
  *every* task kind. A window containing only contract work therefore scored
  one failure against a denominator of one: rate 1.0, threshold 0.1. That the
  name is historical was already documented two lines below the table
  describing the split — nobody had connected the two. `mine.taskWeight = 0`
  is supported, so this needed nothing exotic to reach.
- **The no-earnings alarm ignored contract income.** It proved earnings with
  `mining_sell` alone. Contracts pay an advance on accept and the balance on
  fulfil, and neither is a sell, so a fleet earning well on contracts paged
  `earnings_stalled` every dedupe window forever. This is the check added
  precisely because it cannot switch itself off, so the only escape was
  widening an `alert` knob — the move the class fence exists to prevent.
  Neither payment was recorded at all, so the fix logs `payment` on
  `contract_accepted` and `contract_fulfilled` and counts both.

The rollup carried the same two skews, which is why the metrics an operator
checked agreed with the false alarm. `credits_per_hour` now includes contract
payments, so `profit_drop` stops being blind to them too.

## The rest of the audit

The remaining findings from the architecture review, after the two alarms
below. Same theme throughout: mechanisms built correctly, then not wired to
the thing they protect.

- **The knob-class fence was a read filter.** The supervisor was *shown* only
  policy knobs and trusted not to name any other; nothing rejected a write, so
  it could have resolved "the error alarm fired" by making the error alarm
  unable to fire. The write path now checks class inside the same row lock as
  the write. An operator with `fleet:control` may write any class; a machine
  caller may write `policy` only, and gets `403` otherwise.
- **Ship dispatch had no cross-process lock.** The re-entrancy guard was an
  in-memory boolean covering one process overlapping itself, so two replicas
  would each drive the same ship and each dispatch its own purchase, against a
  reserve-floor check that had accounted for one. Dispatch now takes a
  Postgres advisory lock; a second instance logs `dispatch_standby` and waits.
  Session-level, so a process that dies releases it rather than wedging the
  fleet.
- **A single cycle set a field's revenue estimate outright.** Recency decay
  cannot prevent that — an average over one sample is that sample — so one
  lucky trip could send the fleet to a distant field, where the only cycles
  able to correct the error were the ones the error caused. Estimates are now
  shrunk toward the fleet average by two pseudo-observations.
- **The observation cap erased rarely-mined fields.** Capped fleet-wide, a
  quiet field's own cycles fell out of the window on a busy fleet, so it
  reverted to the (higher) fleet average and became attractive again — the
  fleet re-learned the same disappointment on a loop. The cap is now per field.
- **Mining's overhead was billed to scouting and contracts.** It is calibrated
  as the residual of mining cycles, so it includes survey, extraction and
  cooldown that a market visit never performs; charging it inflated a
  ten-minute pricing trip toward half an hour and biased every comparison
  toward mining. Both now use `cycle.transactOverheadHoursPrior`.
- **Contract scores were frozen under a model that had moved.** Cycle time is
  re-derived from the stored route under the current calibration, so a
  contract evaluated on a cold fleet is no longer compared against mining
  scores that have since doubled. Expected profit stays frozen, since it
  depends on prices the decision has not re-read.
- **A failed anomaly delivery was never retried.** The record was safely in
  Postgres, which is what made the loss invisible; dedupe then ensured no
  later firing would replace the missed page. Later ticks now retry the oldest
  undelivered anomalies, up to a bounded total, then give up.
- **Redeploys clamped tuned values silently.** Every API-driven change writes
  an event; a boot that moved an operator's value wrote nothing, so the audit
  trail and the running configuration disagreed with nothing marking where.
  `syncKnobDefinitions` now reports what it changed and the entrypoint logs
  `knob_clamped`.
- **Replan re-ran contract discovery once per idle ship.** What is on offer
  belongs to the agent, not to whichever ship is idle, so N idle ships paid
  for N identical passes inside one tick while the tick guard held everything
  else. Discovery now runs once per tick.

## Two alarms that switched themselves off

Both from an architecture review of the autopilot's safety machinery.

- **A dead fleet stopped alarming after about six hours.** `ship_idle` and the
  credit snapshots both require armed-and-live, so a fleet left *paused* was
  watched by nothing at all; and `profit_drop` compares the fleet only against
  its own trailing average, so once that average decayed to zero there was
  nothing left to fall below. Every check went quiet exactly when an outage
  stopped being transient. `earnings_stalled` gains a third reason,
  `no_earnings`: nothing sold at all across `anomaly.noEarningsMinutes` while
  the autopilot is armed or paused. It measures against zero rather than
  against history, and treats paused as "meant to be working", so neither
  escape hatch applies to it.
- **The cash floor shipped switched off.** `credit.reserveFloor` defaulted to
  `0`, where the check reduces to "would this take the balance negative" and
  reserves nothing — so the guard against the unrecoverable
  out-of-fuel-money spiral was nominally on and functionally absent on every
  fresh deployment. It now defaults to 5000, roughly ten round trips' fuel at
  the prior rate. `0` still disables it, but now as a deliberate write.
  Existing deployments keep whatever value they hold: a stored `0` is
  indistinguishable from one an operator chose, so it is not overwritten.

## Structure pass: shared FSM, one interval loop, one freshness store

A refactor of how the pieces fit, with the bugs it turned up fixed along the
way. No new knobs; the API is unchanged.

- **Re-arming after an abort never ticked again.** `stop()` set a flag that
  `start()` never cleared, so the documented recovery path (abort, re-arm)
  silently left the ship idle until the process restarted. Every scheduler now
  runs on one `IntervalLoop` (`intervalLoop.ts`) that owns the one-tick-at-a-
  time guard, the draining stop, and a restartable start — the same ~40 lines
  three classes used to carry separately.
- **`ship_idle` paged on every long flight.** It measured time since the task
  row last changed, and a row doesn't change during a 30-minute transit. Time
  inside a wait the ship was told to sit through no longer counts.
- **`mine.taskWeight = 0` demoted mining instead of disabling it.** A zero
  score still beat "nothing else on offer". Anything scoring at or below zero
  is now not a candidate, which also keeps a contract that can only lose money
  from being flown.
- **Contract and scout tasks never refuelled.** Only the mining sell leg did,
  so a ship handed back after a delivery to a non-market waypoint could be too
  dry to reach anything, and idle there forever on `planner_no_viable_target`.
  Every task now tops up at every marketplace it docks at.
- **Two ideas of "market freshness" that disagreed.** The planner scouted
  against `market_intel` (written only by scouts); `market_stale` read the sell
  leg's from-afar cache comparisons, which don't refresh anything. A miner
  that had just sold at a market could be sent straight back to scout it. One
  store now: `market_intel` is written whenever a docked ship reads a market,
  and both the planner and the alert read it.
- **Fuel cost is measured from the purchase itself** — units bought against
  credits paid — instead of dividing the price by the distance flown that
  cycle, which assumed the cycle began on a full tank.
- **Contract purchases counted unrelated cargo as contract goods**, buying too
  little and believing too much was owed. Only the contract's own good counts.
- **Contract evaluation loaded the world once per contract** (waypoints,
  credits, calibration, every market). Discovery now loads one context and
  reads each market once, and evaluation is pure arithmetic over it.
- **Knob names are typed.** `KNOB_DEFINITIONS` is the source of `KnobName`;
  a misspelled knob is a compile error rather than a `NaN` score.
- **Malformed numeric env vars** (`SCHEDULER_INTERVAL_MS=5s`) refuse to start
  instead of becoming a `NaN` interval that fires every millisecond.
- The three task FSMs share `taskFsm.ts` (travel, dock, refuel, wait
  resolution) and derive their targets from the task instead of being handed
  them; `contractScheduler.ts` is `contractDiscovery.ts`, since it was never a
  scheduler; `MiningScheduler` is `FleetScheduler`; `createApp` takes an
  options object; `withTransaction` and `syncKnobDefinitions` moved out of
  `db.ts` so knobs and db no longer import each other.

## Measured value model, knob classes, replay

Replaced the planner's hand-typed constants with values measured from the
fleet's own flight history, and split knobs into `model` / `policy` / `alert`.

- **The planner was a distance sort.** Mining revenue was one flat knob
  (`mine.expectedCreditsPerCycle`, 5000) shared by every asteroid field, and so
  were ship speed, cycle overhead and fuel cost. With every term but distance
  constant across candidates, `(revenue × weight) / (2d/speed + overhead)` is
  strictly decreasing in `d` — the scoring machinery could only ever pick the
  nearest reachable field. Revenue is now measured per field from completed
  cycles (`mining_observation`), speed and fuel from real flights and refuels
  (`travel_observation`), and overhead as the residual that travel doesn't
  explain. The old constants survive as `*Prior` knobs used only until there's
  data.
- **Mining and contracts weren't comparable.** Contracts scored on real payment
  and real market prices; mining scored on the 5000 constant. The single knob
  nobody could calibrate decided every mining-vs-contract trade-off.
- **Knobs gained classes.** `model` values describe the universe and are now
  calibrated, `policy` values are preferences, `alert` values are the
  thresholds that decide when something is wrong. The AI supervisor's tool
  surface is restricted to `policy`, which closes a real hole: previously it
  could resolve an `error_rate` anomaly by setting
  `anomaly.errorRateThreshold` to its in-bounds maximum of `1`, permanently
  silencing the check instead of addressing what tripped it.
- **Degenerate knobs collapsed.** `scout.taskWeight` and
  `scout.valuePerRefresh` only ever appeared as a product; they are now the
  single `scout.creditsPerRefresh`. `mine.taskWeight` and
  `mine.creditsPerCyclePrior` stopped being degenerate on their own, since
  per-field revenue now varies between candidates while the weight doesn't.
- **Scouting was priced instead of disabled.** `scout.valuePerRefresh`
  defaulted to `0`, so ~150 lines of FSM, three knobs and a table never ran in
  the default configuration. `scout.creditsPerRefresh` now defaults to `500`.
- **`profit_drop` and `credits_flat` merged into `earnings_stalled`.** Two
  checks measuring one thing, which meant two pages for one problem. Both
  conditions remain separately tunable and are reported in `detail.reasons`.
- **Added `npm run replay`.** The docs had claimed decisions were replayable
  since the planner landed; the log's shape supported it but no tool existed.
  Scoring moved into pure functions (`src/scoring.ts`) so past decisions can be
  re-scored under different knobs with no network access.
- **Added `GET /planner/model`**, showing the calibrated values and whether each
  was measured or assumed.
- **Fixed multi-leg fuel range.** `fuelAwareRoute` applied the ship's *current*
  fuel to every leg, understating range after a refuelling stop. It now takes
  initial fuel and tank capacity separately.
- **Fixed the duplicate waypoint fetch.** `getSystemWaypoints` was called twice
  per assignment; a decision now loads its context once.
- **Test isolation.** Files truncated different subsets of tables and only some
  reset knobs, so outcomes could depend on file order. All now share
  `resetDatabase`.

## Shadow mode ([meta#21](https://github.com/V-M-Pioneer-Trading/meta/issues/21))

Arming with `mode: "shadow"` runs the full scoring cycle and logs every
would-be decision without writing task state or dispatching any ship action.
Switching modes requires an explicit re-arm.

## AI supervisor integration ([meta#19](https://github.com/V-M-Pioneer-Trading/meta/issues/19))

`POST /events` for an external supervisor to append its own rationale, with
`type` restricted to the `ai_` namespace so it can log decisions but never
spoof a lifecycle or planner event.

## Anomaly detection ([meta#15](https://github.com/V-M-Pioneer-Trading/meta/issues/15))

Six deterministic health checks on a fixed interval, every threshold a bounded
knob. Anomalies persist before webhook delivery is attempted, with retries and
dedupe. (Now five — see the merge above.)

## Metrics rollups ([meta#14](https://github.com/V-M-Pioneer-Trading/meta/issues/14))

One rollup per tick covering the window since the last, resuming from the last
persisted `window_end` after a restart. Plus `GET /metrics/context`, bounded to
fit an AI context window.

## Fleet replan ([meta#13](https://github.com/V-M-Pioneer-Trading/meta/issues/13))

Re-scores every idle ship when a knob changes, an anomaly fires, an operator
asks, or a periodic fallback comes due — all sharing one debounce clock.
Running work is never preempted.

## Market scouting ([meta#12](https://github.com/V-M-Pioneer-Trading/meta/issues/12))

Refreshing a market's prices became a first-class task competing in the same
credits/hour units, with `market_intel` tracking freshness and value growing
linearly with staleness.

## Contract loop ([meta#11](https://github.com/V-M-Pioneer-Trading/meta/issues/11))

A second FSM sharing the mining FSM's travel helpers and its
one-action-per-tick discipline. Contract discovery and evaluation run inline
before every assignment decision — an earlier draft ran them in a background
scheduler, which raced the planner and let a freshly discovered, higher-scoring
contract lose to mining purely for being mid-evaluation.

## Planner ([meta#10](https://github.com/V-M-Pioneer-Trading/meta/issues/10))

Replaced the configured asteroid field with scoring across every field in the
system, plus the knob table and fuel-aware routing. The original design called
for BFS; it shipped as Dijkstra because legs have real distances.

## Mining loop ([meta#9](https://github.com/V-M-Pioneer-Trading/meta/issues/9))

The tracer bullet: one configured ship, one configured field, travel → survey →
extract → travel → sell → refuel, persisted per phase so a restart resumes.
Later extended for multi-good cargo
([meta#36](https://github.com/V-M-Pioneer-Trading/meta/issues/36)) — a survey
can yield several goods, so `SELL` re-shops for a market that buys whatever the
current one won't.

## Autopilot lifecycle ([meta#8](https://github.com/V-M-Pioneer-Trading/meta/issues/8))

Arm / pause / abort, the in-memory token, and the append-only event log.

Also: transactional contract assignment
([meta#30](https://github.com/V-M-Pioneer-Trading/meta/issues/30)), the
cargo-at-stake rule for contract failures
([meta#27](https://github.com/V-M-Pioneer-Trading/meta/issues/27)), the knob
editor UI ([meta#18](https://github.com/V-M-Pioneer-Trading/meta/issues/18)),
and the MCP server's read surface
([meta#20](https://github.com/V-M-Pioneer-Trading/meta/issues/20)).

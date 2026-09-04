# Changelog

How this service got here. The [README](README.md) describes what it does
*now*, [CLAUDE.md](CLAUDE.md) describes how the code is put together, and this
file is the provenance — which `meta` issue introduced each piece, and which
decisions were later reversed.

Issues live in the [meta tracker](https://github.com/V-M-Pioneer-Trading/meta/issues).

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

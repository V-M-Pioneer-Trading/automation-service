# automation-service

The autopilot. Decides what each ship should do next, drives it there, watches
for trouble, and records everything it did and why.

This service never calls SpaceTraders directly — every read and every ship
action goes through navigation-service, agent-service, and fleet-service.

**New here?** Read [How it decides](#how-it-decides) first. It's the part that
matters, and it's shorter than it looks.

- [How it decides](#how-it-decides)
- [What the fleet has learned](#what-the-fleet-has-learned)
- [Knobs](#knobs)
- [The work loops](#the-work-loops)
- [Replan](#replan)
- [Shadow mode](#shadow-mode)
- [Watching for trouble](#watching-for-trouble)
- [Replaying decisions](#replaying-decisions)
- [API](#api)
- [Configuration](#configuration)
- [Developing](#developing)
- [Known limitations](#known-limitations)

---

## How it decides

Three kinds of work compete for every ship: **mine** an asteroid field, **run**
a contract, **scout** a market to refresh its prices. They're compared in one
currency — **expected credits per hour** — and the highest number wins.

```
mining     score = (credits this field earns per cycle × mine weight) / cycle hours
contract   score = (expected profit × contract weight) / cycle hours
scouting   score = (credits per refresh × how stale the market is) / cycle hours

cycle hours = distance / ship speed + fixed overhead
```

That's the whole model. It lives in [`src/scoring.ts`](src/scoring.ts) as pure
functions with no I/O, which is what lets it be unit-tested directly and
re-run over history (see [Replaying decisions](#replaying-decisions)).

Two rules apply before any of it matters:

- **Cash floor.** Work whose estimated cost would drop credits below
  `credit.reserveFloor` is removed from consideration, not scored against. If
  everything reachable would breach it, the ship deliberately idles. Running out
  of money for fuel is not recoverable in SpaceTraders.
- **Reachability.** A target the ship can't route to isn't a candidate. Routing
  is fuel-aware: a leg longer than the tank is impossible, and an intermediate
  stop must have a fuel station. See [`src/routeCost.ts`](src/routeCost.ts) —
  and note the honest caveat there, that since every waypoint is directly
  reachable from every other, this search is mostly answering *"can we get
  there"* rather than *"what's the shortest way"*.

### A worked example

A ship sits at a market. Two asteroid fields are in range:

| | distance (one way) | round trip | credits/cycle | cycle hours | score |
|---|---|---|---|---|---|
| `BELT-NEAR` | 10 | 20 | 4,200 (measured here) | 20/30 + 0.3 = **0.97** | **4,340 cr/h** |
| `BELT-FAR` | 90 | 180 | 11,800 (measured here) | 180/30 + 0.3 = **6.3** | **1,873 cr/h** |

`BELT-NEAR` wins, despite being worth less than a third as much per trip,
because it turns around six times faster. Now suppose a few more cycles at
`BELT-FAR` come back richer still — say 60,000 — and its score becomes 9,524
cr/h. The planner switches, on its own, with no knob touched.

**That switch is only possible because `credits/cycle` differs per field.** If
it were one fleet-wide constant, it would cancel out of every comparison and
scoring would collapse into "always pick the nearest field". Which brings us to
the next section.

---

## What the fleet has learned

The scoring model needs four facts about the universe: what a mining cycle
earns, how fast ships fly, how long the non-flying part of a cycle takes, and
what fuel costs.

These used to be hand-typed constants. They're now **measured from the fleet's
own history** ([`src/observations.ts`](src/observations.ts)):

| Fact | Measured from |
|---|---|
| Credits per mining cycle, **per field** | Every completed cycle: what it sold, at which field |
| Ship speed | Real flights — the game reports both endpoints' coordinates and both timestamps |
| Fixed cycle overhead | Measured cycle time minus the travel that cycle's distance accounts for |
| Fuel credits per unit distance | Real refuel purchases, against the distance they paid for |

Older observations count for less, on a half-life set by
`observation.halfLifeHours` — so a field that has got better recently outweighs
how it behaved yesterday, without one lucky trip swinging the estimate.

**Before there's data**, each falls back to its `*Prior` knob, and the planner
behaves exactly as it did before any of this existed. There's no cold-start
cliff; a brand new fleet just prefers whatever is closest until it knows better.

Every planner decision logs which numbers it used **and whether each was
measured or assumed**, so a surprising choice can be explained rather than
guessed at. `GET /planner/model` shows the current state of that:

```json
{
  "model": {
    "creditsPerCycleByWaypoint": { "X1-AB12-BELT": 4213.4 },
    "fleetCreditsPerCycle": 4213.4,
    "speedUnitsPerHour": 27.6,
    "overheadHours": 0.42,
    "fuelCreditsPerUnitDistance": 4.1,
    "provenance": {
      "creditsPerCycle": "measured", "speed": "measured",
      "overhead": "measured", "fuel": "prior",
      "miningSampleCount": 14, "flightSampleCount": 28, "refuelSampleCount": 0,
      "waypointsWithOwnAverage": ["X1-AB12-BELT"]
    }
  }
}
```

---

## Knobs

Every tunable number, with bounds, stored in Postgres and editable through the
API. Knobs come in three classes, and **the class is the point**:

| Class | What it is | Who may write it |
|---|---|---|
| **model** | A claim about how the universe behaves. Calibrated from observation; the stored value is only a cold-start prior. | Operator (to test a hypothesis). **Not the AI.** |
| **policy** | A preference with no measurable true value. | Operator **and the AI supervisor**. |
| **alert** | The threshold that decides when something is wrong. | Operator only. **Not the AI.** |

Model knobs are fenced off because editing one doesn't change reality — it
changes what the planner *believes* about reality, which is how you get a fleet
confidently flying to the wrong asteroid. Alert knobs are fenced off for a
sharper reason: an agent that can widen its own alarm thresholds will
eventually resolve "profit dropped" by deciding profit drops are fine.
`GET /planner/knobs?class=policy` is what the supervisor reads, and the filter
is applied server-side so the restriction holds even if a client forgets it.

### model

| Knob | Default | Meaning |
|---|---|---|
| `mine.creditsPerCyclePrior` | `5000` | Assumed revenue per mining cycle, until real cycles replace it. |
| `travel.speedUnitsPerHourPrior` | `30` | Assumed ship speed, until real flights are timed. |
| `cycle.overheadHoursPrior` | `0.3` | Assumed survey+extract+cooldown+sell time, until real cycles replace it. |
| `fuel.creditsPerUnitDistancePrior` | `5` | Assumed fuel cost per unit distance, until real refuels replace it. |
| `observation.halfLifeHours` | `6` | How fast old observations stop counting. Lower adapts faster but is noisier. |

### policy

| Knob | Default | Meaning |
|---|---|---|
| `mine.taskWeight` | `1` | How much to favour mining. `0` disables it. |
| `contract.taskWeight` | `1` | How much to favour contracts, same units. `0` disables them. |
| `contract.minProfitThreshold` | `0` | Minimum expected profit to accept a contract. Raise to be pickier. |
| `scout.creditsPerRefresh` | `500` | What refreshing one market's prices is worth. `0` disables scouting. |
| `scout.stalenessThresholdHours` | `0.5` | Staleness at which a refresh is worth its full value. |
| `credit.reserveFloor` | `0` | Cash floor the planner will never spend past. |
| `mine.failureRetryLimit` | `3` | Consecutive failures on a target before giving up on it. |
| `replan.debounceSeconds` | `30` | Minimum gap between replans; bursts coalesce into one. |

### alert

| Knob | Default | Meaning |
|---|---|---|
| `anomaly.shipIdleMinutes` | `10` | Minutes without a phase change before a ship is flagged idle. |
| `anomaly.profitDropFraction` | `0.5` | Earnings stalled if the latest rate falls below this fraction of the 6h average. |
| `anomaly.creditsFlatWindowHours` | `2` | Earnings also stalled if credits show no net increase across this window. |
| `anomaly.consecutiveFailureLimit` | `3` | Consecutive failures on one ship that raise an anomaly. |
| `anomaly.errorRateThreshold` | `0.1` | Error fraction of recent mining events that flags the fleet as failing. |
| `anomaly.errorRateWindowMinutes` | `5` | Window that fraction is computed over. |
| `anomaly.marketStalenessMinutes` | `30` | Minutes before an in-use market's prices are flagged stale. |
| `anomaly.dedupeCooldownMinutes` | `15` | How long a fired anomaly stays suppressed. |

**Scouting is priced, not switched.** `scout.creditsPerRefresh` is both the
value of a refresh and scouting's only weight — a separate weight would just
multiply against it, which is one knob pretending to be two. It can't be
measured the way mining revenue can: the cost of stale prices is the bad trades
you never see. So it's an honest policy judgment, defaulting to roughly a tenth
of a typical cycle's revenue.

**Redeploys**: bounds, defaults and classes come from
[`KNOB_DEFINITIONS`](src/knobs.ts) and are re-synced on every boot; an
operator's tuned *value* survives. A knob removed from the definitions is
deleted, so no orphan lever outlives the code that read it. A tuned value that
no longer fits tightened bounds is clamped, never left in a state the write path
would reject.

---

## The work loops

Each ship runs one task at a time as a resumable state machine. Per-ship
progress persists to Postgres after every phase change, so a restart plus
re-arm resumes from the last completed phase.

Every tick performs **at most one atomic action** — dispatch one command,
resolve one elapsed wait, or get one planner assignment. Never two. That
granularity is a safety property, not an optimisation: it's what lets *pause*
take effect cleanly between actions instead of killing something mid-flight.

### Mining

```
TRAVEL_TO_ASTEROID → SURVEY → EXTRACT → TRAVEL_TO_MARKET → SELL → (refuel) → done
```

The sell leg queries every in-system marketplace and picks the best price for
what's in the hold. A survey can yield several goods before cargo fills, so
`SELL` sells whatever the current market buys and then re-shops for a market
that takes the rest, repeating until the hold is empty. Each extra stop costs a
real trip.

On completion the ship hands itself back to the planner, and the cycle's
takings become one `mining_observation` row — which is how the next decision
gets smarter.

### Contracts

```
CONTRACT_TRAVEL_TO_MARKET → CONTRACT_PURCHASE → CONTRACT_TRAVEL_TO_DESTINATION
  → CONTRACT_DELIVER → CONTRACT_FULFILL
```

Right before every assignment decision, any contract not yet seen is discovered
and evaluated: cheapest in-system market selling the deliverable, fuel-aware
route through it to the destination, `profit = payment − procurement − travel`.
Anything clearing `contract.minProfitThreshold` is accepted on the spot.

This runs **inline, not as a background job**. An earlier version used a
background scheduler and it raced the planner — a freshly discovered,
higher-scoring contract could lose to mining purely for being mid-evaluation.
A discovery failure is logged and ignored rather than blocking mining;
contracts are additive, never a dependency.

### Scouting

```
SCOUT_TRAVEL → SCOUT_REFRESH
```

Market prices age, and a planner deciding on stale prices decides blind.
Scouting scores "go refresh that market" against real work. A market's value
grows linearly with staleness and drops to zero the moment it's refreshed, so
the planner rotates through markets on its own — no cooldown or round-robin
needed. A market never seen is treated as ten thresholds stale: high priority,
but finite.

### When a target keeps failing

After `mine.failureRetryLimit` consecutive failures the ship is reset for a
fresh assignment — **unless it's holding cargo it hasn't disposed of**, in which
case it keeps retrying rather than stranding it. An abandoned contract is
released back to the pool rather than left claimed by a ship that gave up.

---

## Replan

Assignment normally happens ship-by-ship as ships free up. A **replan**
re-scores every *idle* ship when something changes that could change the answer:
any knob write, any new anomaly, a manual request, or a periodic fallback
(`REPLAN_INTERVAL_MS`, default 5 minutes).

All triggers share one debounce clock, so a storm of knob changes coalesces into
a single replan.

**Running work is never preempted.** A replan only touches ships with no
assigned target. Tasks are kept short and bounded — one mining round trip, one
delivery leg — so a stale assignment costs minutes at most. Abort is the only
interrupt.

---

## Shadow mode

Arming with `mode: "shadow"` runs the full scoring cycle on the live schedule
and logs every would-be decision as `planner_shadow_assignment` — but never
writes task state and never dispatches a ship action. Nothing is ever assigned,
so the same cycle recomputes every tick: a continuous preview of what live mode
would do.

Switching between shadow and live always requires an explicit re-arm, so nobody
drifts from dry run into live dispatch by accident.

---

## Watching for trouble

Five checks run on a fixed interval, independent of whether the autopilot is
armed — a broken ship stays worth reporting while an operator investigates.

| Check | Fires when |
|---|---|
| `ship_idle` | A ship's task hasn't changed phase in N minutes (while armed and live) |
| `earnings_stalled` | The money stopped: the hourly rate collapsed against its own history, **or** credits show no net increase across a window |
| `consecutive_failures` | One ship accumulates N consecutive failures |
| `error_rate` | The error fraction of recent mining events exceeds a threshold |
| `market_stale` | A market in active use hasn't been repriced in N minutes |

`earnings_stalled` covers what used to be two separate checks (`profit_drop`
and `credits_flat`). They're two ways of measuring one thing — a fleet that
stops earning trips both — so paging twice made the digest look busier than the
fleet was. Both conditions stay separately tunable and are reported in
`detail.reasons`.

Each anomaly is **persisted before** delivery is attempted, then POSTed to
`ANOMALY_WEBHOOK_URL` with up to three retries and exponential backoff. Repeat
firings of the same condition are suppressed for `anomaly.dedupeCooldownMinutes`
rather than paging every tick a problem stays open.

---

## Replaying decisions

Every planner decision logs the inputs it used — each candidate's distance, the
calibrated model, every knob value. Since scoring is pure arithmetic over
exactly those inputs, past decisions can be re-scored under different knobs
without touching the game:

```bash
npm run replay -- --set mine.taskWeight=2
```

```bash
npm run replay -- --since 6h --set credit.reserveFloor=50000 --verbose
```

It reports how many past decisions would have gone differently. **Zero flips
means the change does nothing** — worth knowing before you attribute a later
swing in profit to it.

Flags: `--set name=value` (repeatable, validated against the knob's real
bounds), `--since 90m|2h|7d` (default 24h), `--limit` (default 200),
`--verbose` to show every candidate's score rather than only the flips.

It replays the **choice between asteroid fields**, which is where the
field-vs-field trade-off lives. It doesn't re-derive whether a contract or scout
would have beaten mining outright — those scores were frozen from market state
at the time and can't be honestly recomputed from the log.

---

## API

All routes are under `/api/automation/v1`. `/health` is unversioned.

**Autopilot**

| | |
|---|---|
| `POST /autopilot/arm` | `{ token, mode? }` — `mode` is `"live"` (default) or `"shadow"`. Holds the token **in memory only**; a restart always disarms. Valid from any status. |
| `POST /autopilot/pause` | Lets an already-dispatched wait finish and be recorded, then stops dispatching. Armed only. |
| `POST /autopilot/abort` | Clears the token and stops immediately. An action already in flight can't be un-sent, so its result is discarded and marked, not silently applied. |
| `GET /autopilot/status` | Current status and mode (`mode` is `null` whenever no token is held). |
| `GET /autopilot/ships/:shipSymbol` | One ship's phase, wait state, and cycle progress. |
| `GET /autopilot/events?limit=` | The event log, newest first. |

**Planner**

| | |
|---|---|
| `GET /planner/knobs?class=` | Every knob, or one class. |
| `PUT /planner/knobs/:name` | `{ value }`. `404` unknown, `400` out of bounds. Logs `knob_changed` and triggers a replan. |
| `GET /planner/model` | What the planner currently believes, and whether each belief is measured or assumed. |
| `POST /planner/replan` | Requests a replan, subject to the debounce. |

**Observability**

| | |
|---|---|
| `GET /metrics/context?rollupLimit=&eventLimit=` | Rollups plus recent events in one bounded response, shaped to fit an AI context window. |
| `GET /anomalies/digest?windowMinutes=&anomalyLimit=&eventLimit=` | Anomalies plus notable events for a window. |
| `POST /events` | `{ type, detail }` for an external supervisor. `type` must start with `ai_`, so an external caller can log its own decisions but can never spoof a lifecycle or planner event. |

Invalid lifecycle transitions return `409` naming the current status.

### Metrics rollups

A background scheduler persists one rollup per tick, each covering the window
since the last one ended — credits/hour (sell revenue, not netted against
costs), units extracted, and error rate. On restart it resumes from the last
persisted `window_end`, so there's no gap and no double count.

---

## Configuration

| Env var | Meaning |
|---|---|
| `PORT` | Listen port (default `3003`) |
| `DATABASE_URL` | Postgres connection string (**required**) |
| `NAVIGATION_SERVICE_URL` | e.g. `http://navigation-service:8080/api/v1` (**required**) |
| `AGENT_SERVICE_URL` | e.g. `http://agent-service:80/api/agent` (**required**) |
| `FLEET_SERVICE_URL` | e.g. `http://fleet-service:3001/api/fleet` (**required**) |
| `MINING_SHIP_SYMBOL` | Ship to fly (**required**) |
| `SCHEDULER_INTERVAL_MS` | Tick cadence (default `5000`) |
| `REPLAN_INTERVAL_MS` | Periodic replan fallback (default `300000`) |
| `ANOMALY_WEBHOOK_URL` | Anomaly delivery target — anomaly detection is disabled entirely if unset |
| `ANOMALY_INTERVAL_MS` | Anomaly check cadence (default `60000`) |
| `METRICS_ROLLUP_INTERVAL_MS` | Rollup cadence (default `60000`) |
| `CORS_ALLOWED_ORIGIN` | Browser origin allowed to call this API (default `http://localhost:3000`) |
| `CLERK_JWT_KEY` | Clerk's RS256 public key, PEM/SPKI — literal `\n` escapes are accepted |
| `CLERK_JWT_KEY_FILE` | Path to that key instead of an inline value; `CLERK_JWT_KEY` wins if both are set. One of the two is **required** |
| `CLERK_ISSUER` | Expected `iss`, optional — narrows misconfiguration, not a control |
| `AI_SERVICE_SECRET` | Shared secret for `POST /events` (**required**) |

Which asteroid field to mine is **not** configured — the planner chooses it.
Tune scoring through knobs, not env vars.

## Authentication

Every `GET` is public. Every mutating route needs a verified Clerk session
carrying the **`fleet:control`** scope, except `POST /events`, which is a machine
call from ai-service and uses the `X-Service-Secret` shared secret instead —
there is no human identity behind it, and Clerk stays scoped to humans.

| | Route | Requires |
|---|---|---|
| public | `GET /autopilot/status`, `/autopilot/events`, `/autopilot/ships/:s` | — |
| public | `GET /planner/knobs`, `/planner/model`, `/metrics/context`, `/anomalies/digest` | — |
| public | `GET /health`, `/api/automation/health` | — |
| gated | `POST /autopilot/arm`, `/pause`, `/abort` | `fleet:control` |
| gated | `PUT /planner/knobs/:name`, `POST /planner/replan` | `fleet:control` |
| gated | `POST /events` | `X-Service-Secret` |

Verification is **networkless** — the service holds Clerk's public key and checks
signatures itself, so there is no JWKS fetch on the hot path and no cache to go
stale. A missing token is `401`; a valid token without the scope is `403`, since
re-authenticating would not help.

`CLERK_JWT_KEY` and `AI_SERVICE_SECRET` are **required**, with no default and no
"auth optional" mode. A service that can start without a trust anchor is a
service that can be deployed with authentication silently off.

Mutating routes stamp `detail.actor` — the Clerk user id — onto the event they
write, so the audit trail records who armed, paused, aborted or retuned. The id
only: `eventLog.ts`'s rule that nothing token-shaped enters `detail` still holds.

Tests run this exact code path. `src/testSupport/authTokens.ts` mints an
ephemeral keypair per test run and signs real tokens with it; `createTestApp`
hands the public half to `createApp`. Only the trust anchor differs — there is no
stub verifier and no bypass flag.

---

## Developing

Tests drive the real HTTP API against a real Postgres, with stub HTTP servers
standing in for the three upstream services and an injectable clock so
multi-minute transits resolve instantly. No mocked database layer.

```bash
docker run --rm -d --name automation-service-test-db -p 5433:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=automation_test postgres:16-alpine
```

```bash
npm install && npm test
```

```bash
npm run dev
```

Test files share one database, so `jest.config.js` pins `maxWorkers: 1` —
parallel files race each other's `TRUNCATE`. Every file resets through
[`resetDatabase`](src/testSupport/resetDatabase.ts); a new table needs adding
there once, not in eight `beforeEach` blocks. Files not testing scouting leave
it disabled, so a third bidder doesn't quietly change what they're asserting.

[`src/scoring.ts`](src/scoring.ts) has no I/O and is tested directly — start
there if you want to understand or change what the autopilot optimises for.

---

## Known limitations

Everything the implementation deliberately doesn't do yet, in one place.

**Scope**

- **Single ship.** The planner, replan, and `listIdle()` are all written per-ship
  and scale to N ships without further changes, but dispatch is still keyed to
  one configured `MINING_SHIP_SYMBOL`. Nothing demonstrates fleet-wide fan-out.
- **One system.** Every candidate must be in the ship's current system.
- **Contracts evaluate only their first deliverable.** Multi-good contracts
  aren't supported.
- **Contract purchase quantity** assumes the whole hold belongs to the
  contract's good. True for a ship that arrives empty (mining always sells out
  first), wrong if a ship ever carried something unrelated into a contract task.

**Model**

- **Fuel cost is usually a prior.** It's only measured when a refuel response
  reports a transaction price; otherwise `fuel.creditsPerUnitDistancePrior`
  stands. It affects the reserve-floor safety margin, not scoring order.
- **A fuel observation assumes the cycle started on a full tank**, since it
  divides the refuel price by the distance flown that cycle. True from the
  second cycle onward (every cycle ends by refuelling), but a ship's first
  cycle after arming can start part-full and will overstate the cost per unit
  distance. The error is conservative — it widens the cash safety margin — and
  decays out as later cycles are observed.
- **Routing is really a reachability check.** Every waypoint is directly
  reachable from every other and legs cost Euclidean distance, so the direct hop
  is always shortest — the search only does interesting work when the direct hop
  is out of fuel range.
- **Fuel stations are inferred** from the `MARKETPLACE` trait, without
  confirming the market actually stocks fuel.
- **The mining sell leg has no route-cost awareness.** "Best market" means best
  price in the same system, not best price net of getting there.
- **A field's revenue is measured, not predicted.** The model learns what a
  field *has* paid; it doesn't model deposit types, market depth, or the price
  impact of selling into the same market repeatedly.

**Operations**

- **Metrics rollups assume a single instance.** There's no distributed lock, so
  two live replicas would each bootstrap from the same `window_end` and
  double-count.
- **No retention policy.** `metrics_rollup`, `event_log`, and the two
  observation tables grow indefinitely. Observations are bounded at read time
  (recent rows only), so this is a disk concern, not a correctness one.
- **Anomalies deliver sequentially** within a tick, so several tripping at once
  against a slow webhook queue behind each other's retry budget.
- **`market_stale`'s "in active use" window** is a fixed 24h lookback, not a knob.
- **The credits-flat half of `earnings_stalled`** reads credit snapshots that
  are only logged while armed and live, so an anomaly-only deployment with no
  `MINING_SHIP_SYMBOL` never gets them.
- **Arm/pause/abort mutate in-memory status before persisting the event**, so a
  failed event write can briefly leave status and audit trail diverged.
- **The token lives in memory only** and is never persisted, so a restart always
  disarms. A dedicated auth-service is a known future step.

See [CHANGELOG.md](CHANGELOG.md) for how this service got here, and which
`meta` issue introduced each piece.

# automation-service

Autopilot lifecycle, mining loop, planner, and append-only event log for the
SpaceTraders fleet ([meta#8](https://github.com/V-M-Pioneer-Trading/meta/issues/8),
[meta#9](https://github.com/V-M-Pioneer-Trading/meta/issues/9),
[meta#10](https://github.com/V-M-Pioneer-Trading/meta/issues/10)).

## What it does

- **Arm**: `POST /autopilot/arm { token }` holds the SpaceTraders account
  token **in memory only** — nothing token-shaped is ever written to
  Postgres or echoed back. A restart always disarms; there is no
  auto-resume. Arming is allowed from any status (including re-arming after
  a pause or abort), and starts the mining scheduler if one is configured.
- **Pause**: `POST /autopilot/pause` — only valid while armed. The scheduler
  keeps polling so an already-dispatched wait (a transit or a cooldown) gets
  to finish and its result gets recorded, but no *new* action is dispatched
  afterward — the ship idles at whatever phase that wait resolved into.
- **Abort**: `POST /autopilot/abort` — valid while armed or paused, clears
  the held token and stops the scheduler immediately (no further dispatch,
  not even finishing an in-flight wait).
- **Status**: `GET /autopilot/status` — current lifecycle state.
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

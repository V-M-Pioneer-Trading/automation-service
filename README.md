# automation-service

Autopilot lifecycle, mining loop, and append-only event log for the SpaceTraders
fleet ([meta#8](https://github.com/V-M-Pioneer-Trading/meta/issues/8),
[meta#9](https://github.com/V-M-Pioneer-Trading/meta/issues/9)).

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
end-to-end for one ship, not fleet-wide task assignment — that's the
planner, [meta#10](https://github.com/V-M-Pioneer-Trading/meta/issues/10)):

- The ship and the asteroid field it mines are fixed by config
  (`MINING_SHIP_SYMBOL`, `MINING_ASTEROID_WAYPOINT`), not chosen
  dynamically. The planner picks targets in meta#10.
- "Best nearby market" is real (queries navigation-service for every
  in-system marketplace and picks the highest sell price for whatever was
  extracted) but has no route-cost/BFS awareness — "nearby" just means
  "in the same system." Fuel-aware routing is also meta#10.
- One ship at a time. Multi-ship dispatch is the planner's job too.
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
performs **at most one atomic action per tick** — dispatch a command, or
resolve an elapsed wait, never both. That granularity is what makes pause
take effect between actions instead of admin-killing something mid-flight.
Abort stops the scheduler's timer immediately, but an action already in
flight when abort lands can't be un-sent — its result is discarded (not
persisted, not logged as a real action; a `mining_discarded_after_abort`
event marks it) rather than silently taking effect after the operator asked
to stop.

## Configuration

| Env var | Meaning |
|---|---|
| `PORT` | Listen port (default `3003`) |
| `DATABASE_URL` | Postgres connection string (required) |
| `NAVIGATION_SERVICE_URL` | e.g. `http://navigation-service:8080/api/v1` (required) |
| `AGENT_SERVICE_URL` | e.g. `http://agent-service:80/api/agent` (required) |
| `FLEET_SERVICE_URL` | e.g. `http://fleet-service:3001/api/fleet` (required) |
| `MINING_SHIP_SYMBOL` | Ship symbol to fly (required) |
| `MINING_ASTEROID_WAYPOINT` | Asteroid field waypoint to mine (required) |
| `SCHEDULER_INTERVAL_MS` | Tick cadence (default `5000`) |

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

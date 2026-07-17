# automation-service

Autopilot lifecycle and append-only event log for the SpaceTraders fleet
([meta#8](https://github.com/V-M-Pioneer-Trading/meta/issues/8)).

This is the skeleton every autopilot slice plugs into: arm/pause/abort plus
an audit trail. No ship logic lives here yet — the mining/contract/scouting
state machines and the central planner land in later tickets on top of this.

## What it does

- **Arm**: `POST /autopilot/arm { token }` holds the SpaceTraders account
  token **in memory only** — nothing token-shaped is ever written to
  Postgres or echoed back. A restart always disarms; there is no
  auto-resume. Arming is allowed from any status (including re-arming after
  a pause or abort).
- **Pause**: `POST /autopilot/pause` — only valid while armed. In this
  skeleton there's no running task to let finish; once the ship-action FSMs
  exist (meta#9), pause still returns immediately but downstream loops are
  expected to check status and finish their current step before idling.
- **Abort**: `POST /autopilot/abort` — valid while armed or paused, clears
  the held token immediately.
- **Status**: `GET /autopilot/status` — current lifecycle state.
- **Event log**: every transition is appended to Postgres
  (`GET /autopilot/events?limit=`, newest first) and survives restarts even
  though the lifecycle state itself does not.

Invalid transitions (e.g. pausing while disarmed) return `409` naming the
current status. A DB failure on the event-log write returns `500` rather
than hanging the request — but note the in-memory status has already
transitioned by that point (arm/pause/abort mutate state, then persist the
event), so a failed write can leave status and the audit trail briefly
diverged. Acceptable for this skeleton (single-row insert, no distributed
transaction available between memory and Postgres); revisit if it proves
troublesome once real dispatch traffic exists.

## Configuration

| Env var | Meaning |
|---|---|
| `PORT` | Listen port (default `3003`) |
| `DATABASE_URL` | Postgres connection string (required) |

## Develop

Tests run against a real Postgres — no mocked DB layer, per the project's
testing decisions (drive the REST boundary, one seam).

```bash
docker run --rm -d --name automation-service-test-db -p 5433:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=automation_test postgres:16-alpine

npm install
npm test        # jest + supertest against the REST boundary + real Postgres
npm run dev      # build + start (needs DATABASE_URL)
```

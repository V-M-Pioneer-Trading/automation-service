# Repo map: automation-service

The deterministic autopilot. Scores mining, contracts and scouting in credits per hour, drives ships through resumable task FSMs, calibrates from fleet history, raises anomalies. Runs in shadow or live; a restart always resumes in shadow.

| Path | Holds |
|---|---|
| `src/server.ts` | `createApp`, routes |
| `src/config.ts` | `configFromEnv` |
| `src/scheduler.ts`, `src/intervalLoop.ts`, `src/dispatchLock.ts` | fleet tick, background loops, DB-held dispatch lock |
| `src/planner.ts`, `src/plannerDecision.ts`, `src/scoring.ts`, `src/routeCost.ts` | planning and scoring |
| `src/taskFsm.ts`, `src/miningTask.ts`, `src/contractTask.ts`, `src/scoutTask.ts` | DB-free FSMs returning `TickResult` |
| `src/autopilotLifecycle.ts`, `src/autopilotState.ts` | shadow / live, arm, restart |
| `src/knobs.ts` | knob classes (`policy`, `alert`, `model`), bounds |
| `src/anomaly.ts`, `src/anomalyScheduler.ts`, `src/webhookDelivery.ts` | anomalies; webhook in `generic` (ai-service) or `telegram` format |
| `src/eventLog.ts`, `src/fleetEvents.ts` | append-only event log; query only through `EventLog` |
| `src/db.ts`, `*Repo.ts`, `src/observations.ts` | Postgres, `migrate()` on boot |
| `src/gameClients.ts` | agent / fleet / navigation clients, failure verdicts |
| `src/replay.ts` | replay CLI (`npm run replay`) |

- Calls: agent-service, fleet-service, navigation-service (M2M bearer, 15 s timeout), auth-service (M2M token, introspection), ai-service webhook.
- Called by: command-interface, ai-service, spacetraders-mcp-server.
- Port 3003. Test DB: Postgres 16 on :5433 (`jest.env.js`); tests call `forceFleetTick` / `forceAnomalyTick`, never sleep.
- `src/__tests__/*.test.ts.bak` files are stale leftovers (gitignored `*.bak`).
- CI `container.yml`: `test` (Postgres service, lint, test), `docker` (main: SSM redeploy).

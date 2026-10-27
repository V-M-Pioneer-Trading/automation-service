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
- CI `container.yml`: `test` (Postgres service, lint, test), `docker` (main: SSM redeploy).

## How-to

- Re-arm live after an `autopilot_resumed_in_shadow` anomaly: `POST /autopilot/arm` with `{"mode":"live"}`, needs `fleet:control`. A restart never does it.
- Telegram anomaly pages: `ANOMALY_WEBHOOK_URL=https://api.telegram.org/bot<token>/sendMessage`, `ANOMALY_WEBHOOK_FORMAT=telegram`, `ANOMALY_TELEGRAM_CHAT_ID`. The URL holds the bot token (SSM only). Production setup: V-M-Pioneer-Trading/automation-service#51.

## Reference docs

- `README.md` "Configuration": read when deploying or adding an env var.
- `README.md` "Knobs": read when changing a knob (names, classes, defaults, bounds).
- `README.md` "API", "Authentication": read when touching routes or their scopes.
- `README.md` "Watching for trouble", "Replan": read when touching anomaly checks or replan triggers.
- `README.md` "Replaying decisions": read before turning a knob in production.

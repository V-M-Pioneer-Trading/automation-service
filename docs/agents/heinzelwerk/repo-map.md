# Repo map: V-M-Pioneer-Trading/automation-service
Verified against bf87ce2 2026-10-29.

## Purpose
- SpaceTraders fleet autopilot: scores mining/contracts/scouting in credits/hour, drives ONE ship (`MINING_SHIP_SYMBOL`) through resumable task loops, calibrates from observations, raises anomalies. `package.json:4`, `src/config.ts:16-19`
- No game credential here; st-gateway injects it. Own M2M bearer on every outbound call. `src/gameClients.ts:6-11,315-319`

## Layout
- Module map table (owner and dependencies per file): `CLAUDE.md` "## Module map" (CLAUDE.md:24)
- `src/server.ts`: `createApp(options)`, routes, per-route auth declaration, entrypoint boot (`:722-765`)
- `src/scheduler.ts` (fleet tick), `src/planner.ts`, `src/scoring.ts` (pure), `src/routeCost.ts` (pure), `src/contractDiscovery.ts`
- FSMs: `src/taskFsm.ts` (shared), `src/miningTask.ts`, `src/contractTask.ts`, `src/scoutTask.ts`
- State: `src/autopilotState.ts` (in-memory), `src/autopilotLifecycle.ts` (arm/pause/abort + restore), `src/dispatchLock.ts`
- Loops on `IntervalLoop` (`src/intervalLoop.ts`): `FleetScheduler` `src/scheduler.ts:144`, `AnomalyScheduler` `src/anomalyScheduler.ts:119`, `MetricsScheduler` `src/metricsScheduler.ts:18`
- Test support: `src/testSupport/` (`resetDatabase.ts`, `fakeClock.ts`, `fakeGameClients.ts`)
- CLI: `npm run replay` re-scores logged decisions, `src/replay.ts`, `package.json:9-17`

## Entry points and auth
- Express 4, `PORT` default 3003. `src/config.ts:180`
- Health mounted bare; every other route only under `/api/automation/v1`. `src/server.ts:366-367,619`
- Every route declares auth as first handler (`secured()`): reads `ignoreCredentials()`, mutations `requireScope`. `src/server.ts:250-261`
- Scopes, one literal per route: `fleet:control` `src/auth.ts:22`; `events:write` `src/auth.ts:28`; `planner:advise` `src/auth.ts:34`
- `POST /autopilot/arm` (body `mode` live|shadow, default live), `/autopilot/pause`, `/autopilot/abort`: `fleet:control`. `src/server.ts:394-421`
- `POST /events`: `events:write`, type must start `ai_`, `detail.actor` overwritten with verified sub. `src/server.ts:461-479`
- `PUT /planner/knobs/:name` (non-operator kind writes policy class only, else 403; triggers replan) `src/server.ts:520-560`; `POST /planner/replan` (only if scheduler) `src/server.ts:574-583`: `planner:advise`
- Identity only via `actorOf`/`kindOf`. `src/server.ts:403`
- Startup: M2M token fetched once; unknown caller exits 1. `src/server.ts:731-736`
- Auth decision: `CLAUDE.md` "## Inbound auth (decision 21)" (CLAUDE.md:528)

## Unauthenticated routes
- `GET /health`, `GET /api/automation/health`. `src/server.ts:366-367`
- Under `/api/automation/v1`: `GET /autopilot/status` :383, `/autopilot/events` :423, `/autopilot/ships/:shipSymbol` :433, `/planner/knobs` :486, `/planner/model` :566, `/metrics/context` :589, `/anomalies/digest` :602 (all `src/server.ts`)
- Prod boot wires mining, metrics, anomaly: all live. `src/server.ts:737-753`
- Unknown paths: JSON 404 via `notFound()`. `src/server.ts:625-629`
- Public through CloudFront `/api/automation/v1/*` and `/api/automation/health`. `C:/Users/max/work/infrastructure/projects/spacetraders/main.tf:147-148`

## Money paths
- All calls via `callJson`. `src/gameClients.ts:296`
- sell (agent-service) `src/gameClients.ts:410`, called `src/miningTask.ts:200`
- purchase (agent-service) `src/gameClients.ts:422`, called `src/contractTask.ts:95`
- refuel (fleet-service) `src/gameClients.ts:419`, called `src/taskFsm.ts:186` via `refuelIfNeeded` (mining, contract `src/contractTask.ts:80`, scout `src/scoutTask.ts:4`)
- acceptContract `src/gameClients.ts:373` called `src/contractDiscovery.ts:62`; deliverContract `src/gameClients.ts:428` called `src/contractTask.ts:121`; fulfillContract `src/gameClients.ts:379` called `src/contractTask.ts:140`; navigate (fuel) `src/gameClients.ts:396` called `src/taskFsm.ts:139`
- Fleet tick runs only when armed or paused. `src/scheduler.ts:283`
- Shadow scores and logs, never dispatches. `src/scheduler.ts:302-305`
- Paused starts nothing new. `src/scheduler.ts:324`
- Guard: knob `credit.reserveFloor` `src/knobs.ts:166`, checked at target choice `src/planner.ts:201,276,333`, `src/scoring.ts:126`
- Guard: advisory lock, one process drives a ship `src/dispatchLock.ts:4`, `src/scheduler.ts:138`
- Guard: restart restores live as shadow. `src/autopilotLifecycle.ts:85-94`
- External webhook: anomaly POST (generic JSON or Telegram `sendMessage`, bot token in URL path). `src/webhookDelivery.ts:51,348`; env validated `src/config.ts:151-172`

## Calls and called by
- Calls agent-service, fleet-service, navigation-service. `src/gameClients.ts:343-437`
- Calls auth-service: introspection `src/config.ts:194-197`; M2M token `src/config.ts:56-62,90`
- Called by command-interface `../command-interface/src/api/automationService.ts:14`; ai-service `../ai-service/src/automationServiceClient.ts:83-122` (out of scope)
- auth-service registers it as M2M caller with `fleet:control`. `../auth-service/src/config.ts:33`
- Shared packages by release tarball: clerk-client 2.0.1 `package.json:19`; eslint-config 1.1.0 `package.json:31`

## Persistence
- pg Pool. `src/db.ts:5-7`
- No migration files: `migrate()` is idempotent `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, runs every boot before listen. `src/db.ts:9-10`, `src/server.ts:722`
- Tables: `event_log` `src/db.ts:12`, `ship_task` :34, `autopilot_state` :85, `knob` :98, `metrics_rollup` :116, `anomaly` :135, `market_intel` :157, `mining_observation` :167, `travel_observation` :196, `contract` :214, `maintenance_progress` :238
- Knob definitions synced on boot, clamps logged `knob_clamped`. `src/db.ts:110`, `src/server.ts:726`

## Build, test, run
- Scripts: build=tsc, start, dev, typecheck, test=jest, lint=`eslint . --max-warnings 0`, replay. `package.json:9-17`
- Docker: `npm ci` + build, runtime `npm ci --omit=dev`. `Dockerfile:4,13`; Node >=24 `package.json:7`
- Local test DB: docker `postgres:16-alpine` on 5433. `CLAUDE.md:11`; `jest.env.js:1-2` defaults to 5433; CI uses 5432 `.github/workflows/container.yml:79`
- Jest `maxWorkers: 1`. `jest.config.js:10`
- Required env: `AUTH_M2M_TOKEN_URL`, `AUTH_M2M_CALLER_SECRET`, `AUTH_INTROSPECTION_URL`, `AUTH_INTROSPECTION_SECRET`, `DATABASE_URL`, `NAVIGATION_SERVICE_URL`, `AGENT_SERVICE_URL`, `FLEET_SERVICE_URL`, `MINING_SHIP_SYMBOL`. `src/config.ts:56-62,177-185,194-197`
- Optional: `PORT`, `CORS_ALLOWED_ORIGIN`, `ANOMALY_WEBHOOK_URL`/`ANOMALY_WEBHOOK_FORMAT`, `ANOMALY_TELEGRAM_CHAT_ID`, intervals `SCHEDULER_INTERVAL_MS` 5000, `REPLAN_INTERVAL_MS` 300000, `ANOMALY_INTERVAL_MS` 60000. `src/config.ts:186-192`
- No git-ignored env file needed. `./.gitignore:1`

## CI and deploy
- `.github/workflows/container.yml`: triggers pull_request, push main + tags `v*`, workflow_dispatch. `:3-13`
- Job `test` (postgres:16-alpine service, port 5432): `npm ci`, `npm run lint`, `npm test`. `.github/workflows/container.yml:45-79`
- Job `docker` (needs test; push or dispatch on main): builds linux/arm64, pushes to GHCR. `.github/workflows/container.yml:81-168`
- Deploy only from main tip: AWS role `github-actions-ssm-deploy` `.github/workflows/container.yml:170-175`; SSM send-command `automation-service-bootstrap-i-011b6b82a9072a385`, 90x10s poll `.github/workflows/container.yml:185-220`
- Concurrency group `deploy-<repo>` on main, `cancel-in-progress: false`. `:36-38`
- No audit step in CI. `.github/workflows/container.yml:45-79`

## Patterns
- `createApp` takes an options object; scheduler deps object; background work on `IntervalLoop`. `CLAUDE.md` "## Conventions" (CLAUDE.md:664)
- New task kind checklist. `CLAUDE.md:672-681`
- New table goes into `STATE_TABLES`. `src/testSupport/resetDatabase.ts:16`
- Express 4: wrap async handlers in `asyncHandler`. `src/server.ts:131`
- Tests force ticks via `app.locals.force*Tick`, never sleep. `src/server.ts:682-698`, `CLAUDE.md` "## Testing" (:610)

## Traps
- `CLAUDE.md:554` says clerk-client pin is 1.1.3; `package.json:19` pins 2.0.1. CLAUDE.md is stale.
- After every deploy nothing spends until the operator re-arms live. `src/autopilotLifecycle.ts:85-94`
- Stub 500 means unavailable (long retry patience); use 400 `{error:{message}}` for refusals. `CLAUDE.md:658-662`
- Metrics and anomaly loops are not stopped by abort; tests call `stopBackgroundSchedulers`. `src/server.ts:664-673`
- Operator `public_metadata`: add `events:write planner:advise`, do not replace. `CLAUDE.md:543`
- Webhook URL holds the bot token: never log it or `String(err)`. `src/webhookDelivery.ts:284-286`
- Shutdown budget 8s; order lifecycle, schedulers, server, pool last. `src/server.ts:51`, `CLAUDE.md:262-269`
- `CLAUDE.md` is long (684 lines): cite its headings, prefer code. (verified 2026-10-29 @ bf87ce2: wc -l on origin/main CLAUDE.md)

## Reference docs
- `./README.md` "Knobs": read when tuning a knob or changing a default or bound (defaults live in src/knobs.ts).
- `./README.md` "The work loops": read when changing mining, contract or scout FSM phases.
- `./README.md` "Watching for trouble": read when adding or changing an anomaly check.
- `./README.md` "Replaying decisions": read when re-scoring past decisions with `npm run replay`.

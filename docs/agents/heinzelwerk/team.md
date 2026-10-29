# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Autonomy**: full. Agents merge and apply on their own; breakages are learnings. Secrets are never published (name the variable, never the value); the gate never merges its own policy.
- **Backend paths**: `src/` (Express 4 + Postgres, TypeScript; tests `src/**/*.test.ts`, jest `jest.config.js`)
- **Worktree setup** (run once in every new task worktree): `npm ci`
- **Checks** (validator runs every one, in order; copied from CI, quiet flags only):
  - `npm run lint`
  - `DATABASE_URL=postgres://postgres:test@localhost:5432/automation_test npm test (unverified locally: needs postgres:16 on 5432, docker daemon not running; without it 375 of 643 tests fail)`
  - `npm audit --audit-level=high (red on main: V-M-Pioneer-Trading/meta#136)`
  - `docker buildx build --platform linux/arm64 . (unverified locally: docker daemon not running)`
- **Verified against**: bf87ce2 2026-10-29 (checks and every ref in this file; retro bumps it)
- **Coding standards**: `eslint.config.mjs:1` (shared `@v-m-pioneer-trading/eslint-config` `base`), `package.json:13` lint with `--max-warnings 0`; plus `CLAUDE.md` "## Invariants the scheduler depends on" (:70) and "## Conventions" (:664)
- **Risk areas** (validator reviews diffs touching these on Opus). Each entry is a path/glob or a described kind of change, plus why it is risky:
  - Merge to `main` deploys to production (SSM redeploy of automation-service): `.github/workflows/container.yml:170-220`
  - Spend paths, live autopilot spends game credits unattended (sell, purchase, refuel, contract accept/deliver/fulfill, navigate fuel): `src/gameClients.ts:410,419,422`, `src/miningTask.ts:200`, `src/contractTask.ts:95,121,140`, `src/taskFsm.ts:186`, `src/contractDiscovery.ts:62`
  - Spend guards (reserve floor, dispatch lock, shadow gating): `src/knobs.ts:166`, `src/dispatchLock.ts:4`, `src/scheduler.ts:283-324`
  - Restart downgrade (live comes back as shadow; no value may produce a live process): `src/autopilotLifecycle.ts:85-94`
  - `POST /autopilot/arm|pause|abort`: arming live starts spending, `fleet:control`: `src/server.ts:394-421`
  - `PUT /planner/knobs/:name`, `POST /planner/replan`: change planner behaviour, `planner:advise`; non-operator kind writes the policy class only: `src/server.ts:520-583`
  - `POST /events`: `events:write`, `ai_` types only, actor overwritten with the verified sub: `src/server.ts:461-479`
  - Every GET is unauthenticated (`ignoreCredentials()`) and public through CloudFront `/api/automation/v1/*`: a new GET or a leaked field is world-readable: `src/server.ts:256,366-367,383-602`; `C:/Users/max/work/infrastructure/projects/spacetraders/main.tf:147-148`
  - Auth declaration on every route (`secured()` refuses undeclared routes; one literal scope per route): `src/server.ts:250-261`, `src/auth.ts:22-34`; auth decision 21 `CLAUDE.md` "## Inbound auth (decision 21)" (:528)
  - Postgres schema migrates on every boot, idempotent DDL, no runner, no down migration; DDL must stay `IF NOT EXISTS` additive: `src/db.ts:9-238`, `src/server.ts:722`
  - Anomaly webhook URL holds the Telegram bot token: never log it or `String(err)`: `src/webhookDelivery.ts:51,284-286`
  - Operator `public_metadata` scopes are added to, never replaced: `CLAUDE.md:543`
  - infra paths: always a risk area (`../V-M-Pioneer-Trading_infrastructure/automation-service/`)
- **Contracts** (see team-modes **Contract changes**; validator checks every diff touching these):
  - API: `README.md` "API" (:658); provider backend
  - Provided: `/api/automation/v1/*` and `/api/automation/health` in `src/server.ts:366-367,619` · consumers command-interface (`../command-interface/src/api/automationService.ts:14`), ai-service (out of scope: `../ai-service/src/automationServiceClient.ts:83-122`)
  - Consumed: agent-service `/ships/:s/sell|purchase`, `/contracts`; fleet-service `/ships/:s/orbit|dock|navigate|extract|survey|refuel`, `/contracts/:id/deliver`; navigation-service `/systems/:s/waypoints`, `/waypoints/:w/market` from `src/gameClients.ts:343-437` · providers agent-service, fleet-service, navigation-service
  - Consumed: auth-service introspection `src/config.ts:194-197` and M2M token `src/config.ts:56-62`, startup exit 1 on unknown caller `src/server.ts:731-736` · provider auth-service (registers this caller with `fleet:control`: `../auth-service/src/config.ts:33`)
  - Vendored: none (verified 2026-10-29 @ bf87ce2: `git ls-files` shows no fixture or spec copies). Shared packages by release tarball: clerk-client `package.json:19`, eslint-config `package.json:31` · provider ts-introspection-client, eslint-config

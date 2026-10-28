# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Autonomy**: full. Agents merge and apply on their own; breakages are learnings. Secrets are never published (name the variable, never the value), and the gate never merges its own policy.
- **Backend paths**: whole repo (`src/`)
- **Worktree setup**: `npm ci`
- **Checks** (copied from `.github/workflows/container.yml`, jobs `test`, `docker`, in order):
  - `npm run lint`
  - `DATABASE_URL=postgres://postgres:test@localhost:5432/automation_test npm test` (unverified locally: needs Postgres 16 on :5432 as CI's service provides; docker daemon was not running. A local `docker run -p 5433:5432` matches `jest.env.js`'s default instead)
  - `docker build .` (unverified locally: docker daemon not running; the `docker` job builds linux/arm64)
- **Checks verified on main**: bf87ce2 2026-10-28
- **Coding standards**: `@v-m-pioneer-trading/eslint-config` base (`package.json:31`, `eslint.config.mjs`); conventions in `CLAUDE.md`
- **Risk areas** (validator reviews diffs touching these on Opus):
  - Money, all without a human: `src/contractTask.ts` (purchase, deliver, fulfill), `src/miningTask.ts` (sell), `src/taskFsm.ts` (refuel), `src/contractDiscovery.ts` (accept, gated by knob `contract.minProfitThreshold`), `src/gameClients.ts` (every upstream call)
  - `src/scheduler.ts`, `src/autopilotLifecycle.ts`, `src/autopilotState.ts`, `src/dispatchLock.ts`: arm/shadow/pause; a restart always comes back in shadow
  - `src/planner.ts`, `src/scoring.ts`, `src/knobs.ts`: `credit.reserveFloor` is class `policy`, so ai-service's M2M token may change it
  - `src/server.ts` route declarations: 9 `publicRead` routes; `GET /autopilot/events` serves caller-supplied `POST /events` detail publicly
  - `src/db.ts`: `migrate()` runs on every boot against production Postgres
  - `.github/workflows/container.yml`: a merge to main deploys to production; this stack has no `imageTag`, so no sha rollback (`../V-M-Pioneer-Trading_infrastructure/README.md:353-356`)
- **Contracts** (see team-modes **Contract changes**):
  - API: /api/automation/v1 routes in `src/server.ts` (no OpenAPI spec) · provider automation-service; consumers ai-service (`../ai-service/src/automationServiceClient.ts`), command-interface (`../command-interface/src/api/automationService.ts`), spacetraders-mcp-server (`../spacetraders-mcp-server/src/automation-service-client.ts`)
  - Consumed: agent-service, fleet-service, navigation-service APIs via `src/gameClients.ts` · providers those repos; auth-service `POST /auth/v1/m2m-token` and introspection via clerk-client · provider auth-service
  - Scope literals `fleet:control`, `events:write`, `planner:advise` (`src/auth.ts`) · provider auth-service (meta `auth-design.md` decision 22)
  - Shared packages: clerk-client 2.0.1 (`package.json:19`), eslint-config 1.1.0 (`package.json:31`)
  - Infra outputs: automation-service stack (env incl. `MINING_SHIP_SYMBOL`) · provider infrastructure (`../V-M-Pioneer-Trading_infrastructure/automation-service/`)

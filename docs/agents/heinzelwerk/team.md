# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Role**: backend (Node 24 / TS / Express / Postgres 16). The deterministic autopilot
- **Backend paths**: `src/`, `Dockerfile`
- **Worktree setup**: `npm ci --no-audit --no-fund`
- **Checks** (validator runs every one, in order; test DB first, unless already running: `docker run --rm -d --name automation-service-test-db -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=automation_test postgres:16-alpine`):
  1. `npm audit --audit-level=high`
  2. `npm run typecheck --silent`
  3. `npm run lint --silent`
  4. `npm test --silent -- --silent`
- **Security**: no secret scan runs yet: gitleaks is not installed and no pre-commit hook exists (planned: `gitleaks git --pre-commit --staged` in `.git/hooks/pre-commit`), so check every diff for secrets by eye · dependency audit in checks
- **Coding standards**: `CLAUDE.md` in this repo; lint rules come from `@v-m-pioneer-trading/eslint-config` and change only by a release of that package
- **Risk areas** (validator reviews diffs touching these on Opus):
  - dispatch and the shadow/live lifecycle (`state.arm()`; a restart restores shadow, never live): ships move, credits spend
  - planner credit reserve (`credit.reserveFloor`) and every call to agent-service purchase / sell
  - `migrate()`: idempotent DDL only; columns are added, never renamed or dropped in place
  - knob classes (`allowedClasses`): `policy` is the ai-service boundary; `alert` and `model` stay out of its reach
  - inbound auth (introspection via clerk-client) and the outbound M2M token
  - `src/webhookDelivery.ts`: with `telegram`, `ANOMALY_WEBHOOK_URL` holds the bot token, so it never reaches a log or an error message; chat bodies never carry raw `detail`
  - `.github/workflows/`: push to main deploys production
- **Contracts**:
  - event `type` names, `/autopilot/ship` response, knob / digest / replan / events routes: provider this repo; consumers command-interface, ai-service, spacetraders-mcp-server. No schema file, so the PR names every shape change
  - anomaly webhook (`ANOMALY_WEBHOOK_FORMAT`): `generic` payload `{id,type,dedupeKey,detectedAt,detail}` to ai-service `POST /webhooks/anomaly`; `telegram` is a Bot API `sendMessage` body
  - consumer of agent-service, fleet-service, navigation-service `openapi.json`
  - `@v-m-pioneer-trading/eslint-config`, `@v-m-pioneer-trading/clerk-client`: consumed by release-tarball URL, so a change is a version bump here

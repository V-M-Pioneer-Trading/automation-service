# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo; the workspace is described in V-M-Pioneer-Trading/meta `docs/agents/heinzelwerk/workspace.md`.

- **Autonomy**: full. Agents merge and apply on their own; breakages are learnings. Secrets are never published (name the variable, never the value), and the gate never merges its own policy.
- **Role**: backend
- **Backend paths**: whole repo
- **Worktree setup**: `npm ci`
- **Checks** (validator runs every one, in order; copied from CI, quiet flags only):
  - `npm run lint`
  - `DATABASE_URL=postgres://postgres:test@localhost:5432/automation_test npm test` (needs postgres:16-alpine on 5432, password test, db automation_test, as the CI service) (unverified locally: docker daemon not running)
  - `npm audit --audit-level=high` (red on main: V-M-Pioneer-Trading/meta#119)
- **Checks verified on main**: bf87ce2 2026-10-27
- **Coding standards**: `CLAUDE.md` and the shared `@v-m-pioneer-trading/eslint-config`
- **Risk areas** (validator reviews diffs touching these on Opus):
  - `src/scheduler.ts`, `src/gameClients.ts`, `src/*Task.ts`, `src/contractDiscovery.ts`: drive real ships; purchase, sell, refuel, contract accept/fulfill/deliver move credits
  - `src/autopilotLifecycle.ts`, `src/autopilotState.ts`: the shadow/live mode; a restart comes back in shadow, never live
  - `src/server.ts` routes: the GETs are public by design; writes are scope-guarded; knob writes trigger a replan
  - `src/db.ts` `migrate()`: idempotent DDL on every boot, must stay fast
  - `src/webhookDelivery.ts`: the webhook URL carries a Telegram bot token; never log it
  - `.github/workflows/**`: a merge to `main` deploys or releases
- **Contracts** (see team-modes **Contract changes**; validator checks every diff touching these):
  - API consumed by command-interface, ai-service: routes under `/api/automation/v1` (no openapi.json yet: meta#102) · provider automation-service

/**
 * @file What automation-service requires of a caller. Not how a token is verified.
 *
 * auth-service is the only component that verifies a Clerk token
 * (auth-design.md decision 21, meta#80). This service hands the caller's
 * `Authorization` header to it through the shared
 * `@v-m-pioneer-trading/introspection-client` package and compares the answer
 * against the scope each route declares in `server.ts`. There is no local
 * verifier, no key and no fallback to one: a second verification path is what
 * decision 10 forbids.
 *
 * Permissions are the space-delimited `scope` the center returns verbatim;
 * whether a caller is a person or a machine is the center's `kind`, never a
 * look at the `sub` prefix or at which header was sent.
 */

/**
 * Arm, pause, abort and the other fleet-moving routes. Not `POST /events`,
 * `POST /planner/replan` or `PUT /planner/knobs/:name`: those take the two
 * scopes below, one literal per route (decisions 20 and 22).
 */
export const SCOPE_FLEET_CONTROL = "fleet:control";
/**
 * `POST /events`: write `ai_` audit rows. Held by the ai-service machine
 * (decision 22's fixed scope table in auth-service) and by the operator through
 * Clerk `public_metadata`. `fleet:control` does not imply it.
 */
export const SCOPE_EVENTS_WRITE = "events:write";
/**
 * `POST /planner/replan` and `PUT /planner/knobs/:name`: advise the planner.
 * Same holders as {@link SCOPE_EVENTS_WRITE}; `fleet:control` does not imply
 * it. What fences a machine to `policy` knobs is `kind`, not this scope.
 */
export const SCOPE_PLANNER_ADVISE = "planner:advise";

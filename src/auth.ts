/**
 * @file What automation-service requires of a caller. Not how a token is verified.
 *
 * auth-service is the only component that verifies a Clerk token
 * (auth-design.md decision 21, meta#80). This service hands the caller's
 * `Authorization` header to it through the shared
 * `@v-m-pioneer-trading/clerk-client` package and compares the answer
 * against the scope each route declares in `server.ts`. There is no local
 * verifier, no key and no fallback to one: a second verification path is what
 * decision 10 forbids.
 *
 * Permissions are the space-delimited `scope` the center returns verbatim;
 * whether a caller is a person or a machine is the center's `kind`, never a
 * look at the `sub` prefix or at which header was sent.
 */

import type { ExpressAuth } from "@v-m-pioneer-trading/clerk-client";

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

/** "ignore": a public read, `ignoreCredentials()` (the header is never read, the center never asked); otherwise the one scope the route needs. */
export type Tier = "ignore" | typeof SCOPE_FLEET_CONTROL | typeof SCOPE_EVENTS_WRITE | typeof SCOPE_PLANNER_ADVISE;
export type Policy = Readonly<Record<string, Tier>>;

const KNOWN_TIERS: ReadonlySet<string> = new Set<Tier>(["ignore", SCOPE_FLEET_CONTROL, SCOPE_EVENTS_WRITE, SCOPE_PLANNER_ADVISE]);

/**
 * What each tsoa-registered route requires, keyed "METHOD /path" as Express
 * registers it. The routes still written inline in server.ts declare their
 * requirement at the call site and are not listed here. Every read here is
 * public (`ignoreCredentials()`): the dashboard stays watchable while
 * auth-service is down.
 */
export const routePolicy: Policy = {
  "GET /health": "ignore",
  "GET /api/automation/health": "ignore",
  "GET /api/automation/v1/autopilot/status": "ignore",
  "POST /api/automation/v1/autopilot/arm": SCOPE_FLEET_CONTROL,
  "POST /api/automation/v1/autopilot/pause": SCOPE_FLEET_CONTROL,
  "POST /api/automation/v1/autopilot/abort": SCOPE_FLEET_CONTROL,
  "GET /api/automation/v1/autopilot/events": "ignore",
  "GET /api/automation/v1/autopilot/ships/:shipSymbol": "ignore",
};

export type Registrar = Record<string, unknown>;
const VERBS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A router-shaped object for tsoa's generated RegisterRoutes: every route it
 * registers on `target` gets the declaration its policy entry names as first
 * handler. A route with no entry, an entry that is not one of {@link Tier}, or
 * "ignore" on a mutating method, throws, so the process refuses to start.
 *
 * `omit` names routes (keys of `policy`) that are not registered at all, for
 * routes that exist only in some configurations; the request then falls
 * through to notFound(). The entry is still checked first, and a key without
 * one throws here, so a misspelt omit cannot silently disable the check.
 *
 * `target` is secured() as well (server.ts): the second, independent guard.
 */
export function declaring(
  target: Registrar,
  auth: ExpressAuth,
  policy: Policy = routePolicy,
  omit: ReadonlySet<string> = new Set()
): Registrar {
  for (const key of omit) {
    if (!(key in policy)) throw new Error(`refusing to start: omit names ${key}, which has no entry in the route policy`);
  }
  const out: Registrar = {};
  for (const verb of VERBS) {
    out[verb] = (path: string, ...handlers: unknown[]) => {
      const method = verb.toUpperCase();
      const key = `${method} ${path}`;
      const tier = policy[key] as string | undefined;
      if (tier === undefined) {
        throw new Error(`refusing to start: route ${key} declares no credential requirement (add it to routePolicy in auth.ts)`);
      }
      if (!KNOWN_TIERS.has(tier)) {
        throw new Error(`refusing to start: route ${key} has unknown credential requirement "${tier}"`);
      }
      if (tier === "ignore" && !SAFE.has(method)) {
        throw new Error(`refusing to start: route ${key} answers a mutating method but declares no scope`);
      }
      if (omit.has(key)) return undefined;
      const declaration = tier === "ignore" ? auth.ignoreCredentials() : auth.requireScope(tier);
      return (target[verb] as (...a: unknown[]) => unknown)(path, declaration, ...handlers);
    };
  }
  return out;
}

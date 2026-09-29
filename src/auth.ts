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
 * Arm, pause, abort, replan, knob writes and `POST /events` — everything
 * mutating and reversible. Held by the operator and by machine callers alike;
 * what separates them on a knob write is `kind`, not the scope.
 */
export const SCOPE_FLEET_CONTROL = "fleet:control";

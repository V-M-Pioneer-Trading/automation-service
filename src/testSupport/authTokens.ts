/**
 * @file Test credentials: opaque strings, and what a stub center says of them.
 *
 * automation-service no longer verifies a token (auth-design.md decision 21),
 * so a test token is not a signed JWT; it is a string the stub center
 * recognises. Two stubs speak the same table:
 *
 * - {@link inProcessIntrospector}, which `createTestApp` hands to the
 *   package's real Express adapter. Only the transport is in-process: the
 *   adapter, the authorizer and every message are the package's own.
 * - `stubServers.ts`'s `startStubCenter`, a real local HTTP center, for the
 *   wiring suite.
 *
 * Nothing here signs anything, and there is no bypass: a request still needs a
 * token the center calls active, carrying the scope the route declares.
 */

import type { CenterAnswer, Identity, Introspector } from "@v-m-pioneer-trading/introspection-client";

export const TEST_ACTOR = "user_2TestOperator";
/** The machine caller's `sub`, as Clerk issues one for an M2M token. */
export const TEST_MACHINE = "mch_test";

// Scope strings are literals on purpose, never auth.ts constants: a test
// center that echoed SCOPE_FLEET_CONTROL would keep passing if the constant
// itself drifted from the contract string the center really issues.
const FLEET_CONTROL = "fleet:control";
const EVENTS_WRITE = "events:write";
const PLANNER_ADVISE = "planner:advise";
const AGENT_RESET = "agent:reset";

export const CONTROL_TOKEN = "test-token-fleet-control";
export const MACHINE_TOKEN = "test-token-machine-advisory";
export const SESSION_TOKEN = "test-token-session-other-scope";
export const INACTIVE_TOKEN = "test-token-inactive";
export const EXPIRED_TOKEN = "test-token-expired";
export const FOREIGN_TOKEN = "test-token-foreign-signed";

const fixed = new Map<string, Identity>([
  // The operator's Clerk public_metadata after decision 22 step 4.
  [CONTROL_TOKEN, { sub: TEST_ACTOR, kind: "operator", scopes: [FLEET_CONTROL, EVENTS_WRITE, PLANNER_ADVISE] }],
  // auth-service's fixed table row for ai-service: no fleet:control.
  [MACHINE_TOKEN, { sub: TEST_MACHINE, kind: "machine", scopes: [EVENTS_WRITE, PLANNER_ADVISE] }],
  // Signed in, holding a real permission, just not this service's.
  [SESSION_TOKEN, { sub: TEST_ACTOR, kind: "operator", scopes: [AGENT_RESET] }],
]);

/** Tokens minted by {@link bearer} with non-default options. */
const minted = new Map<string, Identity>();

/**
 * What the center answers for a bare token. Anything not listed is inactive —
 * which is what the center says of an expired, foreign-signed or garbage
 * token alike, since telling them apart is its business, not ours.
 */
export const answerFor = (token: string): CenterAnswer => {
  const identity = fixed.get(token) ?? minted.get(token);
  return identity !== undefined ? { state: "active", identity } : { state: "inactive" };
};

export const inProcessIntrospector: Introspector = {
  introspect: async (token: string) => answerFor(token),
};

export interface TestTokenOptions {
  sub?: string;
  /** A `kind` outside the contract's two may be cast in, to test fail-closed code. */
  kind?: Identity["kind"];
  scopes?: string[];
}

/**
 * Ready-to-use `Authorization` value. With no options, an operator holding
 * `fleet:control events:write planner:advise`; with options, a fresh token the center will answer with
 * exactly that identity.
 */
export const bearer = (options: TestTokenOptions = {}): string => {
  if (options.sub === undefined && options.kind === undefined && options.scopes === undefined) {
    return `Bearer ${CONTROL_TOKEN}`;
  }
  const token = `test-token-minted-${minted.size + 1}`;
  minted.set(token, {
    sub: options.sub ?? TEST_ACTOR,
    kind: options.kind ?? "operator",
    scopes: options.scopes ?? [FLEET_CONTROL],
  });
  return `Bearer ${token}`;
};

/** The AI supervisor: a machine holding `events:write planner:advise`, not `fleet:control` (decision 22). */
export const machineBearer = (): string => `Bearer ${MACHINE_TOKEN}`;

/**
 * An operator holding `fleet:control` and nothing else: what decision 22 says
 * must no longer reach `/events`, `/planner/replan` or a knob write.
 */
export const fleetControlOnlyBearer = (): string => bearer({ scopes: [FLEET_CONTROL] });

/** An operator who is signed in but holds no permission on this service. */
export const bearerWithoutScope = (): string => `Bearer ${SESSION_TOKEN}`;

/** A token the center answers `{"active": false}` for, as it does an expired one. */
export const expiredBearer = (): string => `Bearer ${EXPIRED_TOKEN}`;

/**
 * A token the center answers `{"active": false}` for, as it does one signed by
 * a key it never trusted. Kept as its own name so the suites still say which
 * case they mean; to this service the two are the same answer.
 */
export const foreignBearer = (): string => `Bearer ${FOREIGN_TOKEN}`;

/** A token the center answers `{"active": false}` for. */
export const inactiveBearer = (): string => `Bearer ${INACTIVE_TOKEN}`;

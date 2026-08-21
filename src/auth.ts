/**
 * @file Clerk session verification, performed locally.
 *
 * Verification is **networkless**: the service holds Clerk's RS256 public key
 * (`CLERK_JWT_KEY`, a PEM/SPKI string) and checks signatures itself rather than
 * fetching JWKS. That removes a network dependency from the hot path, removes
 * any JWKS cache-staleness logic, and — because a public key is not a secret —
 * lets the key travel as a plain environment variable.
 *
 * It is also what makes tests honest. Local dev, CI and production run this
 * exact code path; only the trust anchor differs, which is what a trust anchor
 * is for. There is deliberately **no bypass flag**: a code path that disables
 * authentication is a production vulnerability that passes CI.
 *
 * Permissions travel in the token's `scope` claim (space-delimited, per OAuth
 * convention) rather than a `role` claim, so this service and stagehopper —
 * which relies on API Gateway's `authorization_scopes`, and that matches `scope`
 * specifically — agree on where a permission lives.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "crypto";
// jose v5 rather than v6 deliberately: v6 is ESM-only, and this service's Jest
// setup runs CommonJS through ts-jest. v6 typechecked fine and then failed to
// load at test time — `SyntaxError: Unexpected token 'export'` — which is a poor
// trade for a dependency guarding the security boundary. v5 ships a CJS build.
import { importSPKI, jwtVerify, type KeyLike } from "jose";

/** Arm, pause, abort, replan, knob writes — everything mutating and reversible. */
export const SCOPE_FLEET_CONTROL = "fleet:control";
/**
 * Re-registration and credential replacement. Fenced separately because it is
 * the only operation that can destroy a fleet — the same instinct that keeps
 * `alert` knobs away from the AI supervisor. Not used by this service today;
 * auth-service owns those routes. Exported so both sides name it identically.
 */
export const SCOPE_AGENT_RESET = "agent:reset";

/** Clerk signs with RS256. Pinned, never read from the token's own header. */
const ALGORITHM = "RS256";

export interface AuthConfig {
  /** Clerk's public key in PEM/SPKI form. Public, so a plain env var. */
  clerkJwtKeyPem: string;
  /**
   * Expected `iss`. Optional: only Clerk holds the private half of the key
   * above, so a signature check already proves origin. Set it anyway when the
   * value is known — it costs nothing and narrows a misconfiguration where two
   * Clerk instances share a key.
   */
  clerkIssuer: string | null;
  /**
   * Shared secret for machine callers with no human identity — today just
   * ai-service posting its own rationale to `POST /events`. Clerk stays scoped
   * to human identity, which is the only thing it is unambiguously good at.
   */
  aiServiceSecret: string;
}

const unauthorized = (res: Response, message: string) =>
  res.status(401).json({ error: { message } });

const forbidden = (res: Response, message: string) =>
  res.status(403).json({ error: { message } });

const bearerFrom = (req: Request): string | null => {
  const header = req.header("Authorization");
  if (header === undefined) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join("");
  return token.length > 0 ? token : null;
};

/**
 * `scope` is a space-delimited string per OAuth. An array is accepted too, since
 * a JWT template can be configured either way and a caller should not be locked
 * out by a formatting choice made in a dashboard.
 */
const scopesFrom = (claim: unknown): string[] => {
  if (typeof claim === "string") return claim.split(/\s+/).filter((s) => s.length > 0);
  if (Array.isArray(claim)) return claim.filter((s): s is string => typeof s === "string");
  return [];
};

/** Constant-time compare that does not leak length through an early return. */
const secretMatches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a length mismatch is not faster than a
    // value mismatch.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
};

export interface Verifier {
  /** Reject unless the caller presents a Clerk session carrying `scope`. */
  requireScope(scope: string): RequestHandler;
  /** Reject unless the caller presents the machine shared secret. */
  requireServiceSecret(): RequestHandler;
}

/**
 * The Clerk user id of the caller, for audit. Only set once a `requireScope`
 * guard has actually verified a token, so a handler reading this can trust it.
 */
export const actorOf = (res: Response): string | null =>
  typeof res.locals.actor === "string" ? res.locals.actor : null;

export function createVerifier(config: AuthConfig): Verifier {
  if (config.clerkJwtKeyPem.length === 0) {
    throw new Error("clerkJwtKeyPem is required — refusing to start without a trust anchor");
  }
  if (config.aiServiceSecret.length === 0) {
    throw new Error("aiServiceSecret is required — refusing to start with an open machine route");
  }

  // Imported once, lazily, and reused. Rejection is cached deliberately: a
  // malformed key should fail every request loudly rather than be retried per
  // call and look like an intermittent auth outage.
  let keyPromise: Promise<KeyLike> | null = null;
  const key = () => {
    keyPromise ??= importSPKI(config.clerkJwtKeyPem, ALGORITHM);
    return keyPromise;
  };

  const requireScope =
    (scope: string): RequestHandler =>
    (req: Request, res: Response, next: NextFunction) => {
      const token = bearerFrom(req);
      if (token === null) {
        unauthorized(res, "a bearer token is required");
        return;
      }

      key()
        .then((publicKey) =>
          jwtVerify(token, publicKey, {
            algorithms: [ALGORITHM],
            ...(config.clerkIssuer !== null ? { issuer: config.clerkIssuer } : {}),
          })
        )
        .then(({ payload }) => {
          if (!scopesFrom(payload.scope).includes(scope)) {
            // 403 rather than 401: the token is valid, so re-authenticating
            // would only loop. The caller lacks the permission, not a session.
            forbidden(res, `this action requires the "${scope}" scope`);
            return;
          }
          res.locals.actor = typeof payload.sub === "string" ? payload.sub : null;
          next();
        })
        .catch(() => {
          // Deliberately not surfacing jose's reason. "expired" versus
          // "bad signature" versus "wrong issuer" is a probing oracle, and the
          // caller's remedy is the same in every case.
          unauthorized(res, "invalid or expired session");
        });
    };

  const requireServiceSecret =
    (): RequestHandler =>
    (req: Request, res: Response, next: NextFunction) => {
      const provided = req.header("X-Service-Secret");
      if (provided === undefined || !secretMatches(provided, config.aiServiceSecret)) {
        unauthorized(res, "a valid service secret is required");
        return;
      }
      next();
    };

  return { requireScope, requireServiceSecret };
}

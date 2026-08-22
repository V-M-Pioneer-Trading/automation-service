/**
 * @file Mints and caches the Clerk M2M token automation-service presents in
 * `Authorization` when it calls agent-service and fleet-service itself (the
 * mining/contract scheduler, not a human operator's browser).
 *
 * See auth-design.md decision 19. Two sources, matching the same
 * local/production split every other trust anchor in this codebase already
 * uses (see auth.ts, dev-keys/README.md):
 *
 *  - production: a real Clerk Machine, minted via the Backend API. Verified
 *    signature confirms — decoded and checked against the exact
 *    CLERK_JWT_KEY already deployed — a JWT-format M2M token is signed by
 *    the same instance key as a human session token, and carries `scope` as
 *    a flat top-level claim in the exact shape `requireScope()` already
 *    parses. Cached across ticks, refreshed well before its ~1hr expiry —
 *    not per-tick, since the scheduler ticks far more often than the
 *    Hobby-tier's 2,500 mints/month would tolerate. A stale-but-not-yet-
 *    expired cached token is preferred over a failed refresh, so a
 *    transient Clerk outage doesn't interrupt anything until the cached
 *    token actually goes stale.
 *  - local dev / tests: signed locally against a fixed (or, for tests,
 *    ephemeral) keypair — no network call, no Clerk account needed.
 *    Verification on the receiving end is real either way; only the trust
 *    anchor differs.
 */

import { sign } from "crypto";

export interface M2MTokenSource {
  getToken(): Promise<string>;
}

const b64url = (value: string): string => Buffer.from(value).toString("base64url");
const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

/** Refresh once this fraction of the token's lifetime has elapsed. */
const REFRESH_AT_FRACTION = 0.5;

interface CachedToken {
  token: string;
  expiresAtMs: number;
  refreshAtMs: number;
}

const cacheFrom = (token: string): CachedToken => {
  const [, payloadSegment] = token.split(".");
  const payload = decodeSegment(payloadSegment);
  const iat = typeof payload.iat === "number" ? payload.iat : 0;
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const lifetimeSeconds = exp - iat;
  return {
    token,
    expiresAtMs: exp * 1000,
    refreshAtMs: (iat + lifetimeSeconds * REFRESH_AT_FRACTION) * 1000,
  };
};

/**
 * Mints via `POST /m2m_tokens` against the Machine Secret Key for a
 * dedicated Clerk "Machine" representing automation-service. `claims` are
 * embedded at mint time and land as flat top-level JWT claims — e.g.
 * `{ scope: "fleet:control" }`.
 */
export function createClerkM2MTokenSource(machineSecretKey: string, claims: Record<string, unknown>): M2MTokenSource {
  let cached: CachedToken | null = null;
  let inflight: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    const res = await fetch("https://api.clerk.com/v1/m2m_tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineSecretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token_format: "jwt", claims }),
    });
    if (!res.ok) {
      throw new Error(`POST /m2m_tokens: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { token: string };
    cached = cacheFrom(body.token);
    return body.token;
  };

  return {
    async getToken(): Promise<string> {
      const now = Date.now();
      if (cached !== null && now < cached.refreshAtMs) return cached.token;

      inflight ??= mint().finally(() => {
        inflight = null;
      });
      try {
        return await inflight;
      } catch (err) {
        // A cached-but-past-its-refresh-point token is still valid — prefer
        // it over surfacing a transient mint failure, right up until the
        // token's actual expiry.
        if (cached !== null && now < cached.expiresAtMs) return cached.token;
        throw err;
      }
    },
  };
}

/** Local dev / tests: sign against a fixed keypair, no network call, no cache needed. */
export function createLocalM2MTokenSource(privateKeyPem: string, claims: Record<string, unknown>): M2MTokenSource {
  return {
    async getToken(): Promise<string> {
      const issuedAt = Math.floor(Date.now() / 1000);
      const header = { alg: "RS256", typ: "JWT", kid: "dev-only-do-not-use" };
      const payload = { sub: "mch_localdev", ...claims, iat: issuedAt, exp: issuedAt + 3600 };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem).toString("base64url");
      return `${signingInput}.${signature}`;
    },
  };
}

/**
 * @file Test credentials: an ephemeral keypair, generated per test run.
 *
 * Tests exercise the **real** verification path in `auth.ts` — there is no stub
 * verifier and no bypass flag. All that differs from production is the trust
 * anchor: this module mints a throwaway RSA keypair at load, hands the public
 * half to `createApp` and signs tokens with the private half. Nothing is
 * committed, nothing is shared between repositories, and a leaked test key
 * signs nothing that production would accept.
 *
 * The signer here is hand-rolled and synchronous on purpose. Signing is not the
 * security boundary — verification is, and that stays in `jose` — and a
 * synchronous `bearer()` keeps call sites readable across every suite that
 * touches a mutating route.
 */

import { generateKeyPairSync, sign } from "crypto";
import { SCOPE_AGENT_RESET, SCOPE_FLEET_CONTROL } from "../auth";

const newKeyPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const { publicKey, privateKey } = newKeyPair();
/** A second, untrusted keypair — the app is never told about this one. */
const foreign = newKeyPair();

/** Pass as `auth.clerkJwtKeyPem` when constructing an app under test. */
export const TEST_CLERK_JWT_KEY = publicKey;

/** Pass as `auth.aiServiceSecret`. Only ever compared, never verified. */
export const TEST_SERVICE_SECRET = "test-service-secret";

export const TEST_ACTOR = "user_2TestOperator";

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

export interface TestTokenOptions {
  scopes?: string[];
  sub?: string;
  /** Negative offsets produce an already-expired token. */
  expiresInSeconds?: number;
  issuer?: string;
}

export function signTestToken(options: TestTokenOptions = {}): string {
  return signWith(privateKey, options);
}

function signWith(key: string, options: TestTokenOptions): string {
  const {
    scopes = [SCOPE_FLEET_CONTROL],
    sub = TEST_ACTOR,
    expiresInSeconds = 300,
    issuer,
  } = options;

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    sub,
    scope: scopes.join(" "),
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
    ...(issuer !== undefined ? { iss: issuer } : {}),
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Ready-to-use `Authorization` header value for an operator with full control. */
export const bearer = (options: TestTokenOptions = {}): string => `Bearer ${signTestToken(options)}`;

/** An operator who is signed in but holds no permission on this service. */
export const bearerWithoutScope = (): string => bearer({ scopes: [SCOPE_AGENT_RESET] });

/** A well-formed token whose `exp` has already passed. */
export const expiredBearer = (): string => bearer({ expiresInSeconds: -60 });

/**
 * Correctly-shaped, correct scopes, valid `exp` — signed by a key the service
 * has never seen. The one token that proves the signature is actually checked
 * rather than the payload merely being decoded.
 */
export const foreignBearer = (): string => `Bearer ${signWith(foreign.privateKey, {})}`;

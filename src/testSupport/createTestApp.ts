/**
 * @file `createApp` with a test trust anchor, and nothing else changed.
 *
 * `createApp` takes its `AuthConfig` as a required second argument, ahead of
 * every optional one, so no call site can construct this service without
 * deciding what it trusts. Tests still need to construct it, so they go through
 * here — which supplies the ephemeral keypair from `authTokens` and forwards
 * everything else untouched.
 *
 * This is a different *key*, not a different code path: requests still run
 * through the real verifier in `auth.ts`, still need a real signature, and
 * still need the right scope. Anything that would pass here because
 * authentication was skipped does not exist.
 */

import { generateKeyPairSync } from "crypto";
import type { Pool } from "pg";
import { SCOPE_FLEET_CONTROL } from "../auth";
import type { AnomalyConfig } from "../anomalyScheduler";
import type { Clock } from "../clock";
import { createLocalM2MTokenSource } from "../m2mToken";
import { createApp, type MetricsConfig, type MiningConfig } from "../server";
import { TEST_CLERK_JWT_KEY, TEST_SERVICE_SECRET } from "./authTokens";

// A throwaway keypair for gameClients' own outbound Authorization header
// (decision 19) — separate from authTokens.ts's keypair, which is for
// *inbound* requests to this service's own routes. Nothing checks the
// content of outbound calls in tests (the stub servers they hit don't
// verify), so a fixed local signer is all that's needed here.
const { privateKey: TEST_M2M_SIGNING_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const createTestApp = (
  pool: Pool,
  clock?: Clock,
  mining?: MiningConfig,
  metrics?: MetricsConfig,
  anomaly?: AnomalyConfig,
  corsAllowedOrigin?: string
) =>
  createApp(
    pool,
    {
      clerkJwtKeyPem: TEST_CLERK_JWT_KEY,
      clerkIssuer: null,
      aiServiceSecret: TEST_SERVICE_SECRET,
    },
    clock,
    mining,
    metrics,
    anomaly,
    corsAllowedOrigin,
    createLocalM2MTokenSource(TEST_M2M_SIGNING_KEY, { scope: SCOPE_FLEET_CONTROL })
  );

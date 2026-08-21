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

import type { Pool } from "pg";
import type { AnomalyConfig } from "../anomalyScheduler";
import type { Clock } from "../clock";
import { createApp, type MetricsConfig, type MiningConfig } from "../server";
import { TEST_CLERK_JWT_KEY, TEST_SERVICE_SECRET } from "./authTokens";

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
    corsAllowedOrigin
  );

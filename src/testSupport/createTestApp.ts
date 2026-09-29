/**
 * @file `createApp` with a stub center, and nothing else changed.
 *
 * `createApp` requires an `ExpressAuth`, so no call site can construct this
 * service without deciding what it trusts. Tests go through here, which builds
 * one with the package's real `createExpressAuth` over the in-process
 * introspector in `authTokens.ts` and forwards everything else untouched.
 *
 * Only the center's transport differs: requests still run through the
 * package's real adapter and authorizer, still need a token the center calls
 * active, and still need the declared scope. The wiring suite builds its app
 * against a real HTTP stub center instead.
 */

import { createExpressAuth } from "@v-m-pioneer-trading/introspection-client";
import { generateKeyPairSync } from "crypto";
import type { Pool } from "pg";
import type { AnomalyConfig } from "../anomalyScheduler";
import { SCOPE_FLEET_CONTROL } from "../auth";
import type { Clock } from "../clock";
import { createLocalM2MTokenSource } from "../m2mToken";
import { createApp, type MetricsConfig, type MiningConfig } from "../server";
import { inProcessIntrospector } from "./authTokens";

// A throwaway keypair for gameClients' own outbound Authorization header
// (decision 19). Inbound requests to this service's own routes carry the
// opaque tokens in authTokens.ts instead. Nothing checks the
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
  createApp({
    pool,
    auth: createExpressAuth(inProcessIntrospector),
    clock,
    mining,
    metrics,
    anomaly,
    corsAllowedOrigin,
    authTokenSource: createLocalM2MTokenSource(TEST_M2M_SIGNING_KEY, { scope: SCOPE_FLEET_CONTROL }),
  });

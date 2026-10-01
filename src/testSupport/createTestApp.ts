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

import { createExpressAuth, type M2MTokenSource } from "@v-m-pioneer-trading/introspection-client";
import type { Pool } from "pg";
import type { AnomalyConfig } from "../anomalyScheduler";
import type { Clock } from "../clock";
import { createApp, type MetricsConfig, type MiningConfig } from "../server";
import { inProcessIntrospector, MACHINE_TOKEN } from "./authTokens";

// A stub for gameClients' own outbound Authorization header (decision 22): the
// machine token the center would mint. Nothing checks the content of outbound
// calls in tests (the stub servers they hit don't verify), so a fixed token
// from the center's table is all that's needed. The real source and its fake
// center are exercised in m2mToken.test.ts.
const TEST_M2M_TOKEN_SOURCE: M2MTokenSource = { getToken: async () => MACHINE_TOKEN };

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
    authTokenSource: TEST_M2M_TOKEN_SOURCE,
  });

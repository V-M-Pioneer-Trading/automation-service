import { loadIntrospectionConfig, type IntrospectionConfig } from "@v-m-pioneer-trading/introspection-client";
import { readFileSync } from "fs";
import { SCOPE_FLEET_CONTROL } from "./auth";
import { createClerkM2MTokenSource, createLocalM2MTokenSource, M2MTokenSource } from "./m2mToken";

export interface ServiceConfig {
  port: number;
  databaseUrl: string;
  navigationServiceUrl: string;
  agentServiceUrl: string;
  fleetServiceUrl: string;
  // Tracer-bullet simplification (meta#9, still true post-meta#10): the task
  // loop drives one pre-configured ship. What that ship does is chosen by the
  // planner; fleet-wide multi-ship dispatch is still future work.
  miningShipSymbol: string;
  // How often the scheduler checks whether a ship's current wait has elapsed.
  // Real deploys want seconds; tests want this near-instant.
  schedulerIntervalMs: number;
  // Fleet-wide replan (meta#13) fallback cadence — a replan also runs sooner
  // on a knob change or anomaly, debounced via the replan.debounceSeconds knob.
  replanIntervalMs: number;
  // How often a metrics rollup (meta#14) is computed and persisted.
  metricsRollupIntervalMs: number;
  // Where anomalies (meta#15) are also POSTed. Detection itself always runs
  // and the digest is always served; null only skips the outbound POST.
  anomalyWebhookUrl: string | null;
  anomalyIntervalMs: number;
  // Matches the sibling services' convention (fleet-service, agent-service):
  // the browser-facing UI (command-interface, default port 3000) is the only
  // cross-origin caller this API needs to allow.
  corsAllowedOrigin: string;
  // Where to ask auth-service what a caller's token carries (decision 21).
  // Required, with no default and no "auth optional" mode: this service
  // verifies nothing itself, so a service that started without the center
  // would answer 503 to every guarded request and look like an auth outage.
  introspection: IntrospectionConfig;
}

/**
 * The *outbound* credential (auth-design.md decision 19): production passes a real
 * Clerk Machine Secret Key inline (`CLERK_M2M_SECRET_KEY`); local dev points
 * at the committed dev-keys private half instead (`DEV_M2M_SIGNING_KEY_FILE`),
 * so `docker compose up` still needs no Clerk account. Neither has a default
 * — a missing configuration here should be a loud startup failure, not a
 * quiet 401 on every mining tick discovered days later.
 */
export const resolveM2MTokenSource = (): M2MTokenSource => {
  const secretKey = process.env.CLERK_M2M_SECRET_KEY;
  if (secretKey !== undefined && secretKey !== "") {
    return createClerkM2MTokenSource(secretKey, { scope: SCOPE_FLEET_CONTROL });
  }

  const path = process.env.DEV_M2M_SIGNING_KEY_FILE;
  if (path !== undefined && path !== "") {
    const pem = readFileSync(path, "utf8").trim();
    if (pem === "") throw new Error(`DEV_M2M_SIGNING_KEY_FILE (${path}) is empty`);
    return createLocalM2MTokenSource(pem, { scope: SCOPE_FLEET_CONTROL });
  }

  throw new Error("CLERK_M2M_SECRET_KEY or DEV_M2M_SIGNING_KEY_FILE must be set");
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }
  return value;
};

/**
 * A positive number, or the fallback when unset. Anything else is refused at
 * boot: `Number("5s")` is `NaN`, and `setInterval(fn, NaN)` fires every
 * millisecond, which is a far worse failure than not starting.
 */
const positiveNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
};

export const configFromEnv = (): ServiceConfig => ({
  port: positiveNumberEnv("PORT", 3003),
  databaseUrl: requireEnv("DATABASE_URL"),
  navigationServiceUrl: requireEnv("NAVIGATION_SERVICE_URL"),
  agentServiceUrl: requireEnv("AGENT_SERVICE_URL"),
  fleetServiceUrl: requireEnv("FLEET_SERVICE_URL"),
  miningShipSymbol: requireEnv("MINING_SHIP_SYMBOL"),
  schedulerIntervalMs: positiveNumberEnv("SCHEDULER_INTERVAL_MS", 5000),
  replanIntervalMs: positiveNumberEnv("REPLAN_INTERVAL_MS", 300_000),
  metricsRollupIntervalMs: positiveNumberEnv("METRICS_ROLLUP_INTERVAL_MS", 60_000),
  anomalyWebhookUrl: process.env.ANOMALY_WEBHOOK_URL ?? null,
  anomalyIntervalMs: positiveNumberEnv("ANOMALY_INTERVAL_MS", 60_000),
  corsAllowedOrigin: process.env.CORS_ALLOWED_ORIGIN ?? "http://localhost:3000",
  // AUTH_INTROSPECTION_URL (the full endpoint, POSTed to verbatim) and
  // AUTH_INTROSPECTION_SECRET. Throws, naming the missing variable and never
  // the secret, before a port is bound.
  introspection: loadIntrospectionConfig(),
});

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
  // Anomaly detection (meta#15) is only enabled once a webhook URL is
  // configured — null means the checks don't run at all.
  anomalyWebhookUrl: string | null;
  anomalyIntervalMs: number;
  // Matches the sibling services' convention (fleet-service, agent-service):
  // the browser-facing UI (command-interface, default port 3000) is the only
  // cross-origin caller this API needs to allow.
  corsAllowedOrigin: string;
  // Clerk's RS256 public key (PEM/SPKI). Required, with no default and no
  // "auth optional" mode: every mutating route on this service is gated by it,
  // and a service that can start without a trust anchor is a service that can
  // be deployed with authentication silently off.
  clerkJwtKeyPem: string;
  // Optional expected `iss`. Only Clerk holds the private half of the key
  // above, so this narrows misconfiguration rather than adding a control.
  clerkIssuer: string | null;
  // Shared secret for machine callers on POST /events (ai-service). Required
  // for the same reason as the key above — it is the one mutating route with
  // no human identity behind it.
  aiServiceSecret: string;
}

/**
 * The public key comes either inline (`CLERK_JWT_KEY`, how production passes it
 * from SSM through the bootstrap script) or as a path (`CLERK_JWT_KEY_FILE`,
 * how compose mounts the local dev key — a multi-line PEM survives a bind mount
 * far better than a `docker run -e`). Neither has a default: a service that can
 * start without a trust anchor is one that can be deployed with authentication
 * silently off.
 */
const requireClerkJwtKey = (): string => {
  // Inline wins. Compose always sets the file path (pointing at the committed
  // dev key), so an explicitly configured key — a Clerk dev instance's, say —
  // has to be able to override it without editing the compose file.
  const inline = process.env.CLERK_JWT_KEY;
  if (inline !== undefined && inline !== "") {
    // Newlines survive `docker run -e` poorly, so a single-line PEM with
    // literal "\n" escapes is accepted and normalised here, not in the verifier.
    return inline.replace(/\\n/g, "\n");
  }

  const path = process.env.CLERK_JWT_KEY_FILE;
  if (path !== undefined && path !== "") {
    const pem = readFileSync(path, "utf8").trim();
    if (pem === "") throw new Error(`CLERK_JWT_KEY_FILE (${path}) is empty`);
    return pem;
  }

  throw new Error("CLERK_JWT_KEY or CLERK_JWT_KEY_FILE must be set");
};

/**
 * Same local/production split as `requireClerkJwtKey`, mirrored for the
 * *outbound* side (auth-design.md decision 19): production passes a real
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
  clerkJwtKeyPem: requireClerkJwtKey(),
  clerkIssuer: process.env.CLERK_ISSUER ?? null,
  aiServiceSecret: requireEnv("AI_SERVICE_SECRET"),
});

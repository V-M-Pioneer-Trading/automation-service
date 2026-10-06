import {
  createCentralM2MTokenSource,
  loadIntrospectionConfig,
  M2MTokenError,
  type IntrospectionConfig,
  type M2MTokenSource,
} from "@v-m-pioneer-trading/clerk-client";
import { WEBHOOK_FORMATS, type WebhookFormat } from "./webhookDelivery";

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
  // The body shape that URL expects (#47): the original generic JSON, or a
  // Discord/Slack chat message. Only meaningful with a URL set.
  anomalyWebhookFormat: WebhookFormat;
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

/** Variables the pre-decision-22 sources read. Rollout step 3 removes them from the deploy. */
const RETIRED_M2M_VARIABLES = ["CLERK_M2M_SECRET_KEY", "DEV_M2M_SIGNING_KEY_FILE"] as const;

/**
 * Both variables the machine-token source needs, or a throw naming the first
 * one missing (never a value). `configFromEnv` calls this too, so a
 * deployment without them is refused before `migrate()`, not after.
 */
const requireM2MEnv = (env: NodeJS.ProcessEnv): { url: string; secret: string } => {
  const url = env.AUTH_M2M_TOKEN_URL;
  if (url === undefined || url === "") throw new Error("AUTH_M2M_TOKEN_URL must be set");
  const secret = env.AUTH_M2M_CALLER_SECRET;
  if (secret === undefined || secret === "") throw new Error("AUTH_M2M_CALLER_SECRET must be set");
  return { url, secret };
};

/**
 * The *outbound* credential (auth-design.md decision 22): this service holds
 * no Clerk material and mints nothing. It asks auth-service for its machine
 * token, proving who it is with its own caller secret
 * (`AUTH_M2M_CALLER_SECRET`) sent to `AUTH_M2M_TOKEN_URL`, the full
 * `/auth/v1/m2m-token` URL used verbatim. One source serves production and
 * local dev; the center decides what it signs with. Neither variable has a
 * default: a missing one is a loud startup failure, not a quiet 401 on every
 * mining tick discovered days later.
 *
 * `CLERK_M2M_SECRET_KEY` and `DEV_M2M_SIGNING_KEY_FILE` are no longer read. The
 * rollout keeps the old variable set in production until step 3, so setting
 * either is not an error: it is one log line naming the variable, never its
 * value.
 */
export const resolveM2MTokenSource = (
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.warn
): M2MTokenSource => {
  const { url, secret } = requireM2MEnv(env);

  const ignored = RETIRED_M2M_VARIABLES.filter((name) => env[name] !== undefined && env[name] !== "");
  if (ignored.length > 0) {
    log(`${ignored.join(" and ")} set but ignored: the machine token now comes from auth-service (decision 22)`);
  }

  return createCentralM2MTokenSource({ url, secret });
};

export type StartupTokenOutcome = "fetched" | "deferred" | "unknown-caller";

/**
 * Fetch the machine token once before listening. A `401` from the center is a
 * configuration error, not a transient one, so it comes back as
 * `"unknown-caller"` for the entrypoint to exit on. Anything else is the center
 * being slow or down: log one line and carry on, the source fetches again on
 * first use. Only `err.kind` is logged, never the token, the secret or a
 * response body.
 */
export const fetchStartupToken = async (
  source: M2MTokenSource,
  log: (line: string) => void = console.warn
): Promise<StartupTokenOutcome> => {
  try {
    await source.getToken();
    return "fetched";
  } catch (err) {
    if (err instanceof M2MTokenError && err.kind === "unknown-caller") return "unknown-caller";
    const kind = err instanceof M2MTokenError ? err.kind : "unexpected";
    log(`machine token not fetched at startup (${kind}); will retry on first use`);
    return "deferred";
  }
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

/**
 * The webhook body format, `generic` when unset. A typo is refused at boot: a
 * wrong format means every page is rejected by the chat service, which is
 * only noticed when the page that mattered never arrives.
 */
const webhookFormatEnv = (): WebhookFormat => {
  const raw = process.env.ANOMALY_WEBHOOK_FORMAT;
  if (raw === undefined || raw === "") return "generic";
  const format = WEBHOOK_FORMATS.find((f) => f === raw);
  if (format === undefined) {
    throw new Error(`ANOMALY_WEBHOOK_FORMAT must be one of ${WEBHOOK_FORMATS.join(", ")}, got "${raw}"`);
  }
  return format;
};

export const configFromEnv = (): ServiceConfig => {
  // Presence only; the source itself is built later by resolveM2MTokenSource.
  // Checked here so the failure precedes migrate().
  requireM2MEnv(process.env);
  return {
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
    anomalyWebhookFormat: webhookFormatEnv(),
    anomalyIntervalMs: positiveNumberEnv("ANOMALY_INTERVAL_MS", 60_000),
    corsAllowedOrigin: process.env.CORS_ALLOWED_ORIGIN ?? "http://localhost:3000",
    // AUTH_INTROSPECTION_URL (the full endpoint, POSTed to verbatim) and
    // AUTH_INTROSPECTION_SECRET. Throws, naming the missing variable and never
    // the secret, before a port is bound.
    introspection: loadIntrospectionConfig(),
  };
};

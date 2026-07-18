export interface ServiceConfig {
  databaseUrl: string;
  navigationServiceUrl: string;
  agentServiceUrl: string;
  fleetServiceUrl: string;
  // Tracer-bullet simplification (meta#9, still true post-meta#10): the mining
  // loop drives one pre-configured ship. Which asteroid field it mines is now
  // chosen dynamically by the planner (meta#10); fleet-wide multi-ship
  // dispatch is still future work.
  miningShipSymbol: string;
  // How often the scheduler checks whether a ship's current wait has elapsed.
  // Real deploys want seconds; tests want this near-instant.
  schedulerIntervalMs: number;
  // How often a metrics rollup (meta#14) is computed and persisted.
  metricsRollupIntervalMs: number;
  // Anomaly detection (meta#15) is only enabled once a webhook URL is
  // configured — null means the checks don't run at all.
  anomalyWebhookUrl: string | null;
  anomalyIntervalMs: number;
}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set`);
  }
  return value;
};

export const configFromEnv = (): ServiceConfig => ({
  databaseUrl: requireEnv("DATABASE_URL"),
  navigationServiceUrl: requireEnv("NAVIGATION_SERVICE_URL"),
  agentServiceUrl: requireEnv("AGENT_SERVICE_URL"),
  fleetServiceUrl: requireEnv("FLEET_SERVICE_URL"),
  miningShipSymbol: requireEnv("MINING_SHIP_SYMBOL"),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 5000),
  metricsRollupIntervalMs: Number(process.env.METRICS_ROLLUP_INTERVAL_MS ?? 60_000),
  anomalyWebhookUrl: process.env.ANOMALY_WEBHOOK_URL ?? null,
  anomalyIntervalMs: Number(process.env.ANOMALY_INTERVAL_MS ?? 60_000),
});

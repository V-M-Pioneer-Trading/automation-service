export interface ServiceConfig {
  databaseUrl: string;
  navigationServiceUrl: string;
  agentServiceUrl: string;
  fleetServiceUrl: string;
  // Tracer-bullet simplification (meta#9): the mining loop drives one
  // pre-configured ship to one pre-configured asteroid field. Choosing which
  // ship to fly and which field to mine is the planner's job (meta#10) — this
  // ticket proves the FSM end-to-end, not fleet-wide task assignment.
  miningShipSymbol: string;
  miningAsteroidWaypoint: string;
  // How often the scheduler checks whether a ship's current wait has elapsed.
  // Real deploys want seconds; tests want this near-instant.
  schedulerIntervalMs: number;
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
  miningAsteroidWaypoint: requireEnv("MINING_ASTEROID_WAYPOINT"),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 5000),
});

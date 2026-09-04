import { Pool } from "pg";
import { Clock } from "./clock";

export interface MarketIntel {
  waypoint: string;
  lastRefreshedAt: Date;
}

/**
 * When a ship of ours last read each market's prices **in person**.
 *
 * SpaceTraders only reports a market's trade goods to a ship that is actually
 * there, so this is the one honest measure of how fresh the price data behind
 * a decision is. It is written whenever a docked ship reads a market — a
 * scout's refresh, a miner pricing the market it is about to sell at — and
 * read by both the planner (to decide which market is worth a scouting trip)
 * and the `market_stale` anomaly check, so the two never disagree about what
 * "stale" means.
 */
export class MarketIntelRepo {
  constructor(private pool: Pool, private clock: Clock) {}

  async record(waypoints: string | string[]): Promise<void> {
    const symbols = [...new Set(Array.isArray(waypoints) ? waypoints : [waypoints])];
    if (symbols.length === 0) return;
    await this.pool.query(
      `INSERT INTO market_intel (waypoint, last_refreshed_at)
       SELECT waypoint, $2 FROM unnest($1::text[]) AS waypoint
       ON CONFLICT (waypoint) DO UPDATE SET last_refreshed_at = EXCLUDED.last_refreshed_at`,
      [symbols, this.clock.now()]
    );
  }

  async getAll(): Promise<MarketIntel[]> {
    const { rows } = await this.pool.query(
      "SELECT waypoint, last_refreshed_at FROM market_intel ORDER BY last_refreshed_at ASC"
    );
    return rows.map((r) => ({ waypoint: r.waypoint, lastRefreshedAt: r.last_refreshed_at }));
  }
}

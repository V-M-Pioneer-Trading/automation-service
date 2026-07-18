import { Pool } from "pg";
import { Clock } from "./clock";

export interface MarketIntel {
  waypoint: string;
  lastRefreshedAt: Date;
}

export class MarketIntelRepo {
  constructor(private pool: Pool, private clock: Clock) {}

  async record(waypoint: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_intel (waypoint, last_refreshed_at)
       VALUES ($1, $2)
       ON CONFLICT (waypoint) DO UPDATE SET last_refreshed_at = $2`,
      [waypoint, this.clock.now()]
    );
  }

  async getAll(): Promise<MarketIntel[]> {
    const { rows } = await this.pool.query(
      "SELECT waypoint, last_refreshed_at FROM market_intel ORDER BY last_refreshed_at ASC"
    );
    return rows.map((r) => ({ waypoint: r.waypoint, lastRefreshedAt: r.last_refreshed_at }));
  }
}

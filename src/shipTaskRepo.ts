import { Pool } from "pg";
import { Clock } from "./clock";
import { SurveyData } from "./gameClients";

export type MiningPhase = "TRAVEL_TO_ASTEROID" | "SURVEY" | "EXTRACT" | "TRAVEL_TO_MARKET" | "SELL";

export interface ShipTask {
  shipSymbol: string;
  phase: MiningPhase;
  waitingUntil: Date | null;
  survey: SurveyData | null;
  tradeSymbol: string | null;
  marketWaypoint: string | null;
  /** Null whenever the ship needs a fresh assignment from the planner (meta#10): a brand new task, or the moment a cycle completes. */
  asteroidWaypoint: string | null;
  /** Consecutive tick failures against the current asteroidWaypoint; resets on any successful tick. */
  failureCount: number;
  /** Last time this task's row changed — drives the meta#15 ship-idle anomaly check. */
  updatedAt: Date;
}

export class ShipTaskRepo {
  constructor(private pool: Pool, private clock: Clock) {}

  async getOrCreate(shipSymbol: string): Promise<ShipTask> {
    const existing = await this.get(shipSymbol);
    if (existing !== null) return existing;

    await this.pool.query(
      `INSERT INTO ship_task (ship_symbol, phase, updated_at)
       VALUES ($1, 'TRAVEL_TO_ASTEROID', $2)
       ON CONFLICT (ship_symbol) DO NOTHING`,
      [shipSymbol, this.clock.now()]
    );
    return (await this.get(shipSymbol))!;
  }

  async get(shipSymbol: string): Promise<ShipTask | null> {
    const { rows } = await this.pool.query(
      `SELECT ship_symbol, phase, waiting_until, survey, trade_symbol, market_waypoint, asteroid_waypoint, failure_count, updated_at
       FROM ship_task WHERE ship_symbol = $1`,
      [shipSymbol]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      shipSymbol: row.ship_symbol,
      phase: row.phase,
      waitingUntil: row.waiting_until,
      survey: row.survey,
      tradeSymbol: row.trade_symbol,
      marketWaypoint: row.market_waypoint,
      asteroidWaypoint: row.asteroid_waypoint,
      failureCount: row.failure_count,
      updatedAt: row.updated_at,
    };
  }

  async save(task: ShipTask): Promise<void> {
    await this.pool.query(
      `UPDATE ship_task
       SET phase = $2, waiting_until = $3, survey = $4, trade_symbol = $5, market_waypoint = $6,
           asteroid_waypoint = $7, failure_count = $8, updated_at = $9
       WHERE ship_symbol = $1`,
      [
        task.shipSymbol,
        task.phase,
        task.waitingUntil,
        task.survey,
        task.tradeSymbol,
        task.marketWaypoint,
        task.asteroidWaypoint,
        task.failureCount,
        this.clock.now(),
      ]
    );
  }
}

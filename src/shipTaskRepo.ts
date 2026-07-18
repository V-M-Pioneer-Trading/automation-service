import { Pool } from "pg";
import { Clock } from "./clock";
import { SurveyData } from "./gameClients";

export type MiningPhase = "TRAVEL_TO_ASTEROID" | "SURVEY" | "EXTRACT" | "TRAVEL_TO_MARKET" | "SELL";
export type ContractPhase =
  | "CONTRACT_TRAVEL_TO_MARKET"
  | "CONTRACT_PURCHASE"
  | "CONTRACT_TRAVEL_TO_DESTINATION"
  | "CONTRACT_DELIVER"
  | "CONTRACT_FULFILL";
export type TaskKind = "mining" | "contract";

export interface ShipTask {
  shipSymbol: string;
  taskKind: TaskKind;
  phase: MiningPhase | ContractPhase;
  waitingUntil: Date | null;
  survey: SurveyData | null;
  /** Mining: the extracted good. Contract: the deliverable good. */
  tradeSymbol: string | null;
  /** Mining: the sell market. Contract: the procurement market. */
  marketWaypoint: string | null;
  /** Null whenever the ship needs a fresh assignment from the planner (meta#10): a brand new task, or the moment a cycle completes. */
  asteroidWaypoint: string | null;
  /** Consecutive tick failures against the current target; resets on any successful tick. */
  failureCount: number;
  /** Contract loop (meta#11): the contract this task is working, and its delivery destination/progress. */
  contractId: string | null;
  destinationWaypoint: string | null;
  unitsDelivered: number;
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
      `SELECT ship_symbol, task_kind, phase, waiting_until, survey, trade_symbol, market_waypoint, asteroid_waypoint,
              failure_count, contract_id, destination_waypoint, units_delivered, updated_at
       FROM ship_task WHERE ship_symbol = $1`,
      [shipSymbol]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      shipSymbol: row.ship_symbol,
      taskKind: row.task_kind,
      phase: row.phase,
      waitingUntil: row.waiting_until,
      survey: row.survey,
      tradeSymbol: row.trade_symbol,
      marketWaypoint: row.market_waypoint,
      asteroidWaypoint: row.asteroid_waypoint,
      failureCount: row.failure_count,
      contractId: row.contract_id,
      destinationWaypoint: row.destination_waypoint,
      unitsDelivered: row.units_delivered,
      updatedAt: row.updated_at,
    };
  }

  async save(task: ShipTask): Promise<void> {
    await this.pool.query(
      `UPDATE ship_task
       SET task_kind = $2, phase = $3, waiting_until = $4, survey = $5, trade_symbol = $6, market_waypoint = $7,
           asteroid_waypoint = $8, failure_count = $9, contract_id = $10, destination_waypoint = $11,
           units_delivered = $12, updated_at = $13
       WHERE ship_symbol = $1`,
      [
        task.shipSymbol,
        task.taskKind,
        task.phase,
        task.waitingUntil,
        task.survey,
        task.tradeSymbol,
        task.marketWaypoint,
        task.asteroidWaypoint,
        task.failureCount,
        task.contractId,
        task.destinationWaypoint,
        task.unitsDelivered,
        this.clock.now(),
      ]
    );
  }
}

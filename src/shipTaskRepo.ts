import { Pool, PoolClient } from "pg";
import { Clock } from "./clock";
import { SurveyData } from "./gameClients";

export type MiningPhase = "TRAVEL_TO_ASTEROID" | "SURVEY" | "EXTRACT" | "TRAVEL_TO_MARKET" | "SELL";
export type ContractPhase =
  | "CONTRACT_TRAVEL_TO_MARKET"
  | "CONTRACT_PURCHASE"
  | "CONTRACT_TRAVEL_TO_DESTINATION"
  | "CONTRACT_DELIVER"
  | "CONTRACT_FULFILL";
export type ScoutPhase = "SCOUT_TRAVEL" | "SCOUT_REFRESH";
export type TaskPhase = MiningPhase | ContractPhase | ScoutPhase;
export type TaskKind = "mining" | "contract" | "scout";

export interface ShipTask {
  shipSymbol: string;
  taskKind: TaskKind;
  phase: TaskPhase;
  waitingUntil: Date | null;
  survey: SurveyData | null;
  /** Mining: the extracted good. Contract: the deliverable good. */
  tradeSymbol: string | null;
  /** Mining: the sell market. Contract: the procurement market. */
  marketWaypoint: string | null;
  /**
   * Where the planner sent the ship: an asteroid field to mine, or a market to
   * scout. Null whenever the ship needs a fresh assignment — a brand new task,
   * or the moment its last one completed. See `isIdle`.
   */
  asteroidWaypoint: string | null;
  /** Consecutive tick failures against the current target; resets on any successful tick. */
  failureCount: number;
  /** Contract loop: the contract this task is working, and its delivery destination/progress. */
  contractId: string | null;
  destinationWaypoint: string | null;
  unitsDelivered: number;
  /**
   * Running tallies for the cycle in progress. A cycle spans many ticks and can
   * survive a restart, so what it earned and how long it took can only be known
   * by accumulating here and reading it back when the cycle completes — at
   * which point it becomes one row in `mining_observation` and the planner
   * learns something. See observations.ts.
   */
  cycleStartedAt: Date | null;
  cycleRevenue: number;
  cycleTravelDistance: number;
  cycleUnitsExtracted: number;
  /** Last time this task's row changed — drives the ship-idle anomaly check. */
  updatedAt: Date;
}

/** A ship with no assigned target — the only kind the planner (and a replan) will touch. */
export const isIdle = (task: ShipTask): boolean => task.asteroidWaypoint === null && task.contractId === null;

/**
 * The blank slate a ship returns to whenever it needs a fresh planner
 * assignment: every completed task, every abandoned one, and the base every
 * new assignment is written on top of. Resets the cycle tallies too — a new
 * assignment starts a new cycle, and carrying the previous one's revenue
 * forward would corrupt the observation written when this one completes.
 */
export const idleTask = (task: ShipTask): ShipTask => ({
  ...task,
  taskKind: "mining",
  phase: "TRAVEL_TO_ASTEROID",
  waitingUntil: null,
  survey: null,
  tradeSymbol: null,
  marketWaypoint: null,
  asteroidWaypoint: null,
  contractId: null,
  destinationWaypoint: null,
  unitsDelivered: 0,
  failureCount: 0,
  cycleStartedAt: null,
  cycleRevenue: 0,
  cycleTravelDistance: 0,
  cycleUnitsExtracted: 0,
});

const TASK_COLUMNS = `ship_symbol, task_kind, phase, waiting_until, survey, trade_symbol, market_waypoint,
       asteroid_waypoint, failure_count, contract_id, destination_waypoint, units_delivered,
       cycle_started_at, cycle_revenue, cycle_travel_distance, cycle_units_extracted, updated_at`;

function rowToTask(row: {
  ship_symbol: string;
  task_kind: TaskKind;
  phase: TaskPhase;
  waiting_until: Date | null;
  survey: SurveyData | null;
  trade_symbol: string | null;
  market_waypoint: string | null;
  asteroid_waypoint: string | null;
  failure_count: number;
  contract_id: string | null;
  destination_waypoint: string | null;
  units_delivered: number;
  cycle_started_at: Date | null;
  cycle_revenue: string | number;
  cycle_travel_distance: string | number;
  cycle_units_extracted: string | number;
  updated_at: Date;
}): ShipTask {
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
    cycleStartedAt: row.cycle_started_at,
    cycleRevenue: Number(row.cycle_revenue),
    cycleTravelDistance: Number(row.cycle_travel_distance),
    cycleUnitsExtracted: Number(row.cycle_units_extracted),
    updatedAt: row.updated_at,
  };
}

export class ShipTaskRepo {
  // Pool | PoolClient (not just Pool) so callers can pass a transaction's
  // checked-out client (see transaction.ts) to make this write part of a
  // larger atomic transaction.
  constructor(private pool: Pool | PoolClient, private clock: Clock) {}

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
      `SELECT ${TASK_COLUMNS} FROM ship_task WHERE ship_symbol = $1`,
      [shipSymbol]
    );
    if (rows.length === 0) return null;
    return rowToTask(rows[0]);
  }

  /**
   * Every ship with no assigned target (a brand new task, or one whose cycle
   * just completed) — the candidate set a fleet-wide replan reassigns. A ship
   * mid-task never matches this, so a replan can never preempt work in flight.
   */
  async listIdle(): Promise<ShipTask[]> {
    const { rows } = await this.pool.query(
      `SELECT ${TASK_COLUMNS} FROM ship_task WHERE asteroid_waypoint IS NULL AND contract_id IS NULL`
    );
    return rows.map(rowToTask);
  }

  async save(task: ShipTask): Promise<void> {
    await this.pool.query(
      `UPDATE ship_task
       SET task_kind = $2, phase = $3, waiting_until = $4, survey = $5, trade_symbol = $6, market_waypoint = $7,
           asteroid_waypoint = $8, failure_count = $9, contract_id = $10, destination_waypoint = $11,
           units_delivered = $12, cycle_started_at = $13, cycle_revenue = $14, cycle_travel_distance = $15,
           cycle_units_extracted = $16, updated_at = $17
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
        task.cycleStartedAt,
        task.cycleRevenue,
        task.cycleTravelDistance,
        task.cycleUnitsExtracted,
        this.clock.now(),
      ]
    );
  }
}

import { Pool, PoolClient } from "pg";
import { Clock } from "./clock";

export type ContractStatus = "declined" | "accepted" | "assigned" | "fulfilled";

export interface ContractRecord {
  contractId: string;
  tradeSymbol: string;
  destinationWaypoint: string;
  unitsRequired: number;
  totalPayment: number;
  status: ContractStatus;
  /** The deterministic evaluation's expected profit (payment - procurement - travel), fixed at evaluation time. */
  expectedProfit: number;
  /** The evaluation's estimated hours to complete one full cycle — feeds the planner's score alongside mining. */
  cycleHours: number;
  /** Route distance frozen at evaluation, so cycle time can be re-derived under the current model. */
  travelDistance: number;
  procurementMarket: string | null;
}

/**
 * One row per contract this agent has ever seen. Recording the evaluation
 * decision here means a contract is never re-evaluated or re-accepted once
 * decided — discovery only has to diff against `SELECT contract_id` on every tick.
 */
export class ContractRepo {
  // Pool | PoolClient (not just Pool) so callers can pass a transaction's
  // checked-out client (see transaction.ts) to make this write part of a
  // larger atomic transaction (meta#30).
  constructor(private pool: Pool | PoolClient, private clock: Clock) {}

  async knownIds(): Promise<Set<string>> {
    const { rows } = await this.pool.query("SELECT contract_id FROM contract");
    return new Set(rows.map((r) => r.contract_id));
  }

  async record(record: ContractRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO contract
         (contract_id, trade_symbol, destination_waypoint, units_required, total_payment, status,
          expected_profit, cycle_hours, travel_distance, procurement_market, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (contract_id) DO NOTHING`,
      [
        record.contractId,
        record.tradeSymbol,
        record.destinationWaypoint,
        record.unitsRequired,
        record.totalPayment,
        record.status,
        record.expectedProfit,
        record.cycleHours,
        record.travelDistance,
        record.procurementMarket,
        this.clock.now(),
      ]
    );
  }

  async setStatus(contractId: string, status: ContractStatus): Promise<void> {
    await this.pool.query(`UPDATE contract SET status = $2 WHERE contract_id = $1`, [contractId, status]);
  }

  /** Accepted contracts not yet assigned to a ship — candidates for the planner's scoring. */
  async listAccepted(): Promise<ContractRecord[]> {
    const { rows } = await this.pool.query(`SELECT * FROM contract WHERE status = 'accepted' ORDER BY contract_id`);
    return rows.map(rowToRecord);
  }

  async get(contractId: string): Promise<ContractRecord | null> {
    const { rows } = await this.pool.query(`SELECT * FROM contract WHERE contract_id = $1`, [contractId]);
    return rows.length === 0 ? null : rowToRecord(rows[0]);
  }
}

function rowToRecord(row: {
  contract_id: string;
  trade_symbol: string;
  destination_waypoint: string;
  units_required: number;
  total_payment: string | number;
  status: ContractStatus;
  expected_profit: string | number;
  cycle_hours: string | number;
  travel_distance: string | number | null;
  procurement_market: string | null;
}): ContractRecord {
  return {
    contractId: row.contract_id,
    tradeSymbol: row.trade_symbol,
    destinationWaypoint: row.destination_waypoint,
    unitsRequired: row.units_required,
    totalPayment: Number(row.total_payment),
    status: row.status,
    expectedProfit: Number(row.expected_profit),
    cycleHours: Number(row.cycle_hours),
    travelDistance: Number(row.travel_distance ?? 0),
    procurementMarket: row.procurement_market,
  };
}

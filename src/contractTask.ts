import { ContractRecord } from "./contractRepo";
import { ContractPhase, idleTask, ShipTask, TaskPhase } from "./shipTaskRepo";
import {
  dockIfNeeded,
  refuelIfNeeded,
  requireTarget,
  resolveWaitIfElapsed,
  TaskContext,
  TickResult,
  travelTo,
  withPhase,
} from "./taskFsm";

/**
 * CONTRACT_TRAVEL_TO_MARKET → CONTRACT_PURCHASE → CONTRACT_TRAVEL_TO_DESTINATION
 *   → CONTRACT_DELIVER → CONTRACT_FULFILL → idle
 *
 * Buys and delivers up to cargo capacity per round trip, looping back through
 * CONTRACT_TRAVEL_TO_MARKET while units are still owed. Only the contract's
 * first deliverable is worked — see README.
 */
export async function advanceContractTask(ctx: TaskContext & { contract: ContractRecord }): Promise<TickResult | null> {
  const waiting = resolveWaitIfElapsed(ctx, "contract");
  if (waiting !== undefined) return waiting;

  const { contract } = ctx;
  switch (ctx.task.phase) {
    case "CONTRACT_TRAVEL_TO_MARKET":
      return travelTo(ctx, requireTarget(contract.procurementMarket, "procurementMarket"), "CONTRACT_PURCHASE", "contract");
    case "CONTRACT_PURCHASE":
      return dispatchPurchase(ctx, contract);
    case "CONTRACT_TRAVEL_TO_DESTINATION":
      return travelTo(ctx, contract.destinationWaypoint, "CONTRACT_DELIVER", "contract");
    case "CONTRACT_DELIVER":
      return dispatchDeliver(ctx, contract);
    case "CONTRACT_FULFILL":
      return dispatchFulfill(ctx, contract);
    default:
      throw new Error(`contract task cannot advance from phase ${ctx.task.phase}`);
  }
}

/**
 * The phases from a *confirmed* purchase onward — the phase advances only once
 * the purchase call has returned. `tradeSymbol` cannot answer "is cargo
 * aboard?" for a contract the way it does for mining: it is set at assignment
 * time, before anything has been bought (meta#27), so the phase is the only
 * thing that says goods were acquired.
 *
 * The gap that leaves is meta#27's known one, not a new one: a purchase that
 * reached the game but whose response was lost leaves the row at
 * `CONTRACT_PURCHASE`, and the target can then be abandoned with cargo actually
 * aboard. Widening this list to cover it would strand the far commoner case —
 * a purchase that never happened — on a target it can never complete.
 *
 * `satisfies` is load-bearing: the `readonly TaskPhase[]` annotation alone
 * would accept `"SURVEY"` here.
 */
const CARGO_HELD_PHASES: readonly TaskPhase[] = [
  "CONTRACT_TRAVEL_TO_DESTINATION",
  "CONTRACT_DELIVER",
  "CONTRACT_FULFILL",
] satisfies readonly ContractPhase[];

/** See `miningCargoAtStake` for why each kind answers this itself. */
export const contractCargoAtStake = (task: ShipTask): boolean => CARGO_HELD_PHASES.includes(task.phase);

const heldUnits = (ctx: TaskContext, tradeSymbol: string): number =>
  ctx.ship.cargo.inventory.find((i) => i.symbol === tradeSymbol)?.units ?? 0;

async function dispatchPurchase(ctx: TaskContext, contract: ContractRecord): Promise<TickResult> {
  const { task, ship, clients} = ctx;
  const docking = await dockIfNeeded(ctx, "contract");
  if (docking !== null) return docking;
  // The procurement market is the one guaranteed fuel stop on this loop; leave
  // it full so the delivery leg can't strand the ship somewhere without fuel.
  const refuel = await refuelIfNeeded(ctx, "contract");
  if (refuel !== null) return refuel;

  const { tradeSymbol } = contract;
  // Only the contract's own good counts toward what's owed; unrelated cargo
  // merely takes up room in the hold.
  const owed = contract.unitsRequired - task.unitsDelivered - heldUnits(ctx, tradeSymbol);
  const units = Math.min(owed, ship.cargo.capacity - ship.cargo.units);
  if (units <= 0) {
    return {
      task: { ...withPhase(task, "CONTRACT_TRAVEL_TO_DESTINATION"), tradeSymbol },
      event: "contract_purchase_skipped",
      detail: { shipSymbol: task.shipSymbol, reason: owed <= 0 ? "cargo already holds what's owed" : "cargo full" },
    };
  }
  const res = await clients.purchase(task.shipSymbol, tradeSymbol, units);
  return {
    task: { ...withPhase(task, "CONTRACT_TRAVEL_TO_DESTINATION"), tradeSymbol },
    event: "contract_purchase",
    detail: { shipSymbol: task.shipSymbol, tradeSymbol, units, totalPrice: res.data.transaction.totalPrice },
  };
}

async function dispatchDeliver(ctx: TaskContext, contract: ContractRecord): Promise<TickResult> {
  const { task, clients} = ctx;
  const docking = await dockIfNeeded(ctx, "contract");
  if (docking !== null) return docking;

  const { contractId, tradeSymbol, unitsRequired } = contract;
  const units = Math.min(heldUnits(ctx, tradeSymbol), unitsRequired - task.unitsDelivered);
  if (units <= 0) {
    // Cargo hold has none of the contract good (sold off-target, or a
    // different good was extracted) — dispatching deliver with 0 units would
    // either error or no-op forever. Send the ship back to buy the right good
    // instead of burning failure budget on a call that can never progress.
    return {
      task: withPhase(task, "CONTRACT_TRAVEL_TO_MARKET"),
      event: "contract_deliver_skipped",
      detail: { shipSymbol: task.shipSymbol, contractId, tradeSymbol, reason: "cargo hold has none of the contract good" },
    };
  }
  await clients.deliverContract(contractId, task.shipSymbol, tradeSymbol, units);

  const unitsDelivered = task.unitsDelivered + units;
  const done = unitsDelivered >= unitsRequired;
  return {
    task: { ...withPhase(task, done ? "CONTRACT_FULFILL" : "CONTRACT_TRAVEL_TO_MARKET"), unitsDelivered },
    event: "contract_deliver",
    detail: { shipSymbol: task.shipSymbol, contractId, tradeSymbol, units, unitsDelivered, unitsRequired },
  };
}

async function dispatchFulfill(ctx: TaskContext, contract: ContractRecord): Promise<TickResult> {
  const { task, clients } = ctx;
  // The response carries the settled contract, so the balance is recorded from
  // what the game actually paid rather than from the evaluation's estimate.
  // `payment` is the key the earnings checks and the credits/hour rollup read
  // (see fleetEvents.ts) — without it a contract-running fleet reads as having
  // earned nothing at all.
  const settled = await clients.fulfillContract(contract.contractId);
  // Idle hands the ship back to the planner on its very next tick — mining, or
  // the next accepted contract, whichever scores higher.
  return {
    task: idleTask(task),
    event: "contract_fulfilled",
    detail: {
      shipSymbol: task.shipSymbol,
      contractId: contract.contractId,
      payment: settled?.contract?.terms?.payment?.onFulfilled ?? 0,
    },
  };
}

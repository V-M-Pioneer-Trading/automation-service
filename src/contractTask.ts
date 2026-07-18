import { Clock } from "./clock";
import { GameClients, ShipSnapshot } from "./gameClients";
import { TickResult, travelTo, withPhase } from "./miningTask";
import { ShipTask } from "./shipTaskRepo";

/**
 * Advances one ship's contract FSM by exactly one atomic action per call, same
 * granularity guarantee as advanceMiningTask (meta#9). Travel/dock steps reuse
 * miningTask.ts's helpers — a ship traveling for a contract behaves identically
 * to one traveling to mine, only the destination and what happens on arrival differ.
 *
 * v1 simplification: assumes a single deliverable per contract and buys/delivers
 * up to cargo capacity per round trip, looping back through CONTRACT_TRAVEL_TO_MARKET
 * if more units are still needed after a delivery — see README.
 */
export async function advanceContractTask(params: {
  task: ShipTask;
  ship: ShipSnapshot;
  contractId: string;
  tradeSymbol: string;
  procurementMarket: string;
  destinationWaypoint: string;
  unitsRequired: number;
  clients: GameClients;
  clock: Clock;
  authHeader: string;
}): Promise<TickResult | null> {
  const { task, ship, contractId, tradeSymbol, procurementMarket, destinationWaypoint, unitsRequired, clients, clock, authHeader } =
    params;
  const now = clock.now();

  if (task.waitingUntil !== null) {
    if (now < task.waitingUntil) return null; // still waiting
    return resolveWait(task);
  }

  switch (task.phase) {
    case "CONTRACT_TRAVEL_TO_MARKET":
      return travelTo(task, ship, procurementMarket, clients, authHeader, "CONTRACT_PURCHASE", "contract");
    case "CONTRACT_PURCHASE":
      return dispatchPurchase(task, ship, tradeSymbol, unitsRequired, clients, authHeader);
    case "CONTRACT_TRAVEL_TO_DESTINATION":
      return travelTo(task, ship, destinationWaypoint, clients, authHeader, "CONTRACT_DELIVER", "contract");
    case "CONTRACT_DELIVER":
      return dispatchDeliver(task, ship, contractId, tradeSymbol, unitsRequired, clients, authHeader);
    case "CONTRACT_FULFILL":
      return dispatchFulfill(task, contractId, clients, authHeader);
    default:
      return null; // a mining phase reached here would be a caller bug — nothing safe to do but wait
  }
}

function resolveWait(task: ShipTask): TickResult {
  const next: ShipTask["phase"] =
    task.phase === "CONTRACT_TRAVEL_TO_MARKET"
      ? "CONTRACT_PURCHASE"
      : task.phase === "CONTRACT_TRAVEL_TO_DESTINATION"
        ? "CONTRACT_DELIVER"
        : task.phase; // CONTRACT_PURCHASE/DELIVER/FULFILL never wait themselves
  return {
    task: withPhase(task, next),
    event: "contract_wait_resolved",
    detail: { shipSymbol: task.shipSymbol, from: task.phase, to: next },
  };
}

async function dispatchPurchase(
  task: ShipTask,
  ship: ShipSnapshot,
  tradeSymbol: string,
  unitsRequired: number,
  clients: GameClients,
  authHeader: string
): Promise<TickResult> {
  if (ship.nav.status !== "DOCKED") {
    return dock(task, clients, authHeader);
  }
  const remaining = unitsRequired - task.unitsDelivered - ship.cargo.units;
  const units = Math.min(remaining, ship.cargo.capacity - ship.cargo.units);
  if (units <= 0) {
    // Cargo already holds everything this trip can carry toward the contract.
    return {
      task: { ...withPhase(task, "CONTRACT_TRAVEL_TO_DESTINATION"), tradeSymbol },
      event: "contract_purchase_skipped",
      detail: { shipSymbol: task.shipSymbol, reason: "cargo already full" },
    };
  }
  const res = await clients.purchase(task.shipSymbol, tradeSymbol, units, authHeader);
  return {
    task: { ...withPhase(task, "CONTRACT_TRAVEL_TO_DESTINATION"), tradeSymbol },
    event: "contract_purchase",
    detail: { shipSymbol: task.shipSymbol, tradeSymbol, units, totalPrice: res.data.transaction.totalPrice },
  };
}

async function dispatchDeliver(
  task: ShipTask,
  ship: ShipSnapshot,
  contractId: string,
  tradeSymbol: string,
  unitsRequired: number,
  clients: GameClients,
  authHeader: string
): Promise<TickResult> {
  if (ship.nav.status !== "DOCKED") {
    return dock(task, clients, authHeader);
  }
  const held = ship.cargo.inventory.find((i) => i.symbol === tradeSymbol)?.units ?? 0;
  const units = Math.min(held, unitsRequired - task.unitsDelivered);
  await clients.deliverContract(contractId, task.shipSymbol, tradeSymbol, units, authHeader);

  const unitsDelivered = task.unitsDelivered + units;
  const done = unitsDelivered >= unitsRequired;
  return {
    task: { ...withPhase(task, done ? "CONTRACT_FULFILL" : "CONTRACT_TRAVEL_TO_MARKET"), unitsDelivered },
    event: "contract_deliver",
    detail: { shipSymbol: task.shipSymbol, contractId, tradeSymbol, units, unitsDelivered, unitsRequired },
  };
}

async function dispatchFulfill(task: ShipTask, contractId: string, clients: GameClients, authHeader: string): Promise<TickResult> {
  await clients.fulfillContract(contractId, authHeader);
  return {
    task,
    event: "contract_fulfilled",
    detail: { shipSymbol: task.shipSymbol, contractId },
  };
}

async function dock(task: ShipTask, clients: GameClients, authHeader: string): Promise<TickResult> {
  await clients.dock(task.shipSymbol, authHeader);
  return { task, event: "contract_dock", detail: { shipSymbol: task.shipSymbol } };
}

import { ContractRecord, ContractRepo, ContractStatus } from "./contractRepo";
import { EventLog } from "./eventLog";
import { Contract, GameClients, ShipSnapshot } from "./gameClients";
import { ContractEvaluation, Planner } from "./planner";

/**
 * Discovers contracts not yet seen, evaluates each deterministically
 * (Planner.evaluateContract), and accepts or declines immediately — accepting
 * is the one real mutating call, so a contract's fate is decided in the same
 * pass it's first evaluated rather than left pending.
 *
 * Deliberately not a background scheduler (there was one in an earlier draft):
 * with a single ship that can only ever work one target at a time, evaluating
 * on its own timer raced the assignment — a fresh contract could still be
 * mid-evaluation when the ship locked in a mining target instead, even though
 * the contract would have scored higher. Called from the scheduler right
 * before every scoring decision instead, so "what's available to score" is
 * always caught up with "what SpaceTraders currently has on offer".
 */
export async function discoverAndEvaluateContracts(deps: {
  contracts: ContractRepo;
  events: EventLog;
  clients: GameClients;
  planner: Planner;
  ship: ShipSnapshot;
  spaceTradersToken: string;
}): Promise<void> {
  const { contracts, events, clients, planner, ship, spaceTradersToken } = deps;

  const [offered, known] = await Promise.all([clients.getContracts(spaceTradersToken), contracts.knownIds()]);

  // Contracts SpaceTraders already shows as accepted but this agent has no
  // local row for (meta#28): a prior run's acceptContract succeeded but the
  // following record write failed — accept and record are not atomic. They
  // are re-evaluated (for a real procurementMarket/cycleHours, so they're
  // assignable) and recorded as accepted without calling acceptContract
  // again; SpaceTraders already made that decision.
  const orphanedAccepted = offered.filter((c) => c.accepted && !c.fulfilled && !known.has(c.id));
  const unseen = offered.filter((c) => !c.accepted && !c.fulfilled && !known.has(c.id));
  if (orphanedAccepted.length === 0 && unseen.length === 0) return;

  // One context and one read of every market serve every evaluation below.
  const context = await planner.loadContext(ship.nav.systemSymbol, spaceTradersToken);
  const markets = await Promise.all(context.marketplaces.map((w) => clients.getMarket(w.symbol, spaceTradersToken)));
  const evaluate = (contract: Contract) => planner.evaluateContract({ contract, ship, context, markets });

  for (const contract of orphanedAccepted) {
    const evaluation = evaluate(contract);
    await contracts.record(toRecord(contract, evaluation, "accepted"));
    await events.append("contract_reconciled", { contractId: contract.id, ...evaluation.detail });
  }

  const minProfitThreshold = context.knobs["contract.minProfitThreshold"];
  for (const contract of unseen) {
    const evaluation = evaluate(contract);
    const profitable = evaluation.procurementMarket !== null && evaluation.expectedProfit > minProfitThreshold;
    await events.append("contract_evaluated", { accepted: profitable, ...evaluation.detail });

    if (!profitable) {
      await contracts.record(toRecord(contract, evaluation, "declined"));
      continue;
    }
    await clients.acceptContract(contract.id, spaceTradersToken);
    await contracts.record(toRecord(contract, evaluation, "accepted"));
    await events.append("contract_accepted", { contractId: contract.id, expectedProfit: evaluation.expectedProfit });
  }
}

/** What's frozen about a contract once it's been decided. Tracks only the first deliverable — see README. */
function toRecord(contract: Contract, evaluation: ContractEvaluation, status: ContractStatus): ContractRecord {
  const deliverable = contract.terms.deliver[0];
  return {
    contractId: contract.id,
    tradeSymbol: deliverable?.tradeSymbol ?? "",
    destinationWaypoint: deliverable?.destinationSymbol ?? "",
    unitsRequired: deliverable !== undefined ? deliverable.unitsRequired - deliverable.unitsFulfilled : 0,
    totalPayment: contract.terms.payment.onAccepted + contract.terms.payment.onFulfilled,
    status,
    expectedProfit: evaluation.expectedProfit,
    cycleHours: evaluation.cycleHours,
    procurementMarket: evaluation.procurementMarket,
  };
}

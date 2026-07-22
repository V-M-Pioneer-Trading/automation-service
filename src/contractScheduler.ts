import { ContractRepo } from "./contractRepo";
import { EventLog } from "./eventLog";
import { GameClients } from "./gameClients";
import { KnobRepo } from "./knobs";
import { Planner } from "./planner";

/**
 * Discovers contracts not yet seen, evaluates each deterministically
 * (Planner.evaluateContract), and accepts or declines immediately — accepting
 * is the one real mutating call, so a contract's fate is decided in the same
 * pass it's first evaluated rather than left pending.
 *
 * Deliberately not a periodic background scheduler (there was one in an
 * earlier draft): with a single ship that can only ever work one target at a
 * time, evaluating on its own timer raced the mining scheduler's assignment —
 * a fresh contract could still be mid-evaluation when the ship locked in a
 * mining target instead, even though the contract would have scored higher.
 * Called synchronously from MiningScheduler.assignTarget() right before
 * scoring instead, so "what's available to score" is always caught up with
 * "what SpaceTraders currently has on offer" before a decision is made.
 * Revisit if/when multiple ships mean contracts should be pursued ahead of
 * any one ship actually needing work.
 */
export async function discoverAndEvaluateContracts(params: {
  repo: ContractRepo;
  events: EventLog;
  clients: GameClients;
  knobs: KnobRepo;
  planner: Planner;
  shipSymbol: string;
  authHeader: string;
}): Promise<void> {
  const { repo, events, clients, knobs, planner, shipSymbol, authHeader } = params;

  const [contracts, known] = await Promise.all([clients.getContracts(authHeader), repo.knownIds()]);

  // Contracts SpaceTraders already shows as accepted but this agent has no
  // local row for (meta#28): a prior run's acceptContract call succeeded but
  // the following repo.record write then failed (transient DB error, restart
  // mid-call) — accept and record are not atomic. Re-evaluated (to get a real
  // procurementMarket/cycleHours so it's assignable) and recorded directly as
  // accepted, without calling acceptContract again — SpaceTraders already made
  // that decision, and it's excluded from `unseen` below precisely because it
  // reports accepted:true, so it would otherwise never be retried at all.
  const orphanedAccepted = contracts.filter((c) => c.accepted && !c.fulfilled && !known.has(c.id));
  const unseen = contracts.filter((c) => !known.has(c.id) && !c.accepted && !c.fulfilled);
  if (orphanedAccepted.length === 0 && unseen.length === 0) return;

  const [ship, minProfitThreshold] = await Promise.all([
    clients.getShip(shipSymbol, authHeader),
    knobs.get("contract.minProfitThreshold"),
  ]);

  await Promise.all(
    orphanedAccepted.map(async (contract) => {
      const deliverable = contract.terms.deliver[0];
      if (deliverable === undefined) return; // nothing to reconcile without a deliverable to track
      const evaluation = await planner.evaluateContract({ contract, ship, systemSymbol: ship.nav.systemSymbol, authHeader });
      await repo.record({
        contractId: contract.id,
        tradeSymbol: deliverable.tradeSymbol,
        destinationWaypoint: deliverable.destinationSymbol,
        unitsRequired: deliverable.unitsRequired - deliverable.unitsFulfilled,
        totalPayment: contract.terms.payment.onAccepted + contract.terms.payment.onFulfilled,
        status: "accepted",
        expectedProfit: evaluation.expectedProfit,
        cycleHours: evaluation.cycleHours,
        procurementMarket: evaluation.procurementMarket,
      });
      await events.append("contract_reconciled", { contractId: contract.id, ...evaluation.detail });
    })
  );

  if (unseen.length === 0) return;

  // Each contract's evaluate/accept/record/log is independent of every other
  // unseen contract — now on the critical ship-dispatch path (called from
  // assignTarget before every scoring decision), so run them concurrently
  // rather than paying U sequential evaluation round-trips.
  await Promise.all(
    unseen.map(async (contract) => {
      const evaluation = await planner.evaluateContract({ contract, ship, systemSymbol: ship.nav.systemSymbol, authHeader });
      const profitable = evaluation.procurementMarket !== null && evaluation.expectedProfit > minProfitThreshold;
      const deliverable = contract.terms.deliver[0];

      await events.append("contract_evaluated", { accepted: profitable, ...evaluation.detail });

      if (!profitable || deliverable === undefined) {
        await repo.record({
          contractId: contract.id,
          tradeSymbol: deliverable?.tradeSymbol ?? "",
          destinationWaypoint: deliverable?.destinationSymbol ?? "",
          unitsRequired: deliverable?.unitsRequired ?? 0,
          totalPayment: contract.terms.payment.onAccepted + contract.terms.payment.onFulfilled,
          status: "declined",
          expectedProfit: evaluation.expectedProfit,
          cycleHours: evaluation.cycleHours,
          procurementMarket: evaluation.procurementMarket,
        });
        return;
      }

      await clients.acceptContract(contract.id, authHeader);
      await repo.record({
        contractId: contract.id,
        tradeSymbol: deliverable.tradeSymbol,
        destinationWaypoint: deliverable.destinationSymbol,
        unitsRequired: deliverable.unitsRequired - deliverable.unitsFulfilled,
        totalPayment: contract.terms.payment.onAccepted + contract.terms.payment.onFulfilled,
        status: "accepted",
        expectedProfit: evaluation.expectedProfit,
        cycleHours: evaluation.cycleHours,
        procurementMarket: evaluation.procurementMarket,
      });
      await events.append("contract_accepted", { contractId: contract.id, expectedProfit: evaluation.expectedProfit });
    })
  );
}

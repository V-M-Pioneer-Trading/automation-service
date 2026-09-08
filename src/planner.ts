import { ContractRecord, ContractRepo } from "./contractRepo";
import { Contract, GameClients, MarketData, ShipSnapshot, WaypointSummary } from "./gameClients";
import { KnobRepo, KnobValues } from "./knobs";
import { MarketIntel, MarketIntelRepo } from "./marketIntelRepo";
import { CalibratedModel, ObservationRepo, priorsFromKnobs } from "./observations";
import { fuelAwareRoute, RouteWaypoint } from "./routeCost";
import { breachesReserveFloor, cycleHours, contractScore, isViableCandidate, miningScore, scoutScore } from "./scoring";
import { decisionDetail, MiningDecisionRecord, PlannerCandidate } from "./plannerDecision";

/**
 * Decides what a ship should do next.
 *
 * Three kinds of work compete — mine a field, run a contract, refresh a
 * market's prices — and they are compared in one currency: expected credits per
 * hour. Highest wins. The arithmetic lives in scoring.ts; this file's job is to
 * gather the inputs, apply the safety rules, and record why it chose what it
 * chose.
 *
 * The inputs that matter are **measured, not assumed**. What a mining cycle at
 * a given field is worth comes from cycles actually completed there
 * (observations.ts); ship speed comes from flights actually timed. That is what
 * makes one asteroid field score differently from another. Before those
 * measurements exist the model falls back to the `*Prior` knobs, and the
 * planner degrades gracefully to preferring whatever is closest.
 *
 * Work that would earn nothing is never assigned: a task kind switched off by
 * its weight, or a contract that can only lose money, scores at or below zero
 * and loses to idling — so `mine.taskWeight = 0` really does disable mining
 * rather than merely demoting it.
 */


// A candidate is part of the decision record before it is part of the planner:
// it is what a replay re-scores. Defined there so the record module depends on
// nothing, and re-exported here because this is where callers look for it.
export type { PlannerCandidate };

export interface ContractEvaluation {
  /** Null if no market in the system sells the required good, or no route reaches the destination. */
  procurementMarket: string | null;
  expectedProfit: number;
  cycleHours: number;
  /** Route length behind `cycleHours`, kept so it can be re-timed under a later model. */
  travelDistance: number;
  detail: Record<string, unknown>;
}

/** The winning target for a ship that needs one. */
export type TargetAssignment =
  | { kind: "mine"; asteroidWaypoint: string; detail: Record<string, unknown> }
  | { kind: "contract"; contract: ContractRecord; detail: Record<string, unknown> }
  | { kind: "scout"; scoutWaypoint: string; detail: Record<string, unknown> }
  | { kind: "none"; detail: Record<string, unknown> };

/**
 * Everything a decision depends on, fetched once. Every task kind is scored
 * against exactly the same snapshot of the world, which is what makes the
 * comparison between them mean anything.
 */
export interface DecisionContext {
  systemSymbol: string;
  waypoints: WaypointSummary[];
  marketplaces: WaypointSummary[];
  routeWaypoints: RouteWaypoint[];
  credits: number;
  knobs: KnobValues;
  model: CalibratedModel;
}

const isMarketplace = (w: WaypointSummary): boolean => w.traits.some((t) => t.symbol === "MARKETPLACE");

const toRouteWaypoints = (waypoints: WaypointSummary[]): RouteWaypoint[] =>
  waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, hasFuelStation: isMarketplace(w) }));

/** The subset of the calibrated model a decision is logged with, so a replay can reproduce the beliefs it ran on. */
const modelSummary = (model: CalibratedModel) => ({
  speedUnitsPerHour: model.speedUnitsPerHour,
  overheadHours: model.overheadHours,
  fuelCreditsPerUnitDistance: model.fuelCreditsPerUnitDistance,
  fleetCreditsPerCycle: model.fleetCreditsPerCycle,
  provenance: model.provenance,
});

interface MiningScoring {
  chosen: Required<PlannerCandidate> | null;
  detail: MiningDecisionRecord;
}

export class Planner {
  constructor(
    private clients: GameClients,
    private knobs: KnobRepo,
    private observations: ObservationRepo,
    private contracts: ContractRepo,
    private marketIntel: MarketIntelRepo
  ) {}

  /** One fetch of everything a decision depends on: one waypoint lookup, one credit balance, one calibration. */
  async loadContext(systemSymbol: string): Promise<DecisionContext> {
    const [waypoints, agent, knobs] = await Promise.all([
      this.clients.getSystemWaypoints(systemSymbol),
      this.clients.getAgent(),
      this.knobs.getValues(),
    ]);
    const model = await this.observations.calibrate(priorsFromKnobs(knobs));
    return {
      systemSymbol,
      waypoints,
      marketplaces: waypoints.filter(isMarketplace),
      routeWaypoints: toRouteWaypoints(waypoints),
      credits: agent.credits,
      knobs,
      model,
    };
  }

  /**
   * The winning target for a ship that needs one — the best mining field, the
   * best accepted-but-unassigned contract, and the most worthwhile market to
   * re-price, compared in the same credits-per-hour units.
   */
  async assignTarget(params: { ship: ShipSnapshot; now: Date }): Promise<TargetAssignment> {
    const { ship, now } = params;
    const [context, acceptedContracts, marketIntel] = await Promise.all([
      this.loadContext(ship.nav.systemSymbol),
      this.contracts.listAccepted(),
      this.marketIntel.getAll(),
    ]);

    const mining = this.scoreMining(ship, context);
    const bestContract = this.scoreContracts(acceptedContracts, context);
    const bestScout = this.scoreScouting(ship, marketIntel, now, context);

    const scores = {
      mine: mining.chosen?.score ?? -Infinity,
      contract: bestContract?.score ?? -Infinity,
      scout: bestScout?.score ?? -Infinity,
    };
    const comparison = {
      miningScore: mining.chosen?.score ?? null,
      contractScore: bestContract?.score ?? null,
      scoutScore: bestScout?.score ?? null,
    };

    if (bestContract !== null && scores.contract > scores.mine && scores.contract > scores.scout) {
      return {
        kind: "contract",
        contract: bestContract.record,
        detail: decisionDetail("contract", mining.detail, {
          contractId: bestContract.record.contractId,
          ...comparison,
          taskWeight: context.knobs["contract.taskWeight"],
        }),
      };
    }
    // Ties go to scouting over contracts: it spends no credits up front, so an
    // equally-scoring scout is the strictly safer bet.
    if (bestScout !== null && scores.scout > scores.mine && scores.scout >= scores.contract) {
      return {
        kind: "scout",
        scoutWaypoint: bestScout.waypoint,
        detail: decisionDetail("scout", mining.detail, {
          scoutWaypoint: bestScout.waypoint,
          scoutStaleHours: bestScout.elapsedHours,
          ...comparison,
        }),
      };
    }
    if (mining.chosen !== null) {
      return {
        kind: "mine",
        asteroidWaypoint: mining.chosen.waypoint,
        detail: decisionDetail("mine", mining.detail, comparison),
      };
    }
    return {
      kind: "none",
      detail: decisionDetail("none", mining.detail, {
        ...comparison,
        contractsConsidered: acceptedContracts.length,
        marketsConsidered: context.marketplaces.length,
      }),
    };
  }

  /**
   * Scores every asteroid field in the ship's system and picks the best one.
   *
   * A field's revenue estimate comes from cycles completed at that field where
   * there are any, the fleet-wide average where there aren't, and the cold-start
   * prior only when nothing has been mined at all — so a rich field beats a
   * closer poor one once the fleet has flown enough to know the difference.
   */
  private scoreMining(ship: ShipSnapshot, context: DecisionContext): MiningScoring {
    const { model, knobs, routeWaypoints, credits } = context;
    const taskWeight = knobs["mine.taskWeight"];
    const reserveFloor = knobs["credit.reserveFloor"];

    const candidates: PlannerCandidate[] = context.waypoints
      .filter((w) => w.type === "ASTEROID_FIELD")
      .map((asteroid) => {
        // fuel.current bounds the first leg: a fresh assignment can land on a
        // ship that isn't at full tank. fuel.capacity bounds every leg after a
        // refuelling stop.
        const route = fuelAwareRoute(routeWaypoints, ship.nav.waypointSymbol, asteroid.symbol, ship.fuel.current, ship.fuel.capacity);
        if (route === null) return { waypoint: asteroid.symbol, reachable: false };

        const measuredHere = model.creditsPerCycleByWaypoint[asteroid.symbol];
        const creditsPerCycle = measuredHere ?? model.fleetCreditsPerCycle;
        const creditsPerCycleSource: PlannerCandidate["creditsPerCycleSource"] =
          measuredHere !== undefined ? "measured-here" : model.provenance.creditsPerCycle === "measured" ? "fleet-average" : "prior";

        const roundTripDistance = route.distance * 2;
        const { cycleHours: hours, score } = miningScore({
          roundTripDistance,
          creditsPerCycle,
          taskWeight,
          speedUnitsPerHour: model.speedUnitsPerHour,
          overheadHours: model.overheadHours,
        });
        const estimatedFuelCost = roundTripDistance * model.fuelCreditsPerUnitDistance;
        return {
          waypoint: asteroid.symbol,
          reachable: true,
          distance: route.distance,
          cycleHours: hours,
          estimatedFuelCost,
          creditsPerCycle,
          creditsPerCycleSource,
          score,
          breachesReserveFloor: breachesReserveFloor({ currentCredits: credits, estimatedCost: estimatedFuelCost, reserveFloor }),
        };
      });

    const chosen = candidates
      .filter((c): c is Required<PlannerCandidate> =>
        isViableCandidate({ reachable: c.reachable, breachesReserveFloor: c.breachesReserveFloor ?? true, score: c.score ?? 0 })
      )
      .reduce<Required<PlannerCandidate> | null>((best, c) => (best === null || c.score > best.score ? c : best), null);

    return {
      chosen,
      detail: {
        shipSymbol: ship.symbol,
        systemSymbol: context.systemSymbol,
        shipWaypoint: ship.nav.waypointSymbol,
        currentCredits: credits,
        candidates,
        chosen: chosen?.waypoint ?? null,
        knobsUsed: knobs,
        // The calibrated numbers actually scored with, and where each came
        // from. Without this a replay can reproduce the arithmetic but not the
        // beliefs it ran on, which is the half that usually explains a
        // surprising decision.
        model: modelSummary(model),
      },
    };
  }

  /**
   * The best accepted contract nobody is working yet. Gets the same
   * reserve-floor protection mining candidates get: totalPayment minus
   * expectedProfit is procurement plus travel combined, a conservative upper
   * bound on what the contract spends before its payment lands.
   */
  private scoreContracts(accepted: ContractRecord[], context: DecisionContext): { record: ContractRecord; score: number } | null {
    const { knobs, credits } = context;
    let best: { record: ContractRecord; score: number } | null = null;
    for (const record of accepted) {
      if (record.procurementMarket === null) continue; // evaluated as unworkable — nowhere to buy the good
      const estimatedCost = record.totalPayment - record.expectedProfit;
      if (breachesReserveFloor({ currentCredits: credits, estimatedCost, reserveFloor: knobs["credit.reserveFloor"] })) continue;
      // Cycle time is re-derived from the frozen route under the *current*
      // model, not read back as frozen at discovery. Mining is always scored
      // on today's calibration, so a contract evaluated on a cold fleet at the
      // prior speed used to be compared against mining scores that had since
      // doubled — half-fresh and half-stale, and systematically so. What stays
      // frozen is expectedProfit, which depends on market prices this decision
      // has not re-read and so cannot honestly recompute.
      const cycleHoursNow =
        record.travelDistance > 0
          ? cycleHours({
              distance: record.travelDistance,
              speedUnitsPerHour: context.model.speedUnitsPerHour,
              overheadHours: knobs["cycle.transactOverheadHoursPrior"],
            })
          : record.cycleHours; // recorded before travel_distance existed
      const score = contractScore({
        expectedProfit: record.expectedProfit,
        cycleHours: cycleHoursNow,
        taskWeight: knobs["contract.taskWeight"],
      });
      if (score > 0 && (best === null || score > best.score)) best = { record, score };
    }
    return best;
  }

  /**
   * The market most worth a pricing trip. A market's value grows linearly with
   * how long since a ship last read it in person, and drops to zero the moment
   * one does — which is what makes the planner rotate through markets on its
   * own, with no cooldown or round-robin.
   */
  private scoreScouting(
    ship: ShipSnapshot,
    marketIntel: MarketIntel[],
    now: Date,
    context: DecisionContext
  ): { waypoint: string; score: number; elapsedHours: number } | null {
    const { knobs, model, routeWaypoints, credits } = context;
    const creditsPerRefresh = knobs["scout.creditsPerRefresh"];
    const stalenessThresholdHours = knobs["scout.stalenessThresholdHours"];
    if (creditsPerRefresh <= 0 || stalenessThresholdHours <= 0) return null;

    const lastRefreshed = new Map(marketIntel.map((m) => [m.waypoint, m.lastRefreshedAt]));
    let best: { waypoint: string; score: number; elapsedHours: number } | null = null;
    for (const marketplace of context.marketplaces) {
      // A market nobody has ever priced is the most valuable to visit, but the
      // value has to stay finite or it would beat every other kind of work
      // forever. Ten thresholds' worth is "very stale" without being infinite.
      const refreshedAt = lastRefreshed.get(marketplace.symbol);
      const elapsedHours =
        refreshedAt !== undefined ? (now.getTime() - refreshedAt.getTime()) / 3_600_000 : stalenessThresholdHours * 10;
      if (elapsedHours <= 0) continue;

      const route = fuelAwareRoute(routeWaypoints, ship.nav.waypointSymbol, marketplace.symbol, ship.fuel.current, ship.fuel.capacity);
      if (route === null) continue;
      const estimatedCost = route.distance * model.fuelCreditsPerUnitDistance;
      if (breachesReserveFloor({ currentCredits: credits, estimatedCost, reserveFloor: knobs["credit.reserveFloor"] })) continue;

      const { score } = scoutScore({
        distance: route.distance,
        elapsedHours,
        stalenessThresholdHours,
        creditsPerRefresh,
        speedUnitsPerHour: model.speedUnitsPerHour,
        // Not the mining overhead: that is calibrated as the residual of
        // mining cycles, so it includes survey, extraction and cooldown a
        // scout never performs. Charging it here inflated a ten-minute
        // pricing trip to something like half an hour and biased every
        // comparison toward mining, systematically rather than as noise.
        overheadHours: knobs["cycle.transactOverheadHoursPrior"],
      });
      if (score > 0 && (best === null || score > best.score)) best = { waypoint: marketplace.symbol, score, elapsedHours };
    }
    return best;
  }

  /**
   * Is this contract worth accepting? Find the cheapest in-system market
   * selling what it wants, route through there to the delivery point, and
   * subtract. Pure arithmetic over an already-loaded context and already-read
   * markets, so evaluating many contracts costs one fetch of each, not one per
   * contract. Runs once per contract, when it's first seen; the result is
   * frozen into the contract record and scored against mining from then on.
   *
   * v1 simplification: only the contract's first deliverable is evaluated.
   */
  evaluateContract(params: { contract: Contract; ship: ShipSnapshot; context: DecisionContext; markets: MarketData[] }): ContractEvaluation {
    const { contract, ship, context, markets } = params;
    const { model, routeWaypoints } = context;
    const unviable = (reason: string, extra: Record<string, unknown> = {}): ContractEvaluation => ({
      procurementMarket: null,
      expectedProfit: -Infinity,
      cycleHours: 0,
      travelDistance: 0,
      detail: { contractId: contract.id, reason, ...extra },
    });

    const deliverable = contract.terms.deliver[0];
    if (deliverable === undefined) return unviable("no deliverables");

    let cheapest: { waypoint: string; price: number } | null = null;
    for (const market of markets) {
      const good = market.tradeGoods?.find((g) => g.symbol === deliverable.tradeSymbol);
      if (good !== undefined && (cheapest === null || good.purchasePrice < cheapest.price)) {
        cheapest = { waypoint: market.symbol, price: good.purchasePrice };
      }
    }
    if (cheapest === null) return unviable(`no market in ${context.systemSymbol} sells ${deliverable.tradeSymbol}`);

    // fuel.capacity, not fuel.current: this estimates the trip for whichever
    // ship eventually takes the contract, not necessarily the one read here, so
    // a full tank is the right assumption.
    const tank = ship.fuel.capacity;
    const toMarket = fuelAwareRoute(routeWaypoints, ship.nav.waypointSymbol, cheapest.waypoint, tank, tank);
    const toDestination =
      toMarket === null ? null : fuelAwareRoute(routeWaypoints, cheapest.waypoint, deliverable.destinationSymbol, tank, tank);
    if (toMarket === null || toDestination === null) return unviable("unreachable route", { procurementMarket: cheapest.waypoint });

    const unitsRequired = deliverable.unitsRequired - deliverable.unitsFulfilled;
    const travelDistance = toMarket.distance + toDestination.distance;
    // A contract cycle docks, buys, flies and delivers — no survey, no
    // extraction, no cooldown — so it is not charged the mining overhead.
    const hours = cycleHours({
      distance: travelDistance,
      speedUnitsPerHour: model.speedUnitsPerHour,
      overheadHours: context.knobs["cycle.transactOverheadHoursPrior"],
    });
    const travelCost = travelDistance * model.fuelCreditsPerUnitDistance;
    const procurementCost = unitsRequired * cheapest.price;
    const totalPayment = contract.terms.payment.onAccepted + contract.terms.payment.onFulfilled;
    const expectedProfit = totalPayment - procurementCost - travelCost;

    return {
      procurementMarket: cheapest.waypoint,
      expectedProfit,
      cycleHours: hours,
      travelDistance,
      detail: {
        contractId: contract.id,
        tradeSymbol: deliverable.tradeSymbol,
        unitsRequired,
        destinationWaypoint: deliverable.destinationSymbol,
        procurementMarket: cheapest.waypoint,
        procurementPricePerUnit: cheapest.price,
        procurementCost,
        travelDistance,
        travelCost,
        cycleHours: hours,
        totalPayment,
        expectedProfit,
        model: modelSummary(model),
      },
    };
  }
}

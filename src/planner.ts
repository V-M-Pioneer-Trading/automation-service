import { Contract, GameClients, ShipSnapshot } from "./gameClients";
import { KnobRepo } from "./knobs";
import { ContractRecord } from "./contractRepo";
import { fuelAwareRoute, RouteWaypoint } from "./routeCost";

export interface PlannerCandidate {
  waypoint: string;
  reachable: boolean;
  distance?: number;
  cycleHours?: number;
  estimatedFuelCost?: number;
  score?: number;
  breachesReserveFloor?: boolean;
}

export interface PlannerAssignment {
  /** The chosen target, or null if no candidate scored (unreachable, or every reachable one breaches the reserve floor). */
  asteroidWaypoint: string | null;
  /** The chosen candidate's score, or null alongside a null asteroidWaypoint — feeds assignTarget's mining-vs-contract comparison. */
  chosenScore: number | null;
  /** The agent's credit balance at decision time — feeds assignTarget's reserve-floor check for contracts. */
  currentCredits: number;
  /** Every input that went into the decision, logged so it can be replayed. */
  detail: Record<string, unknown>;
}

export interface ContractEvaluation {
  /** Null if no market in the system sells the required good, or no route reaches the destination. */
  procurementMarket: string | null;
  expectedProfit: number;
  cycleHours: number;
  detail: Record<string, unknown>;
}

/**
 * The winning target for a ship that needs one — either a mining field or an
 * accepted-but-unassigned contract, whichever scores higher in the same
 * credits-per-hour units (meta#11).
 */
export type TargetAssignment =
  | { kind: "mine"; asteroidWaypoint: string; detail: Record<string, unknown> }
  | {
      kind: "contract";
      contractId: string;
      tradeSymbol: string;
      destinationWaypoint: string;
      unitsRequired: number;
      procurementMarket: string;
      detail: Record<string, unknown>;
    }
  | { kind: "none"; detail: Record<string, unknown> };

/**
 * Scores every asteroid field in the ship's system by expected credits/hour —
 * fuel-aware route cost to and from it, weighted per knob-configured task
 * weight — and picks the highest-scoring one that doesn't breach the credit
 * reserve floor. v1 simplification: revenue is a flat knob-configured estimate
 * per cycle (`mine.expectedCreditsPerCycle`), not yet derived from real
 * per-good yield and market price data — see automation-service/README.md.
 */
export class Planner {
  constructor(private clients: GameClients, private knobs: KnobRepo) {}

  async assignMiningTarget(params: {
    ship: ShipSnapshot;
    systemSymbol: string;
    authHeader: string;
  }): Promise<PlannerAssignment> {
    const { ship, systemSymbol, authHeader } = params;

    const [rawWaypoints, agent, knobValues] = await Promise.all([
      this.clients.getSystemWaypoints(systemSymbol, authHeader),
      this.clients.getAgent(authHeader),
      this.knobs.getAll(),
    ]);
    const knob = (name: string): number => {
      const found = knobValues.find((k) => k.name === name);
      if (found === undefined) throw new Error(`planner requires knob "${name}" to exist`);
      return found.value;
    };

    const routeWaypoints: RouteWaypoint[] = rawWaypoints.map((w) => ({
      symbol: w.symbol,
      x: w.x,
      y: w.y,
      hasFuelStation: w.traits.some((t) => t.symbol === "MARKETPLACE"),
    }));
    const asteroids = rawWaypoints.filter((w) => w.type === "ASTEROID_FIELD");

    const taskWeight = knob("mine.taskWeight");
    const expectedCreditsPerCycle = knob("mine.expectedCreditsPerCycle");
    const speed = knob("travel.speedUnitsPerHour");
    const fixedOverheadHours = knob("cycle.fixedOverheadHours");
    const fuelCreditsPerUnitDistance = knob("fuel.creditsPerUnitDistance");
    const reserveFloor = knob("credit.reserveFloor");

    const candidates: PlannerCandidate[] = asteroids.map((asteroid) => {
      // fuel.current, not fuel.capacity: a fresh task can be assigned to a ship
      // that isn't at full tank, and only the fuel actually on board bounds what
      // the first leg can reach. (After every cycle the ship is at full tank —
      // dispatchSell always refuels before mining_cycle_complete fires — so this
      // only matters for the very first assignment of a ship's lifetime.)
      const route = fuelAwareRoute(routeWaypoints, ship.nav.waypointSymbol, asteroid.symbol, ship.fuel.current);
      if (route === null) return { waypoint: asteroid.symbol, reachable: false };

      const roundTripDistance = route.distance * 2;
      const cycleHours = roundTripDistance / speed + fixedOverheadHours;
      const estimatedFuelCost = roundTripDistance * fuelCreditsPerUnitDistance;
      const revenue = expectedCreditsPerCycle * taskWeight;
      const score = cycleHours > 0 ? revenue / cycleHours : 0;
      const breachesReserveFloor = agent.credits - estimatedFuelCost < reserveFloor;

      return {
        waypoint: asteroid.symbol,
        reachable: true,
        distance: route.distance,
        cycleHours,
        estimatedFuelCost,
        score,
        breachesReserveFloor,
      };
    });

    const viable = candidates.filter(
      (c): c is Required<PlannerCandidate> => c.reachable && c.breachesReserveFloor === false
    );
    const chosen = viable.reduce<Required<PlannerCandidate> | null>(
      (best, c) => (best === null || c.score > best.score ? c : best),
      null
    );

    return {
      asteroidWaypoint: chosen?.waypoint ?? null,
      chosenScore: chosen?.score ?? null,
      currentCredits: agent.credits,
      detail: {
        shipSymbol: ship.symbol,
        systemSymbol,
        shipWaypoint: ship.nav.waypointSymbol,
        currentCredits: agent.credits,
        candidates,
        chosen: chosen?.waypoint ?? null,
        knobsUsed: Object.fromEntries(knobValues.map((k) => [k.name, k.value])),
      },
    };
  }

  /**
   * The winning target for a ship that needs one (meta#11) — compares the best
   * mining candidate's score against every accepted-but-unassigned contract's
   * score (computed once at evaluation time, not recomputed here) in the same
   * credits-per-hour units, and returns whichever is higher.
   */
  async assignTarget(params: {
    ship: ShipSnapshot;
    systemSymbol: string;
    authHeader: string;
    acceptedContracts: ContractRecord[];
  }): Promise<TargetAssignment> {
    const { ship, systemSymbol, authHeader, acceptedContracts } = params;
    const [miningResult, taskWeight, reserveFloor] = await Promise.all([
      this.assignMiningTarget({ ship, systemSymbol, authHeader }),
      this.knobs.get("contract.taskWeight"),
      this.knobs.get("credit.reserveFloor"),
    ]);

    // Same reserve-floor protection mining candidates get via breachesReserveFloor:
    // totalPayment - expectedProfit is procurementCost + travelCost combined (the
    // ContractRecord doesn't break those out separately), so this is a conservative
    // upper bound on what accepting would actually spend before payment lands.
    let best: { record: ContractRecord; score: number } | null = null;
    for (const record of acceptedContracts) {
      const estimatedCost = record.totalPayment - record.expectedProfit;
      if (miningResult.currentCredits - estimatedCost < reserveFloor) continue;
      const score = record.cycleHours > 0 ? (record.expectedProfit * taskWeight) / record.cycleHours : 0;
      if (best === null || score > best.score) best = { record, score };
    }

    const miningScore = miningResult.chosenScore;
    const contractWins = best !== null && (miningResult.asteroidWaypoint === null || best.score > (miningScore ?? -Infinity));

    if (contractWins && best !== null && best.record.procurementMarket !== null) {
      return {
        kind: "contract",
        contractId: best.record.contractId,
        tradeSymbol: best.record.tradeSymbol,
        destinationWaypoint: best.record.destinationWaypoint,
        unitsRequired: best.record.unitsRequired,
        procurementMarket: best.record.procurementMarket,
        detail: {
          contractId: best.record.contractId,
          contractScore: best.score,
          miningScore,
          taskWeight,
          miningDetail: miningResult.detail,
        },
      };
    }

    if (miningResult.asteroidWaypoint !== null) {
      return { kind: "mine", asteroidWaypoint: miningResult.asteroidWaypoint, detail: miningResult.detail };
    }

    // Flattened (not nested under miningDetail) so existing consumers of a
    // pure-mining planner_assignment event — e.g. reading detail.candidates —
    // keep working unchanged when there are no contracts in the picture.
    return {
      kind: "none",
      detail: { ...miningResult.detail, contractsConsidered: acceptedContracts.length },
    };
  }

  /**
   * Deterministic profitability evaluation for one contract: cheapest market
   * in-system selling the required good, fuel-aware route cost from the ship's
   * position through that market to the delivery destination, weighed against
   * the contract's total payment. v1 simplification: only the contract's first
   * deliverable is evaluated — see README.
   */
  async evaluateContract(params: {
    contract: Contract;
    ship: ShipSnapshot;
    systemSymbol: string;
    authHeader: string;
  }): Promise<ContractEvaluation> {
    const { contract, ship, systemSymbol, authHeader } = params;
    const deliverable = contract.terms.deliver[0];
    if (deliverable === undefined) {
      return { procurementMarket: null, expectedProfit: -Infinity, cycleHours: 0, detail: { contractId: contract.id, reason: "no deliverables" } };
    }

    const [rawWaypoints, knobValues] = await Promise.all([
      this.clients.getSystemWaypoints(systemSymbol, authHeader),
      this.knobs.getAll(),
    ]);
    const knob = (name: string): number => {
      const found = knobValues.find((k) => k.name === name);
      if (found === undefined) throw new Error(`planner requires knob "${name}" to exist`);
      return found.value;
    };

    const routeWaypoints: RouteWaypoint[] = rawWaypoints.map((w) => ({
      symbol: w.symbol,
      x: w.x,
      y: w.y,
      hasFuelStation: w.traits.some((t) => t.symbol === "MARKETPLACE"),
    }));
    const marketplaces = rawWaypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE"));

    // Independent per-marketplace lookups — now on the critical ship-dispatch
    // path (assignTarget calls this via discoverAndEvaluateContracts), so a
    // system with many marketplaces no longer pays for them one at a time.
    const markets = await Promise.all(marketplaces.map((w) => this.clients.getMarket(w.symbol, authHeader)));
    let cheapest: { waypoint: string; price: number } | null = null;
    for (let i = 0; i < marketplaces.length; i++) {
      const good = markets[i].tradeGoods?.find((g) => g.symbol === deliverable.tradeSymbol);
      if (good !== undefined && (cheapest === null || good.purchasePrice < cheapest.price)) {
        cheapest = { waypoint: marketplaces[i].symbol, price: good.purchasePrice };
      }
    }
    if (cheapest === null) {
      return {
        procurementMarket: null,
        expectedProfit: -Infinity,
        cycleHours: 0,
        detail: { contractId: contract.id, reason: `no market in ${systemSymbol} sells ${deliverable.tradeSymbol}` },
      };
    }

    const unitsRequired = deliverable.unitsRequired - deliverable.unitsFulfilled;
    // ship.fuel.capacity, not fuel.current: this is a planning-time estimate for
    // whichever ship eventually takes the contract, not necessarily the one
    // fetched here — a full tank is the reasonable assumption to evaluate against.
    const toMarket = fuelAwareRoute(routeWaypoints, ship.nav.waypointSymbol, cheapest.waypoint, ship.fuel.capacity);
    const toDestination =
      toMarket === null ? null : fuelAwareRoute(routeWaypoints, cheapest.waypoint, deliverable.destinationSymbol, ship.fuel.capacity);
    if (toMarket === null || toDestination === null) {
      return {
        procurementMarket: null,
        expectedProfit: -Infinity,
        cycleHours: 0,
        detail: { contractId: contract.id, reason: "unreachable route", procurementMarket: cheapest.waypoint },
      };
    }

    const speed = knob("travel.speedUnitsPerHour");
    const fixedOverheadHours = knob("cycle.fixedOverheadHours");
    const fuelCreditsPerUnitDistance = knob("fuel.creditsPerUnitDistance");

    const travelDistance = toMarket.distance + toDestination.distance;
    const cycleHours = travelDistance / speed + fixedOverheadHours;
    const travelCost = travelDistance * fuelCreditsPerUnitDistance;
    const procurementCost = unitsRequired * cheapest.price;
    const totalPayment = contract.terms.payment.onAccepted + contract.terms.payment.onFulfilled;
    const expectedProfit = totalPayment - procurementCost - travelCost;

    return {
      procurementMarket: cheapest.waypoint,
      expectedProfit,
      cycleHours,
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
        cycleHours,
        totalPayment,
        expectedProfit,
      },
    };
  }
}

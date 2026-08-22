import { Contract, GameClients, ShipSnapshot, WaypointSummary } from "./gameClients";
import { KnobRepo } from "./knobs";
import { ContractRecord } from "./contractRepo";
import { MarketIntel } from "./marketIntelRepo";
import { CalibratedModel, ObservationRepo } from "./observations";
import { fuelAwareRoute, RouteWaypoint } from "./routeCost";
import { breachesReserveFloor, cycleHours, contractScore, miningScore, scoutScore } from "./scoring";

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
 */

export interface PlannerCandidate {
  waypoint: string;
  reachable: boolean;
  distance?: number;
  cycleHours?: number;
  estimatedFuelCost?: number;
  /** What one cycle here is expected to earn, and whether that's measured or assumed. */
  creditsPerCycle?: number;
  creditsPerCycleSource?: "measured-here" | "fleet-average" | "prior";
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

/** The winning target for a ship that needs one. */
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
  | { kind: "scout"; scoutWaypoint: string; detail: Record<string, unknown> }
  | { kind: "none"; detail: Record<string, unknown> };

/** Everything the planner needs to score, fetched once per decision. */
interface DecisionContext {
  waypoints: WaypointSummary[];
  routeWaypoints: RouteWaypoint[];
  credits: number;
  knobs: Record<string, number>;
  model: CalibratedModel;
}

const toRouteWaypoints = (waypoints: WaypointSummary[]): RouteWaypoint[] =>
  waypoints.map((w) => ({
    symbol: w.symbol,
    x: w.x,
    y: w.y,
    hasFuelStation: w.traits.some((t) => t.symbol === "MARKETPLACE"),
  }));

const isMarketplace = (w: WaypointSummary): boolean => w.traits.some((t) => t.symbol === "MARKETPLACE");

export class Planner {
  constructor(private clients: GameClients, private knobs: KnobRepo, private observations: ObservationRepo) {}

  /**
   * One fetch of everything a decision depends on. Gathered here rather than
   * inside each scoring path so a single assignment costs one waypoint lookup
   * and one calibration, and so every task kind is scored against exactly the
   * same snapshot of the world.
   */
  private async loadContext(systemSymbol: string, spaceTradersToken: string): Promise<DecisionContext> {
    const [waypoints, agent, knobs] = await Promise.all([
      this.clients.getSystemWaypoints(systemSymbol, spaceTradersToken),
      this.clients.getAgent(spaceTradersToken),
      this.knobs.getValues(),
    ]);

    const requireKnob = (name: string): number => {
      const value = knobs[name];
      if (value === undefined) throw new Error(`planner requires knob "${name}" to exist`);
      return value;
    };

    const model = await this.observations.calibrate({
      creditsPerCyclePrior: requireKnob("mine.creditsPerCyclePrior"),
      speedUnitsPerHourPrior: requireKnob("travel.speedUnitsPerHourPrior"),
      overheadHoursPrior: requireKnob("cycle.overheadHoursPrior"),
      fuelCreditsPerUnitDistancePrior: requireKnob("fuel.creditsPerUnitDistancePrior"),
      halfLifeHours: requireKnob("observation.halfLifeHours"),
    });

    return {
      waypoints,
      routeWaypoints: toRouteWaypoints(waypoints),
      credits: agent.credits,
      knobs,
      model,
    };
  }

  /**
   * Scores every asteroid field in the ship's system and picks the best one.
   *
   * A field's revenue estimate comes from cycles completed at that field where
   * there are any, the fleet-wide average where there aren't, and the cold-start
   * prior only when nothing has been mined at all — so a rich field beats a
   * closer poor one once the fleet has flown enough to know the difference.
   *
   * Takes an already-loaded context rather than fetching its own: mining is
   * always scored as one arm of `assignTarget`'s comparison, and every arm has
   * to be scored against the same snapshot of the world for the comparison to
   * mean anything.
   */
  private scoreMining(ship: ShipSnapshot, systemSymbol: string, context: DecisionContext): PlannerAssignment {
    const { model, knobs, routeWaypoints, credits } = context;
    const asteroids = context.waypoints.filter((w) => w.type === "ASTEROID_FIELD");

    const taskWeight = knobs["mine.taskWeight"];
    const reserveFloor = knobs["credit.reserveFloor"];

    const candidates: PlannerCandidate[] = asteroids.map((asteroid) => {
      // fuel.current bounds the first leg: a fresh assignment can land on a ship
      // that isn't at full tank. fuel.capacity bounds every leg after a
      // refuelling stop. (After a completed cycle the ship is always full —
      // dispatchSell refuels before handing back to the planner — so the
      // distinction only bites on a ship's very first assignment.)
      const route = fuelAwareRoute(
        routeWaypoints,
        ship.nav.waypointSymbol,
        asteroid.symbol,
        ship.fuel.current,
        ship.fuel.capacity
      );
      if (route === null) return { waypoint: asteroid.symbol, reachable: false };

      const measuredHere = model.creditsPerCycleByWaypoint[asteroid.symbol];
      const creditsPerCycle = measuredHere ?? model.fleetCreditsPerCycle;
      const creditsPerCycleSource: PlannerCandidate["creditsPerCycleSource"] =
        measuredHere !== undefined
          ? "measured-here"
          : model.provenance.creditsPerCycle === "measured"
            ? "fleet-average"
            : "prior";

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
        breachesReserveFloor: breachesReserveFloor({
          currentCredits: credits,
          estimatedCost: estimatedFuelCost,
          reserveFloor,
        }),
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
      currentCredits: credits,
      detail: {
        shipSymbol: ship.symbol,
        systemSymbol,
        shipWaypoint: ship.nav.waypointSymbol,
        currentCredits: credits,
        candidates,
        chosen: chosen?.waypoint ?? null,
        knobsUsed: knobs,
        // The calibrated numbers actually scored with, and where each came
        // from. Without this a replay can reproduce the arithmetic but not the
        // beliefs it ran on, which is the half that usually explains a
        // surprising decision.
        model: {
          speedUnitsPerHour: model.speedUnitsPerHour,
          overheadHours: model.overheadHours,
          fuelCreditsPerUnitDistance: model.fuelCreditsPerUnitDistance,
          fleetCreditsPerCycle: model.fleetCreditsPerCycle,
          provenance: model.provenance,
        },
      },
    };
  }

  /**
   * The winning target for a ship that needs one — the best mining field, the
   * best accepted-but-unassigned contract, and the most worthwhile market to
   * re-price, compared in the same credits-per-hour units.
   */
  async assignTarget(params: {
    ship: ShipSnapshot;
    systemSymbol: string;
    spaceTradersToken: string;
    acceptedContracts: ContractRecord[];
    /** Market freshness snapshot — drives scout staleness scoring. */
    marketIntel: MarketIntel[];
    /** Decision time — needed to compute market staleness. */
    now: Date;
  }): Promise<TargetAssignment> {
    const { ship, systemSymbol, spaceTradersToken, acceptedContracts, marketIntel, now } = params;

    const context = await this.loadContext(systemSymbol, spaceTradersToken);
    const { knobs, model, routeWaypoints, credits } = context;
    const miningResult = this.scoreMining(ship, systemSymbol, context);

    const reserveFloor = knobs["credit.reserveFloor"];

    // --- Contracts ---
    // Same reserve-floor protection mining candidates get: totalPayment minus
    // expectedProfit is procurement plus travel combined (the ContractRecord
    // doesn't break them out), so it's a conservative upper bound on what
    // accepting would spend before the payment lands.
    let bestContract: { record: ContractRecord; score: number } | null = null;
    for (const record of acceptedContracts) {
      const estimatedCost = record.totalPayment - record.expectedProfit;
      if (breachesReserveFloor({ currentCredits: credits, estimatedCost, reserveFloor })) continue;
      const score = contractScore({
        expectedProfit: record.expectedProfit,
        cycleHours: record.cycleHours,
        taskWeight: knobs["contract.taskWeight"],
      });
      if (bestContract === null || score > bestContract.score) bestContract = { record, score };
    }

    // --- Scouting ---
    const creditsPerRefresh = knobs["scout.creditsPerRefresh"];
    const stalenessThresholdHours = knobs["scout.stalenessThresholdHours"];
    const marketplaces = context.waypoints.filter(isMarketplace);
    const nowMs = now.getTime();

    let bestScout: { waypoint: string; score: number; elapsedHours: number } | null = null;
    if (creditsPerRefresh > 0 && stalenessThresholdHours > 0) {
      for (const marketplace of marketplaces) {
        const intel = marketIntel.find((m) => m.waypoint === marketplace.symbol);
        // A market nobody has ever priced is the most valuable to visit, but the
        // value has to stay finite or it would beat every other kind of work
        // forever. Ten thresholds' worth is "very stale" without being infinite.
        const elapsedHours =
          intel !== undefined
            ? (nowMs - intel.lastRefreshedAt.getTime()) / 3_600_000
            : stalenessThresholdHours * 10;
        if (elapsedHours <= 0) continue;

        const route = fuelAwareRoute(
          routeWaypoints,
          ship.nav.waypointSymbol,
          marketplace.symbol,
          ship.fuel.current,
          ship.fuel.capacity
        );
        if (route === null) continue;
        const estimatedCost = route.distance * model.fuelCreditsPerUnitDistance;
        if (breachesReserveFloor({ currentCredits: credits, estimatedCost, reserveFloor })) continue;

        const { score } = scoutScore({
          distance: route.distance,
          elapsedHours,
          stalenessThresholdHours,
          creditsPerRefresh,
          speedUnitsPerHour: model.speedUnitsPerHour,
          overheadHours: model.overheadHours,
        });
        if (bestScout === null || score > bestScout.score) {
          bestScout = { waypoint: marketplace.symbol, score, elapsedHours };
        }
      }
    }

    // --- Pick the highest-scoring task kind ---
    const miningScoreValue = miningResult.chosenScore;
    const scores = {
      contract: bestContract?.score ?? -Infinity,
      scout: bestScout?.score ?? -Infinity,
      mine: miningScoreValue ?? -Infinity,
    };

    const contractWins = bestContract !== null && scores.contract > scores.mine && scores.contract > scores.scout;
    // Ties go to scouting over contracts: it spends no credits up front, so an
    // equally-scoring scout is the strictly safer bet.
    const scoutWins = bestScout !== null && scores.scout > scores.mine && scores.scout >= scores.contract;

    const comparison = {
      miningScore: miningScoreValue,
      contractScore: bestContract?.score ?? null,
      scoutScore: bestScout?.score ?? null,
    };

    if (contractWins && bestContract !== null && bestContract.record.procurementMarket !== null) {
      return {
        kind: "contract",
        contractId: bestContract.record.contractId,
        tradeSymbol: bestContract.record.tradeSymbol,
        destinationWaypoint: bestContract.record.destinationWaypoint,
        unitsRequired: bestContract.record.unitsRequired,
        procurementMarket: bestContract.record.procurementMarket,
        detail: {
          chosenKind: "contract",
          contractId: bestContract.record.contractId,
          ...comparison,
          taskWeight: knobs["contract.taskWeight"],
          miningDetail: miningResult.detail,
        },
      };
    }

    if (scoutWins && bestScout !== null) {
      return {
        kind: "scout",
        scoutWaypoint: bestScout.waypoint,
        detail: {
          chosenKind: "scout",
          scoutWaypoint: bestScout.waypoint,
          scoutStaleHours: bestScout.elapsedHours,
          ...comparison,
          miningDetail: miningResult.detail,
        },
      };
    }

    if (miningResult.asteroidWaypoint !== null) {
      return {
        kind: "mine",
        asteroidWaypoint: miningResult.asteroidWaypoint,
        detail: { chosenKind: "mine", ...miningResult.detail, ...comparison },
      };
    }

    // Flattened (not nested under miningDetail) so consumers reading
    // detail.candidates keep working when there are no contracts or scouts in
    // the picture — replay.ts relies on that shape.
    return {
      kind: "none",
      detail: {
        chosenKind: "none",
        ...miningResult.detail,
        ...comparison,
        contractsConsidered: acceptedContracts.length,
        marketsConsidered: marketplaces.length,
      },
    };
  }

  /**
   * Is this contract worth accepting? Find the cheapest in-system market
   * selling what it wants, route through there to the delivery point, and
   * subtract. Runs once per contract, when it's first seen; the result is
   * frozen into the contract record and scored against mining from then on.
   *
   * v1 simplification: only the contract's first deliverable is evaluated.
   */
  async evaluateContract(params: {
    contract: Contract;
    ship: ShipSnapshot;
    systemSymbol: string;
    spaceTradersToken: string;
  }): Promise<ContractEvaluation> {
    const { contract, ship, systemSymbol, spaceTradersToken } = params;
    const deliverable = contract.terms.deliver[0];
    if (deliverable === undefined) {
      return {
        procurementMarket: null,
        expectedProfit: -Infinity,
        cycleHours: 0,
        detail: { contractId: contract.id, reason: "no deliverables" },
      };
    }

    const context = await this.loadContext(systemSymbol, spaceTradersToken);
    const { model, routeWaypoints } = context;
    const marketplaces = context.waypoints.filter(isMarketplace);

    // Independent per-marketplace lookups, and this sits on the critical
    // ship-dispatch path — a system with many marketplaces shouldn't pay for
    // them one at a time.
    const markets = await Promise.all(marketplaces.map((w) => this.clients.getMarket(w.symbol, spaceTradersToken)));
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
        detail: {
          contractId: contract.id,
          reason: `no market in ${systemSymbol} sells ${deliverable.tradeSymbol}`,
        },
      };
    }

    const unitsRequired = deliverable.unitsRequired - deliverable.unitsFulfilled;
    // fuel.capacity, not fuel.current: this estimates the trip for whichever
    // ship eventually takes the contract, not necessarily the one read here, so
    // a full tank is the right assumption.
    const toMarket = fuelAwareRoute(
      routeWaypoints,
      ship.nav.waypointSymbol,
      cheapest.waypoint,
      ship.fuel.capacity,
      ship.fuel.capacity
    );
    const toDestination =
      toMarket === null
        ? null
        : fuelAwareRoute(
            routeWaypoints,
            cheapest.waypoint,
            deliverable.destinationSymbol,
            ship.fuel.capacity,
            ship.fuel.capacity
          );
    if (toMarket === null || toDestination === null) {
      return {
        procurementMarket: null,
        expectedProfit: -Infinity,
        cycleHours: 0,
        detail: { contractId: contract.id, reason: "unreachable route", procurementMarket: cheapest.waypoint },
      };
    }

    const travelDistance = toMarket.distance + toDestination.distance;
    const hours = cycleHours({
      distance: travelDistance,
      speedUnitsPerHour: model.speedUnitsPerHour,
      overheadHours: model.overheadHours,
    });
    const travelCost = travelDistance * model.fuelCreditsPerUnitDistance;
    const procurementCost = unitsRequired * cheapest.price;
    const totalPayment = contract.terms.payment.onAccepted + contract.terms.payment.onFulfilled;
    const expectedProfit = totalPayment - procurementCost - travelCost;

    return {
      procurementMarket: cheapest.waypoint,
      expectedProfit,
      cycleHours: hours,
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
        model: {
          speedUnitsPerHour: model.speedUnitsPerHour,
          overheadHours: model.overheadHours,
          fuelCreditsPerUnitDistance: model.fuelCreditsPerUnitDistance,
          provenance: model.provenance,
        },
      },
    };
  }
}

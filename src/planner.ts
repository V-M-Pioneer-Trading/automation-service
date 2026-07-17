import { GameClients, ShipSnapshot } from "./gameClients";
import { KnobRepo } from "./knobs";
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
  /** Every input that went into the decision, logged so it can be replayed. */
  detail: Record<string, unknown>;
}

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
}

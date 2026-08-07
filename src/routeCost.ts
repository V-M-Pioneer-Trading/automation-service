export interface RouteWaypoint {
  symbol: string;
  x: number;
  y: number;
  /** Can the ship refuel to full here before its next leg? In practice, a MARKETPLACE trait. */
  hasFuelStation: boolean;
}

export interface RouteResult {
  distance: number;
}

const legDistance = (a: RouteWaypoint, b: RouteWaypoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Shortest reachable path between two waypoints, respecting fuel.
 *
 * Worth knowing what this actually does, because the name oversells it: in
 * SpaceTraders every waypoint is directly reachable from every other, and legs
 * cost Euclidean distance. The triangle inequality therefore guarantees the
 * direct hop is always the *shortest* route — a detour is never cheaper. So
 * this search is really answering **"can the ship get there, and if it needs
 * refuelling stops, what do they cost?"** It only does interesting work when
 * the direct hop is out of fuel range.
 *
 * The two fuel constraints:
 *  - a single leg longer than the tank being flown on is infeasible;
 *  - a ship can only top up at a waypoint with a fuel station, so an
 *    intermediate stop must have one. The final destination is the one place
 *    it's fine to arrive dry.
 *
 * `initialFuel` and `tankCapacity` are separate because they genuinely differ:
 * the first leg flies on whatever is in the tank right now, but every leg after
 * a refuelling stop flies on a full one. Passing current fuel for both would
 * understate the ship's range for the entire rest of the route.
 */
export function fuelAwareRoute(
  waypoints: RouteWaypoint[],
  fromSymbol: string,
  toSymbol: string,
  initialFuel: number,
  tankCapacity: number = initialFuel
): RouteResult | null {
  const bySymbol = new Map(waypoints.map((w) => [w.symbol, w]));
  const from = bySymbol.get(fromSymbol);
  const to = bySymbol.get(toSymbol);
  if (from === undefined || to === undefined) return null;
  if (fromSymbol === toSymbol) return { distance: 0 };

  const best = new Map<string, number>([[fromSymbol, 0]]);
  const settled = new Set<string>();

  for (;;) {
    let currentSymbol: string | null = null;
    let currentCost = Infinity;
    for (const [symbol, cost] of best) {
      if (!settled.has(symbol) && cost < currentCost) {
        currentCost = cost;
        currentSymbol = symbol;
      }
    }
    if (currentSymbol === null) return null; // exhausted the reachable set without finding the target

    if (currentSymbol === toSymbol) return { distance: currentCost };
    settled.add(currentSymbol);

    const current = bySymbol.get(currentSymbol)!;
    if (currentSymbol !== fromSymbol && !current.hasFuelStation) continue; // dead end: can't refuel to go further

    // Leaving the origin the ship flies on the fuel it has; leaving anywhere
    // else means it stopped to refuel first, so it leaves with a full tank.
    const rangeFromHere = currentSymbol === fromSymbol ? initialFuel : tankCapacity;

    for (const candidate of waypoints) {
      if (settled.has(candidate.symbol)) continue;
      const distance = legDistance(current, candidate);
      if (distance > rangeFromHere) continue; // out of range for a single leg
      const candidateCost = currentCost + distance;
      const known = best.get(candidate.symbol);
      if (known === undefined || candidateCost < known) {
        best.set(candidate.symbol, candidateCost);
      }
    }
  }
}

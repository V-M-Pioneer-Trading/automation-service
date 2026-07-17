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
 * Fuel-aware shortest path over the system's waypoint graph (Dijkstra). Every
 * waypoint is directly reachable from every other (SpaceTraders navigation isn't
 * restricted to a fixed lane graph), but a leg longer than the ship's fuel tank
 * is infeasible, and a ship can only refuel to full at a waypoint with a fuel
 * station — so a multi-leg route may only pass through fuel-station waypoints
 * except at its final destination.
 */
export function fuelAwareRoute(
  waypoints: RouteWaypoint[],
  fromSymbol: string,
  toSymbol: string,
  fuelCapacity: number
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

    for (const candidate of waypoints) {
      if (settled.has(candidate.symbol)) continue;
      const distance = legDistance(current, candidate);
      if (distance > fuelCapacity) continue; // out of range for a single leg
      const candidateCost = currentCost + distance;
      const known = best.get(candidate.symbol);
      if (known === undefined || candidateCost < known) {
        best.set(candidate.symbol, candidateCost);
      }
    }
  }
}

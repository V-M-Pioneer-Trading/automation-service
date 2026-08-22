import { Clock } from "./clock";
import { GameClients, ShipSnapshot } from "./gameClients";
import { TickResult, travelTo, withPhase } from "./miningTask";
import { ShipTask } from "./shipTaskRepo";

/**
 * Advances one ship's scouting FSM by exactly one atomic action per call (meta#12).
 * Two phases: travel to the target market, then dock and call getMarket to refresh
 * the intel cache. Travel reuses miningTask's travelTo helper — behavior is identical
 * regardless of what the ship is traveling for.
 */
export async function advanceScoutTask(params: {
  task: ShipTask;
  ship: ShipSnapshot;
  scoutWaypoint: string;
  clients: GameClients;
  clock: Clock;
  spaceTradersToken: string;
}): Promise<TickResult | null> {
  const { task, ship, scoutWaypoint, clients, clock, spaceTradersToken } = params;
  const now = clock.now();

  if (task.waitingUntil !== null) {
    if (now < task.waitingUntil) return null;
    const next: ShipTask["phase"] = task.phase === "SCOUT_TRAVEL" ? "SCOUT_REFRESH" : task.phase;
    return {
      task: withPhase(task, next),
      event: "scout_wait_resolved",
      detail: { shipSymbol: task.shipSymbol, from: task.phase, to: next },
    };
  }

  switch (task.phase) {
    case "SCOUT_TRAVEL":
      return travelTo(task, ship, scoutWaypoint, clients, spaceTradersToken, "SCOUT_REFRESH", "scout");
    case "SCOUT_REFRESH":
      return dispatchRefresh(task, ship, scoutWaypoint, clients, spaceTradersToken);
    default:
      return null; // a mining or contract phase reached here would be a caller bug
  }
}

async function dispatchRefresh(
  task: ShipTask,
  ship: ShipSnapshot,
  scoutWaypoint: string,
  clients: GameClients,
  spaceTradersToken: string
): Promise<TickResult> {
  if (ship.nav.status !== "DOCKED") {
    await clients.dock(task.shipSymbol, spaceTradersToken);
    return { task, event: "scout_dock", detail: { shipSymbol: task.shipSymbol } };
  }
  const market = await clients.getMarket(scoutWaypoint, spaceTradersToken);
  return {
    task,
    event: "scout_market_refresh",
    detail: { shipSymbol: task.shipSymbol, waypoint: scoutWaypoint, tradeGoodsCount: market.tradeGoods?.length ?? 0 },
  };
}

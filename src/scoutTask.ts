import { idleTask } from "./shipTaskRepo";
import { dockIfNeeded, refuelIfNeeded, requireTarget, resolveWaitIfElapsed, TaskContext, TickResult, travelTo } from "./taskFsm";

/**
 * SCOUT_TRAVEL → SCOUT_REFRESH → idle
 *
 * Fly to the target market, dock, and read its prices — SpaceTraders only
 * reports trade goods to a ship that is physically there, which is what makes
 * this a refresh rather than a cache read. The scout target rides in
 * `task.asteroidWaypoint`, the column every task kind uses for "where the
 * planner sent me".
 */
export async function advanceScoutTask(ctx: TaskContext): Promise<TickResult | null> {
  const waiting = resolveWaitIfElapsed(ctx, "scout");
  if (waiting !== undefined) return waiting;

  const market = requireTarget(ctx.task.asteroidWaypoint, "scout target");
  switch (ctx.task.phase) {
    case "SCOUT_TRAVEL":
      return travelTo(ctx, market, "SCOUT_REFRESH", "scout");
    case "SCOUT_REFRESH":
      return dispatchRefresh(ctx, market);
    default:
      throw new Error(`scout task cannot advance from phase ${ctx.task.phase}`);
  }
}

async function dispatchRefresh(ctx: TaskContext, market: string): Promise<TickResult> {
  const { task, clients} = ctx;
  const docking = await dockIfNeeded(ctx, "scout");
  if (docking !== null) return docking;
  // Already docked at a marketplace: the cheapest possible moment to top up.
  const refuel = await refuelIfNeeded(ctx, "scout");
  if (refuel !== null) return refuel;

  const data = await clients.getMarket(market);
  return {
    task: idleTask(task),
    event: "scout_market_refresh",
    detail: { shipSymbol: task.shipSymbol, waypoint: market, tradeGoodsCount: data.tradeGoods?.length ?? 0 },
    observations: { marketsRefreshed: [market] },
  };
}

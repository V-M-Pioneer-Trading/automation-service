import { idleTask, ShipTask } from "./shipTaskRepo";
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

/**
 * Never. A scout docks, reads prices and leaves; it buys nothing and extracts
 * nothing, so there is never cargo to strand by abandoning its target.
 *
 * Worth stating rather than inheriting. The scheduler used to apply mining's
 * rule — `tradeSymbol !== null` — to every non-contract task, which gave the
 * right answer for a scout only because nothing sets that column on one. A
 * scout row that somehow carried a `tradeSymbol` would have been retried on the
 * same target forever, on the strength of cargo it cannot hold.
 *
 * Takes the task it ignores, so all three predicates share one shape.
 */
export const scoutCargoAtStake = (_task: ShipTask): boolean => false;

/**
 * The opening task for a ship the planner has sent to refresh a market.
 *
 * The target rides in `asteroidWaypoint` — the column every kind uses for
 * "where the planner sent me" — which is exactly the sort of per-kind meaning
 * that belongs next to the FSM reading it rather than in the scheduler.
 */
export const startScoutTask = (task: ShipTask, targetWaypoint: string): ShipTask => ({
  ...idleTask(task),
  taskKind: "scout",
  phase: "SCOUT_TRAVEL",
  asteroidWaypoint: targetWaypoint,
});

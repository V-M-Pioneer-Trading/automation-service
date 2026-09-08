import { GameClients } from "./gameClients";
import { idleTask, ShipTask } from "./shipTaskRepo";
import {
  dockIfNeeded,
  refuelIfNeeded,
  requireTarget,
  resolveWaitIfElapsed,
  TaskContext,
  TickResult,
  travelTo,
  withPhase,
  withWait,
} from "./taskFsm";

/**
 * TRAVEL_TO_ASTEROID → SURVEY → EXTRACT → TRAVEL_TO_MARKET → SELL → (refuel) → idle
 *
 * The sell leg queries every in-system marketplace and picks the best price for
 * what's in the hold. A survey can yield several goods before cargo fills, so
 * SELL sells whatever the current market buys and then re-shops for a market
 * that takes the rest, until the hold is empty. On completion the cycle's
 * takings become one mining observation and the ship hands itself back to the
 * planner.
 */
export async function advanceMiningTask(ctx: TaskContext): Promise<TickResult | null> {
  const waiting = resolveWaitIfElapsed(ctx, "mining");
  if (waiting !== undefined) return waiting;

  const asteroid = requireTarget(ctx.task.asteroidWaypoint, "asteroidWaypoint");
  switch (ctx.task.phase) {
    case "TRAVEL_TO_ASTEROID":
      return travelTo(ctx, asteroid, "SURVEY", "mining");
    case "SURVEY":
      return dispatchSurvey(ctx);
    case "EXTRACT":
      return dispatchExtract(ctx);
    case "TRAVEL_TO_MARKET":
      return travelToMarket(ctx);
    case "SELL":
      return dispatchSell(ctx);
    default:
      throw new Error(`mining task cannot advance from phase ${ctx.task.phase}`);
  }
}

/**
 * Is there cargo aboard that this task has not disposed of?
 *
 * For mining it is `tradeSymbol`: set when a survey yields, cleared when the
 * hold empties at SELL. Abandoning a target with it set strands the ore — once
 * the task is idled there is no code path back to selling it.
 *
 * Each task kind answers this for itself because each means something different
 * by the same column, and the answer decides whether the scheduler may give up
 * on a target. `scheduler.ts` used to enumerate this file's and
 * `contractTask.ts`'s phase names inline, which is the scheduler reading FSM
 * internals to make a decision the FSMs are the authority on.
 */
export const miningCargoAtStake = (task: ShipTask): boolean => task.tradeSymbol !== null;

const cooldownWait = (ctx: TaskContext, phase: "SURVEY" | "EXTRACT"): TickResult | null => {
  const { task, ship, clock } = ctx;
  const expiration = ship.cooldown.expiration;
  if (expiration === null || new Date(expiration) <= clock.now()) return null;
  return {
    task: withWait(task, new Date(expiration)),
    event: "mining_cooldown_wait",
    detail: { shipSymbol: task.shipSymbol, phase },
  };
};

async function dispatchSurvey(ctx: TaskContext): Promise<TickResult> {
  const { task, clients} = ctx;
  const cooldown = cooldownWait(ctx, "SURVEY");
  if (cooldown !== null) return cooldown;
  if (task.survey !== null) {
    return { task: withPhase(task, "EXTRACT"), event: "mining_survey_ready", detail: { shipSymbol: task.shipSymbol } };
  }
  const res = await clients.survey(task.shipSymbol);
  const survey = res.data.surveys[0] ?? null;
  return {
    task: withWait({ ...task, survey }, new Date(res.data.cooldown.expiration)),
    event: "mining_survey",
    detail: { shipSymbol: task.shipSymbol, signature: survey?.signature },
  };
}

async function dispatchExtract(ctx: TaskContext): Promise<TickResult> {
  const { task, ship, clients, clock} = ctx;
  if (ship.cargo.units >= ship.cargo.capacity) {
    return {
      task: { ...withPhase(task, "TRAVEL_TO_MARKET"), survey: null },
      event: "mining_cargo_full",
      detail: { shipSymbol: task.shipSymbol, units: ship.cargo.units },
    };
  }
  const cooldown = cooldownWait(ctx, "EXTRACT");
  if (cooldown !== null) return cooldown;
  if (task.survey === null || new Date(task.survey.expiration) <= clock.now()) {
    return {
      task: withPhase({ ...task, survey: null }, "SURVEY"),
      event: "mining_survey_expired",
      detail: { shipSymbol: task.shipSymbol },
    };
  }
  const res = await clients.extractWithSurvey(task.shipSymbol, task.survey);
  const { symbol, units } = res.data.extraction.yield;
  return {
    task: withWait(
      { ...task, tradeSymbol: symbol, cycleUnitsExtracted: task.cycleUnitsExtracted + units },
      new Date(res.data.cooldown.expiration)
    ),
    event: "mining_extract",
    detail: { shipSymbol: task.shipSymbol, tradeSymbol: symbol, units },
  };
}

/**
 * The best in-system price for `tradeSymbol`, read from navigation-service's
 * cache. These reads happen from wherever the ship is, so they don't refresh
 * anything — that's what `market_intel` and the `market_stale` check track.
 */
async function findBestMarket(
  systemSymbol: string,
  tradeSymbol: string,
  clients: GameClients
): Promise<{ waypoint: string | null; checked: string[] }> {
  const waypoints = await clients.getSystemWaypoints(systemSymbol);
  const marketplaces = waypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE"));

  let best: { waypoint: string; price: number } | null = null;
  const checked: string[] = [];
  for (const w of marketplaces) {
    const market = await clients.getMarket(w.symbol);
    checked.push(w.symbol);
    const good = market.tradeGoods?.find((g) => g.symbol === tradeSymbol);
    if (good !== undefined && (best === null || good.sellPrice > best.price)) {
      best = { waypoint: w.symbol, price: good.sellPrice };
    }
  }
  return { waypoint: best?.waypoint ?? null, checked };
}

async function travelToMarket(ctx: TaskContext): Promise<TickResult> {
  const { task, ship, clients} = ctx;
  if (task.marketWaypoint !== null) return travelTo(ctx, task.marketWaypoint, "SELL", "mining");

  // A survey can yield more than one resource type before cargo fills, but
  // task.tradeSymbol only ever holds the most recently extracted one. Shop for
  // whatever's actually still in the hold — dispatchSell re-enters here (with
  // marketWaypoint reset) for each distinct good the chosen market doesn't
  // buy, so every stop picks the best market for whatever's left.
  const remaining = ship.cargo.inventory[0]?.symbol ?? task.tradeSymbol ?? "";
  const { waypoint: market, checked } = await findBestMarket(ship.nav.systemSymbol, remaining, clients);
  if (market === null) {
    return { task, event: "mining_no_market_found", detail: { shipSymbol: task.shipSymbol, tradeSymbol: remaining } };
  }
  return {
    task: { ...task, marketWaypoint: market },
    event: "mining_market_selected",
    // marketsChecked is what the market_stale anomaly treats as "markets the
    // planner is deciding on" — every marketplace priced, not just the winner.
    detail: { shipSymbol: task.shipSymbol, market, tradeSymbol: remaining, marketsChecked: checked },
  };
}

async function dispatchSell(ctx: TaskContext): Promise<TickResult> {
  const { task, ship, clients, clock} = ctx;
  const docking = await dockIfNeeded(ctx, "mining");
  if (docking !== null) return docking;

  if (ship.cargo.inventory.length > 0) {
    const marketWaypoint = requireTarget(task.marketWaypoint, "marketWaypoint");
    // This market may not buy every good in the hold — find one it does before
    // dispatching a sell, instead of always trying inventory[0] and erroring
    // the moment it's a good this market doesn't carry. The ship is docked
    // here, so this read is a genuine price refresh.
    const market = await clients.getMarket(marketWaypoint);
    const observations = { marketsRefreshed: [marketWaypoint] };
    const sellable = ship.cargo.inventory.find((i) => market.tradeGoods?.some((g) => g.symbol === i.symbol));
    if (sellable === undefined) {
      // Nothing left in the hold sells here — send the ship back to shop for a
      // market that buys whatever remains, rather than looping forever on a
      // sell this market will never accept.
      return {
        task: { ...withPhase(task, "TRAVEL_TO_MARKET"), marketWaypoint: null },
        event: "mining_market_reselect",
        detail: {
          shipSymbol: task.shipSymbol,
          market: marketWaypoint,
          reason: "market doesn't buy any remaining cargo good",
          remaining: ship.cargo.inventory.map((i) => i.symbol),
        },
        observations,
      };
    }
    const res = await clients.sell(task.shipSymbol, sellable.symbol, sellable.units);
    const totalPrice = res.data.transaction.totalPrice;
    return {
      // Revenue accumulates across every sell in the cycle, including the extra
      // market stops a multi-good hold requires — the cycle's worth is all of it.
      task: { ...task, cycleRevenue: task.cycleRevenue + totalPrice },
      event: "mining_sell",
      detail: {
        shipSymbol: task.shipSymbol,
        tradeSymbol: sellable.symbol,
        units: sellable.units,
        totalPrice,
        asteroidWaypoint: task.asteroidWaypoint,
      },
      observations,
    };
  }

  const refuel = await refuelIfNeeded(ctx, "mining");
  if (refuel !== null) return refuel;

  // Cycle complete. Everything tallied along the way becomes one observation,
  // which is how the planner finds out what this field is actually worth.
  const cycleHours =
    task.cycleStartedAt !== null ? (clock.now().getTime() - task.cycleStartedAt.getTime()) / 3_600_000 : 0;
  const summary = {
    asteroidWaypoint: requireTarget(task.asteroidWaypoint, "asteroidWaypoint"),
    revenue: task.cycleRevenue,
    cycleHours,
    travelDistance: task.cycleTravelDistance,
    unitsExtracted: task.cycleUnitsExtracted,
  };
  return {
    // Handing the ship back idle is what sends the next target through the
    // planner instead of looping back to whatever field this cycle finished.
    task: idleTask(task),
    event: "mining_cycle_complete",
    detail: { shipSymbol: task.shipSymbol, ...summary },
    ...(cycleHours > 0 ? { observations: { miningCycle: summary } } : {}),
  };
}

import { Clock } from "./clock";
import { GameClients, ShipSnapshot } from "./gameClients";
import { ShipTask } from "./shipTaskRepo";

export interface TickResult {
  task: ShipTask;
  event: string;
  detail: Record<string, unknown>;
}

export const withWait = (task: ShipTask, waitingUntil: Date): ShipTask => ({ ...task, waitingUntil });
export const withPhase = (task: ShipTask, phase: ShipTask["phase"]): ShipTask => ({ ...task, phase, waitingUntil: null });

/**
 * Advances one ship's mining FSM by exactly one atomic action per call — dispatch
 * a command, or resolve an elapsed wait — never both. That granularity is what lets
 * pause take effect between actions instead of mid-cycle.
 */
export async function advanceMiningTask(params: {
  task: ShipTask;
  ship: ShipSnapshot;
  systemSymbol: string;
  asteroidWaypoint: string;
  clients: GameClients;
  clock: Clock;
  authHeader: string;
}): Promise<TickResult | null> {
  const { task, ship, systemSymbol, asteroidWaypoint, clients, clock, authHeader } = params;
  const now = clock.now();

  if (task.waitingUntil !== null) {
    if (now < task.waitingUntil) return null; // still waiting
    return resolveWait(task);
  }

  switch (task.phase) {
    case "TRAVEL_TO_ASTEROID":
      return travelTo(task, ship, asteroidWaypoint, clients, authHeader, "SURVEY");
    case "SURVEY":
      return dispatchSurvey(task, ship, clock, clients, authHeader);
    case "EXTRACT":
      return dispatchExtract(task, ship, clock, clients, authHeader);
    case "TRAVEL_TO_MARKET":
      return travelToMarket(task, ship, systemSymbol, clients, authHeader);
    case "SELL":
      return dispatchSell(task, ship, clients, authHeader);
    default:
      return null; // a contract phase reached here would be a caller bug — nothing safe to do but wait
  }
}

function resolveWait(task: ShipTask): TickResult {
  const next: ShipTask["phase"] =
    task.phase === "TRAVEL_TO_ASTEROID"
      ? "SURVEY"
      : task.phase === "SURVEY"
        ? "EXTRACT"
        : task.phase === "TRAVEL_TO_MARKET"
          ? "SELL"
          : task.phase; // EXTRACT's cooldown just clears and re-dispatches; SELL never waits
  return {
    task: withPhase(task, next),
    event: "mining_wait_resolved",
    detail: { shipSymbol: task.shipSymbol, from: task.phase, to: next },
  };
}

/** Shared with contractTask.ts's FSM (meta#11) — travel is identical regardless of what the ship is traveling for. */
export async function travelTo(
  task: ShipTask,
  ship: ShipSnapshot,
  destinationWaypoint: string,
  clients: GameClients,
  authHeader: string,
  arrivedPhase: ShipTask["phase"],
  eventPrefix: "mining" | "contract" | "scout" = "mining"
): Promise<TickResult> {
  if (ship.nav.waypointSymbol === destinationWaypoint && ship.nav.status !== "IN_TRANSIT") {
    return {
      task: withPhase(task, arrivedPhase),
      event: `${eventPrefix}_arrived`,
      detail: { shipSymbol: task.shipSymbol, waypoint: destinationWaypoint },
    };
  }
  if (ship.nav.status === "IN_TRANSIT") {
    // Resuming after a restart mid-transit: pick the wait back up from the ship's own ETA.
    return {
      task: withWait(task, new Date(ship.nav.route.arrival)),
      event: `${eventPrefix}_travel_resumed`,
      detail: { shipSymbol: task.shipSymbol, arrival: ship.nav.route.arrival },
    };
  }
  if (ship.nav.status === "DOCKED") {
    await clients.orbit(task.shipSymbol, authHeader);
    return { task, event: `${eventPrefix}_orbit`, detail: { shipSymbol: task.shipSymbol } };
  }
  const res = await clients.navigate(task.shipSymbol, destinationWaypoint, authHeader);
  return {
    task: withWait(task, new Date(res.data.nav.route.arrival)),
    event: `${eventPrefix}_navigate`,
    detail: { shipSymbol: task.shipSymbol, destination: destinationWaypoint, arrival: res.data.nav.route.arrival },
  };
}

async function dispatchSurvey(
  task: ShipTask,
  ship: ShipSnapshot,
  clock: Clock,
  clients: GameClients,
  authHeader: string
): Promise<TickResult> {
  const cooldownActive = ship.cooldown.expiration !== null && new Date(ship.cooldown.expiration) > clock.now();
  if (cooldownActive) {
    return {
      task: withWait(task, new Date(ship.cooldown.expiration!)),
      event: "mining_cooldown_wait",
      detail: { shipSymbol: task.shipSymbol, phase: "SURVEY" },
    };
  }
  if (task.survey === null) {
    const res = await clients.survey(task.shipSymbol, authHeader);
    const survey = res.data.surveys[0] ?? null;
    return {
      task: withWait({ ...task, survey }, new Date(res.data.cooldown.expiration)),
      event: "mining_survey",
      detail: { shipSymbol: task.shipSymbol, signature: survey?.signature },
    };
  }
  return { task: withPhase(task, "EXTRACT"), event: "mining_survey_ready", detail: { shipSymbol: task.shipSymbol } };
}

async function dispatchExtract(
  task: ShipTask,
  ship: ShipSnapshot,
  clock: Clock,
  clients: GameClients,
  authHeader: string
): Promise<TickResult> {
  if (ship.cargo.units >= ship.cargo.capacity) {
    return {
      task: { ...withPhase(task, "TRAVEL_TO_MARKET"), survey: null },
      event: "mining_cargo_full",
      detail: { shipSymbol: task.shipSymbol, units: ship.cargo.units },
    };
  }
  const cooldownActive = ship.cooldown.expiration !== null && new Date(ship.cooldown.expiration) > clock.now();
  if (cooldownActive) {
    return {
      task: withWait(task, new Date(ship.cooldown.expiration!)),
      event: "mining_cooldown_wait",
      detail: { shipSymbol: task.shipSymbol, phase: "EXTRACT" },
    };
  }
  if (task.survey === null || new Date(task.survey.expiration) <= clock.now()) {
    return {
      task: withPhase({ ...task, survey: null }, "SURVEY"),
      event: "mining_survey_expired",
      detail: { shipSymbol: task.shipSymbol },
    };
  }
  const res = await clients.extractWithSurvey(task.shipSymbol, task.survey, authHeader);
  return {
    task: withWait({ ...task, tradeSymbol: res.data.extraction.yield.symbol }, new Date(res.data.cooldown.expiration)),
    event: "mining_extract",
    // units feeds the meta#14 extraction-yield rollup.
    detail: { shipSymbol: task.shipSymbol, tradeSymbol: res.data.extraction.yield.symbol, units: res.data.extraction.yield.units },
  };
}

async function findBestMarket(
  systemSymbol: string,
  tradeSymbol: string,
  clients: GameClients,
  authHeader: string
): Promise<{ waypoint: string | null; checked: string[] }> {
  const waypoints = await clients.getSystemWaypoints(systemSymbol, authHeader);
  const marketplaces = waypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE"));

  let best: { waypoint: string; price: number } | null = null;
  const checked: string[] = [];
  for (const w of marketplaces) {
    const market = await clients.getMarket(w.symbol, authHeader);
    checked.push(w.symbol);
    const good = market.tradeGoods?.find((g) => g.symbol === tradeSymbol);
    if (good !== undefined && (best === null || good.sellPrice > best.price)) {
      best = { waypoint: w.symbol, price: good.sellPrice };
    }
  }
  return { waypoint: best?.waypoint ?? null, checked };
}

async function travelToMarket(
  task: ShipTask,
  ship: ShipSnapshot,
  systemSymbol: string,
  clients: GameClients,
  authHeader: string
): Promise<TickResult> {
  if (task.marketWaypoint === null) {
    // Multi-good cargo (meta#36): a survey can yield more than one resource
    // type before cargo fills, but task.tradeSymbol only ever holds the most
    // recently extracted one. Shop for whatever's actually still in the hold
    // — dispatchSell below re-enters here (with marketWaypoint reset) for
    // each distinct good this market doesn't buy, so every stop picks the
    // best market for whatever's left, not just the last-extracted good.
    const remaining = ship.cargo.inventory[0]?.symbol ?? task.tradeSymbol ?? "";
    const { waypoint: market, checked } = await findBestMarket(systemSymbol, remaining, clients, authHeader);
    if (market === null) {
      return {
        task,
        event: "mining_no_market_found",
        detail: { shipSymbol: task.shipSymbol, tradeSymbol: remaining },
      };
    }
    return {
      task: { ...task, marketWaypoint: market },
      event: "mining_market_selected",
      // marketsChecked feeds the meta#15 market-intel-staleness anomaly check —
      // every marketplace priced this cycle, not just the one selected.
      detail: { shipSymbol: task.shipSymbol, market, tradeSymbol: remaining, marketsChecked: checked },
    };
  }
  return travelTo(task, ship, task.marketWaypoint, clients, authHeader, "SELL");
}

async function dispatchSell(
  task: ShipTask,
  ship: ShipSnapshot,
  clients: GameClients,
  authHeader: string
): Promise<TickResult> {
  if (ship.nav.status !== "DOCKED") {
    await clients.dock(task.shipSymbol, authHeader);
    return { task, event: "mining_dock", detail: { shipSymbol: task.shipSymbol } };
  }
  if (ship.cargo.inventory.length > 0) {
    // Multi-good cargo (meta#36): this market may not buy every good in the
    // hold — find one it does before dispatching sell, instead of always
    // trying inventory[0] and erroring the moment it's a good this market
    // doesn't carry.
    const market = await clients.getMarket(task.marketWaypoint!, authHeader);
    const sellable = ship.cargo.inventory.find((i) => market.tradeGoods?.some((g) => g.symbol === i.symbol));
    if (sellable === undefined) {
      // Nothing left in the hold sells here — send the ship back to shop for
      // a market that buys whatever remains, rather than looping forever on
      // a sell this market will never accept.
      return {
        task: { ...withPhase(task, "TRAVEL_TO_MARKET"), marketWaypoint: null },
        event: "mining_market_reselect",
        detail: {
          shipSymbol: task.shipSymbol,
          market: task.marketWaypoint,
          reason: "market doesn't buy any remaining cargo good",
          remaining: ship.cargo.inventory.map((i) => i.symbol),
        },
      };
    }
    const res = await clients.sell(task.shipSymbol, sellable.symbol, sellable.units, authHeader);
    return {
      task,
      event: "mining_sell",
      // totalPrice feeds the meta#14 credits-per-hour rollup.
      detail: {
        shipSymbol: task.shipSymbol,
        tradeSymbol: sellable.symbol,
        units: sellable.units,
        totalPrice: res.data.transaction.totalPrice,
      },
    };
  }
  if (ship.fuel.current < ship.fuel.capacity) {
    await clients.refuel(task.shipSymbol, authHeader);
    return { task, event: "mining_refuel", detail: { shipSymbol: task.shipSymbol } };
  }
  return {
    // asteroidWaypoint: null hands the next target back to the planner (meta#10)
    // instead of looping back to whatever field this cycle just finished.
    task: { ...withPhase(task, "TRAVEL_TO_ASTEROID"), marketWaypoint: null, tradeSymbol: null, asteroidWaypoint: null },
    event: "mining_cycle_complete",
    detail: { shipSymbol: task.shipSymbol },
  };
}

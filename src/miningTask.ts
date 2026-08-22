import { Clock } from "./clock";
import { GameClients, NavRoute, ShipSnapshot } from "./gameClients";
import { ShipTask } from "./shipTaskRepo";

/**
 * Something the fleet learned from this tick, for the scheduler to persist.
 *
 * The FSMs stay free of database access — they take a ship and a task and
 * return the next task — so anything worth remembering rides out on the tick
 * result and the scheduler writes it. See observations.ts for why any of it
 * is worth remembering.
 */
export interface TickObservations {
  /** A completed flight: how far it went, how long it took. */
  travel?: { distance: number; hours: number };
  /** A refuel: what it cost, after covering this much distance. */
  refuel?: { distance: number; fuelCredits: number };
  /** A finished mine-and-sell cycle: what the field was worth this time around. */
  miningCycle?: {
    asteroidWaypoint: string;
    revenue: number;
    cycleHours: number;
    travelDistance: number;
    unitsExtracted: number;
  };
}

export interface TickResult {
  task: ShipTask;
  event: string;
  detail: Record<string, unknown>;
  observations?: TickObservations;
}

export const withWait = (task: ShipTask, waitingUntil: Date): ShipTask => ({ ...task, waitingUntil });
export const withPhase = (task: ShipTask, phase: ShipTask["phase"]): ShipTask => ({ ...task, phase, waitingUntil: null });

/**
 * Distance and duration of a flight, straight from the game's own route record.
 * Returns null when the route doesn't carry coordinates or timestamps — every
 * caller treats that as "learned nothing", never as an error, because
 * calibration is a bonus and dispatch must not depend on it.
 */
export function measureFlight(route: NavRoute | undefined): { distance: number; hours: number } | null {
  const origin = route?.origin;
  const destination = route?.destination;
  if (route?.departureTime === undefined) return null;
  if (origin?.x === undefined || origin.y === undefined) return null;
  if (destination?.x === undefined || destination.y === undefined) return null;

  const distance = Math.hypot(destination.x - origin.x, destination.y - origin.y);
  const hours = (new Date(route.arrival).getTime() - new Date(route.departureTime).getTime()) / 3_600_000;
  if (!Number.isFinite(distance) || !Number.isFinite(hours) || distance <= 0 || hours <= 0) return null;
  return { distance, hours };
}

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
  spaceTradersToken: string;
}): Promise<TickResult | null> {
  const { task, ship, systemSymbol, asteroidWaypoint, clients, clock, spaceTradersToken } = params;
  const now = clock.now();

  if (task.waitingUntil !== null) {
    if (now < task.waitingUntil) return null; // still waiting
    return resolveWait(task);
  }

  switch (task.phase) {
    case "TRAVEL_TO_ASTEROID":
      return travelTo(task, ship, asteroidWaypoint, clients, spaceTradersToken, "SURVEY", "mining", clock);
    case "SURVEY":
      return dispatchSurvey(task, ship, clock, clients, spaceTradersToken);
    case "EXTRACT":
      return dispatchExtract(task, ship, clock, clients, spaceTradersToken);
    case "TRAVEL_TO_MARKET":
      return travelToMarket(task, ship, systemSymbol, clients, spaceTradersToken, clock);
    case "SELL":
      return dispatchSell(task, ship, clients, spaceTradersToken, clock);
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

/** Shared with contractTask.ts's and scoutTask.ts's FSMs — travel is identical regardless of what the ship is traveling for. */
export async function travelTo(
  task: ShipTask,
  ship: ShipSnapshot,
  destinationWaypoint: string,
  clients: GameClients,
  spaceTradersToken: string,
  arrivedPhase: ShipTask["phase"],
  eventPrefix: "mining" | "contract" | "scout" = "mining",
  clock?: Clock
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
    await clients.orbit(task.shipSymbol, spaceTradersToken);
    return { task, event: `${eventPrefix}_orbit`, detail: { shipSymbol: task.shipSymbol } };
  }
  const res = await clients.navigate(task.shipSymbol, destinationWaypoint, spaceTradersToken);
  const flight = measureFlight(res.data.nav.route);

  // A mining cycle's clock starts at its first real movement, not at
  // assignment — a ship that sat idle waiting for a planner decision shouldn't
  // have that wait charged against the field it eventually flew to.
  const cycleStartedAt = task.cycleStartedAt ?? (clock !== undefined ? clock.now() : null);

  return {
    task: withWait(
      {
        ...task,
        cycleStartedAt,
        cycleTravelDistance: task.cycleTravelDistance + (flight?.distance ?? 0),
      },
      new Date(res.data.nav.route.arrival)
    ),
    event: `${eventPrefix}_navigate`,
    detail: {
      shipSymbol: task.shipSymbol,
      destination: destinationWaypoint,
      arrival: res.data.nav.route.arrival,
      ...(flight !== null ? { distance: flight.distance, hours: flight.hours } : {}),
    },
    ...(flight !== null ? { observations: { travel: flight } } : {}),
  };
}

async function dispatchSurvey(
  task: ShipTask,
  ship: ShipSnapshot,
  clock: Clock,
  clients: GameClients,
  spaceTradersToken: string
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
    const res = await clients.survey(task.shipSymbol, spaceTradersToken);
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
  spaceTradersToken: string
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
  const res = await clients.extractWithSurvey(task.shipSymbol, task.survey, spaceTradersToken);
  const units = res.data.extraction.yield.units;
  return {
    task: withWait(
      {
        ...task,
        tradeSymbol: res.data.extraction.yield.symbol,
        cycleUnitsExtracted: task.cycleUnitsExtracted + units,
      },
      new Date(res.data.cooldown.expiration)
    ),
    event: "mining_extract",
    detail: { shipSymbol: task.shipSymbol, tradeSymbol: res.data.extraction.yield.symbol, units },
  };
}

async function findBestMarket(
  systemSymbol: string,
  tradeSymbol: string,
  clients: GameClients,
  spaceTradersToken: string
): Promise<{ waypoint: string | null; checked: string[] }> {
  const waypoints = await clients.getSystemWaypoints(systemSymbol, spaceTradersToken);
  const marketplaces = waypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE"));

  let best: { waypoint: string; price: number } | null = null;
  const checked: string[] = [];
  for (const w of marketplaces) {
    const market = await clients.getMarket(w.symbol, spaceTradersToken);
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
  spaceTradersToken: string,
  clock: Clock
): Promise<TickResult> {
  if (task.marketWaypoint === null) {
    // A survey can yield more than one resource type before cargo fills, but
    // task.tradeSymbol only ever holds the most recently extracted one. Shop
    // for whatever's actually still in the hold — dispatchSell below re-enters
    // here (with marketWaypoint reset) for each distinct good this market
    // doesn't buy, so every stop picks the best market for whatever's left.
    const remaining = ship.cargo.inventory[0]?.symbol ?? task.tradeSymbol ?? "";
    const { waypoint: market, checked } = await findBestMarket(systemSymbol, remaining, clients, spaceTradersToken);
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
      // marketsChecked feeds the market-staleness anomaly check — every
      // marketplace priced this cycle, not just the one selected.
      detail: { shipSymbol: task.shipSymbol, market, tradeSymbol: remaining, marketsChecked: checked },
    };
  }
  return travelTo(task, ship, task.marketWaypoint, clients, spaceTradersToken, "SELL", "mining", clock);
}

async function dispatchSell(
  task: ShipTask,
  ship: ShipSnapshot,
  clients: GameClients,
  spaceTradersToken: string,
  clock: Clock
): Promise<TickResult> {
  if (ship.nav.status !== "DOCKED") {
    await clients.dock(task.shipSymbol, spaceTradersToken);
    return { task, event: "mining_dock", detail: { shipSymbol: task.shipSymbol } };
  }
  if (ship.cargo.inventory.length > 0) {
    // This market may not buy every good in the hold — find one it does before
    // dispatching a sell, instead of always trying inventory[0] and erroring
    // the moment it's a good this market doesn't carry.
    const market = await clients.getMarket(task.marketWaypoint!, spaceTradersToken);
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
    const res = await clients.sell(task.shipSymbol, sellable.symbol, sellable.units, spaceTradersToken);
    const totalPrice = res.data.transaction.totalPrice;
    return {
      // Revenue accumulates across every sell in the cycle, including the extra
      // market stops a multi-good hold requires — the cycle's worth is all of
      // it, not just the last sale.
      task: { ...task, cycleRevenue: task.cycleRevenue + totalPrice },
      event: "mining_sell",
      detail: {
        shipSymbol: task.shipSymbol,
        tradeSymbol: sellable.symbol,
        units: sellable.units,
        totalPrice,
        asteroidWaypoint: task.asteroidWaypoint,
      },
    };
  }
  if (ship.fuel.current < ship.fuel.capacity) {
    const res = await clients.refuel(task.shipSymbol, spaceTradersToken);
    const fuelCredits = res?.data?.transaction?.totalPrice;
    // The ship left this market's dock on a full tank and is refuelling now, so
    // this purchase bought exactly the distance flown this cycle — which is what
    // makes credits-per-unit-distance measurable rather than assumed.
    const measurable =
      typeof fuelCredits === "number" && Number.isFinite(fuelCredits) && task.cycleTravelDistance > 0;
    return {
      task,
      event: "mining_refuel",
      detail: {
        shipSymbol: task.shipSymbol,
        ...(measurable ? { fuelCredits, overDistance: task.cycleTravelDistance } : {}),
      },
      ...(measurable
        ? { observations: { refuel: { distance: task.cycleTravelDistance, fuelCredits: fuelCredits as number } } }
        : {}),
    };
  }

  // Cycle complete. Everything tallied along the way becomes one observation,
  // which is how the planner finds out what this field is actually worth.
  const cycleHours =
    task.cycleStartedAt !== null ? (clock.now().getTime() - task.cycleStartedAt.getTime()) / 3_600_000 : 0;
  const miningCycle =
    task.asteroidWaypoint !== null && cycleHours > 0
      ? {
          asteroidWaypoint: task.asteroidWaypoint,
          revenue: task.cycleRevenue,
          cycleHours,
          travelDistance: task.cycleTravelDistance,
          unitsExtracted: task.cycleUnitsExtracted,
        }
      : undefined;

  return {
    // asteroidWaypoint: null hands the next target back to the planner instead
    // of looping back to whatever field this cycle just finished. The cycle
    // tallies reset here too — the next cycle starts counting from zero.
    task: {
      ...withPhase(task, "TRAVEL_TO_ASTEROID"),
      marketWaypoint: null,
      tradeSymbol: null,
      asteroidWaypoint: null,
      cycleStartedAt: null,
      cycleRevenue: 0,
      cycleTravelDistance: 0,
      cycleUnitsExtracted: 0,
    },
    event: "mining_cycle_complete",
    detail: {
      shipSymbol: task.shipSymbol,
      asteroidWaypoint: task.asteroidWaypoint,
      revenue: task.cycleRevenue,
      cycleHours,
      travelDistance: task.cycleTravelDistance,
      unitsExtracted: task.cycleUnitsExtracted,
    },
    ...(miningCycle !== undefined ? { observations: { miningCycle } } : {}),
  };
}

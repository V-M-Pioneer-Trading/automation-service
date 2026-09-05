import { Clock } from "./clock";
import { GameClients, NavRoute, ShipSnapshot } from "./gameClients";
import { ShipTask, TaskPhase } from "./shipTaskRepo";

/**
 * What every task state machine shares.
 *
 * A task FSM advances one ship by **exactly one atomic action per call** —
 * dispatch a command, or resolve an elapsed wait, never both. That granularity
 * is what lets pause take effect between actions instead of mid-cycle. The
 * FSMs are free of database access: they take a ship and a task and return the
 * next task, and anything worth remembering rides out on the `TickResult` for
 * the scheduler to persist.
 *
 * Travelling, docking and refuelling are identical whatever the ship is doing
 * it for, so they live here rather than in any one FSM.
 */

/** Something the fleet learned from this tick, for the scheduler to persist. See observations.ts. */
export interface TickObservations {
  /** A completed flight: how far it went, how long it took. */
  travel?: { distance: number; hours: number };
  /** A refuel: what it cost, for how many units — which in cruise flight is the distance they cover. */
  refuel?: { distance: number; fuelCredits: number };
  /** A finished mine-and-sell cycle: what the field was worth this time around. */
  miningCycle?: {
    asteroidWaypoint: string;
    revenue: number;
    cycleHours: number;
    travelDistance: number;
    unitsExtracted: number;
  };
  /** Markets whose prices a docked ship read this tick — the only kind of read that actually refreshes them. */
  marketsRefreshed?: string[];
}

export interface TickResult {
  task: ShipTask;
  event: string;
  detail: Record<string, unknown>;
  observations?: TickObservations;
}

/** Everything an FSM needs to advance one ship by one action. */
export interface TaskContext {
  task: ShipTask;
  ship: ShipSnapshot;
  clients: GameClients;
  clock: Clock;
}

export type EventPrefix = "mining" | "contract" | "scout";

export const withWait = (task: ShipTask, waitingUntil: Date): ShipTask => ({ ...task, waitingUntil });
export const withPhase = (task: ShipTask, phase: TaskPhase): ShipTask => ({ ...task, phase, waitingUntil: null });

/** A task field the FSM cannot run without. Throwing here turns a corrupt row into a counted failure, not a silent stall. */
export function requireTarget<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`task is missing its ${what}`);
  return value;
}

/**
 * Where each waiting phase goes once its wait elapses. A phase absent here
 * (EXTRACT's cooldown) just clears the wait and re-dispatches the same phase.
 */
const PHASE_AFTER_WAIT: Partial<Record<TaskPhase, TaskPhase>> = {
  TRAVEL_TO_ASTEROID: "SURVEY",
  SURVEY: "EXTRACT",
  TRAVEL_TO_MARKET: "SELL",
  CONTRACT_TRAVEL_TO_MARKET: "CONTRACT_PURCHASE",
  CONTRACT_TRAVEL_TO_DESTINATION: "CONTRACT_DELIVER",
  SCOUT_TRAVEL: "SCOUT_REFRESH",
};

/**
 * The wait check every FSM starts with: null while the wait is still pending
 * (nothing to do this tick), otherwise the phase transition the elapsed wait
 * unlocks. Resolving is this tick's one action.
 */
export function resolveWaitIfElapsed(ctx: TaskContext, prefix: EventPrefix): TickResult | null | undefined {
  const { task, clock } = ctx;
  if (task.waitingUntil === null) return undefined;
  if (clock.now() < task.waitingUntil) return null;
  const next = PHASE_AFTER_WAIT[task.phase] ?? task.phase;
  return {
    task: withPhase(task, next),
    event: `${prefix}_wait_resolved`,
    detail: { shipSymbol: task.shipSymbol, from: task.phase, to: next },
  };
}

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

/** Moves the ship toward `destination` one action at a time: orbit if docked, then navigate, then wait for arrival. */
export async function travelTo(
  ctx: TaskContext,
  destination: string,
  arrivedPhase: TaskPhase,
  prefix: EventPrefix
): Promise<TickResult> {
  const { task, ship, clients, clock} = ctx;
  if (ship.nav.waypointSymbol === destination && ship.nav.status !== "IN_TRANSIT") {
    return {
      task: withPhase(task, arrivedPhase),
      event: `${prefix}_arrived`,
      detail: { shipSymbol: task.shipSymbol, waypoint: destination },
    };
  }
  if (ship.nav.status === "IN_TRANSIT") {
    // Resuming after a restart mid-transit: pick the wait back up from the ship's own ETA.
    return {
      task: withWait(task, new Date(ship.nav.route.arrival)),
      event: `${prefix}_travel_resumed`,
      detail: { shipSymbol: task.shipSymbol, arrival: ship.nav.route.arrival },
    };
  }
  if (ship.nav.status === "DOCKED") {
    await clients.orbit(task.shipSymbol);
    return { task, event: `${prefix}_orbit`, detail: { shipSymbol: task.shipSymbol } };
  }
  const res = await clients.navigate(task.shipSymbol, destination);
  const flight = measureFlight(res.data.nav.route);

  // A cycle's clock starts at its first real movement, not at assignment — a
  // ship that sat idle waiting for a planner decision shouldn't have that wait
  // charged against the target it eventually flew to.
  return {
    task: withWait(
      {
        ...task,
        cycleStartedAt: task.cycleStartedAt ?? clock.now(),
        cycleTravelDistance: task.cycleTravelDistance + (flight?.distance ?? 0),
      },
      new Date(res.data.nav.route.arrival)
    ),
    event: `${prefix}_navigate`,
    detail: {
      shipSymbol: task.shipSymbol,
      destination,
      arrival: res.data.nav.route.arrival,
      ...(flight !== null ? { distance: flight.distance, hours: flight.hours } : {}),
    },
    ...(flight !== null ? { observations: { travel: flight } } : {}),
  };
}

/** Docks the ship as this tick's action, or returns null when it already is docked. */
export async function dockIfNeeded(ctx: TaskContext, prefix: EventPrefix): Promise<TickResult | null> {
  const { task, ship, clients} = ctx;
  if (ship.nav.status === "DOCKED") return null;
  await clients.dock(task.shipSymbol);
  return { task, event: `${prefix}_dock`, detail: { shipSymbol: task.shipSymbol } };
}

/**
 * Tops the tank up as this tick's action, or returns null when it's already
 * full. Every task passes through a marketplace — the sell leg, the
 * procurement market, the scouted market — and refuelling at each one is what
 * keeps a ship from being handed back to the planner too dry to reach anything.
 *
 * The purchase itself is the fuel-cost observation: the units bought are the
 * distance they cover (in cruise flight), so credits per unit is measured
 * directly rather than inferred from how far the ship happened to fly.
 */
export async function refuelIfNeeded(ctx: TaskContext, prefix: EventPrefix): Promise<TickResult | null> {
  const { task, ship, clients} = ctx;
  if (ship.fuel.current >= ship.fuel.capacity) return null;
  const res = await clients.refuel(task.shipSymbol);
  const transaction = res?.data?.transaction;
  const units = transaction?.units;
  const fuelCredits = transaction?.totalPrice;
  const measurable =
    typeof units === "number" && Number.isFinite(units) && units > 0 && typeof fuelCredits === "number" && Number.isFinite(fuelCredits);
  return {
    task,
    event: `${prefix}_refuel`,
    detail: { shipSymbol: task.shipSymbol, ...(measurable ? { fuelUnits: units, fuelCredits } : {}) },
    ...(measurable ? { observations: { refuel: { distance: units, fuelCredits } } } : {}),
  };
}

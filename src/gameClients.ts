/**
 * Thin typed clients for the existing services (navigation/agent/fleet).
 * automation-service never calls SpaceTraders directly — every ship action and
 * every read goes through these.
 *
 * One header per call, per auth-design.md decisions 5 and 19: `Authorization`
 * carries automation-service's own Clerk M2M token, proving *this service* is
 * authorized to act (the same way a human operator's session would from
 * command-interface). No game credential travels: st-gateway injects the
 * agent token itself, and a machine identity queues as background there,
 * which is exactly the lane the autopilot belongs in (decision 2).
 */

import type { M2MTokenSource } from "./m2mToken";

/**
 * One end of a nav route. SpaceTraders reports both ends with coordinates and
 * both timestamps, which is what lets us measure real flight speed instead of
 * assuming one — see observations.ts. Optional throughout because these fields
 * are only used for calibration: a response without them costs an observation,
 * never a dispatch.
 */
export interface RouteEndpoint {
  symbol: string;
  x?: number;
  y?: number;
}

export interface NavRoute {
  arrival: string;
  departureTime?: string;
  origin?: RouteEndpoint;
  destination?: RouteEndpoint;
}

export interface ShipSnapshot {
  symbol: string;
  nav: {
    systemSymbol: string;
    waypointSymbol: string;
    status: "DOCKED" | "IN_ORBIT" | "IN_TRANSIT";
    route: NavRoute;
  };
  cooldown: { expiration: string | null };
  fuel: { current: number; capacity: number };
  cargo: { units: number; capacity: number; inventory: { symbol: string; units: number }[] };
  /** Present on a real SpaceTraders ship; absent in older stubs, hence optional. */
  engine?: { speed?: number };
}

export interface SurveyData {
  signature: string;
  symbol: string;
  deposits: { symbol: string }[];
  expiration: string;
  size: string;
}

export interface WaypointSummary {
  symbol: string;
  type: string;
  x: number;
  y: number;
  traits: { symbol: string }[];
}

export interface AgentSnapshot {
  credits: number;
}

export interface MarketData {
  symbol: string;
  tradeGoods?: { symbol: string; sellPrice: number; purchasePrice: number }[];
}

export interface ContractDelivery {
  tradeSymbol: string;
  destinationSymbol: string;
  unitsRequired: number;
  unitsFulfilled: number;
}

export interface Contract {
  id: string;
  factionSymbol: string;
  type: string;
  terms: {
    deadline: string;
    payment: { onAccepted: number; onFulfilled: number };
    deliver: ContractDelivery[];
  };
  accepted: boolean;
  fulfilled: boolean;
  expiration: string;
  deadlineToAccept: string;
}

export class UpstreamCallError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

const CALL_TIMEOUT_MS = 15_000;

export function createGameClients(config: {
  navigationServiceUrl: string;
  agentServiceUrl: string;
  fleetServiceUrl: string;
  authTokenSource: M2MTokenSource;
}) {
  async function callJson<T>(url: string, init?: RequestInit): Promise<T> {
    const m2mToken = await config.authTokenSource.getToken();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${m2mToken}`,
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        // A hung navigation/agent/fleet-service call would otherwise block the
        // scheduler's re-entrancy guard forever, silently freezing all mining
        // progress with no recovery short of a restart.
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UpstreamCallError(`${init?.method ?? "GET"} ${url}: ${String(err)}`, 502);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new UpstreamCallError(`${init?.method ?? "GET"} ${url}: ${res.status} ${text}`, res.status);
    }
    return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  }

  const fleetAction = <T>(shipSymbol: string, action: string, body?: unknown) =>
    callJson<T>(`${config.fleetServiceUrl}/ships/${shipSymbol}/${action}`, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  // Purchases and sells move credits, so they're owned by agent-service (which
  // records them into its transaction history) rather than fleet-service.
  const agentShipAction = <T>(shipSymbol: string, action: string, body?: unknown) =>
    callJson<T>(`${config.agentServiceUrl}/ships/${shipSymbol}/${action}`, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  return {
    getShip: (shipSymbol: string) =>
      callJson<ShipSnapshot>(`${config.agentServiceUrl}/ships/${shipSymbol}`),

    getAgent: () => callJson<AgentSnapshot>(`${config.agentServiceUrl}/agent`),

    getContracts: () => callJson<Contract[]>(`${config.agentServiceUrl}/contracts`),

    acceptContract: (contractId: string) =>
      callJson<{ agent: AgentSnapshot; contract: Contract }>(
        `${config.agentServiceUrl}/contracts/${contractId}/accept`,
        { method: "POST" }
      ),

    fulfillContract: (contractId: string) =>
      callJson<{ agent: AgentSnapshot; contract: Contract }>(
        `${config.agentServiceUrl}/contracts/${contractId}/fulfill`,
        { method: "POST" }
      ),

    getSystemWaypoints: (systemSymbol: string) =>
      callJson<{ data: WaypointSummary[] }>(
        `${config.navigationServiceUrl}/systems/${systemSymbol}/waypoints`
      ).then((r) => r.data),

    getMarket: (waypointSymbol: string) =>
      callJson<MarketData>(`${config.navigationServiceUrl}/waypoints/${waypointSymbol}/market`),

    orbit: (shipSymbol: string) => fleetAction(shipSymbol, "orbit"),
    dock: (shipSymbol: string) => fleetAction(shipSymbol, "dock"),

    navigate: (shipSymbol: string, waypointSymbol: string) =>
      fleetAction<{ data: { nav: ShipSnapshot["nav"] } }>(shipSymbol, "navigate", { waypointSymbol }),

    survey: (shipSymbol: string) =>
      fleetAction<{ data: { surveys: SurveyData[]; cooldown: { expiration: string } } }>(
        shipSymbol,
        "survey"
      ),

    extractWithSurvey: (shipSymbol: string, survey: SurveyData) =>
      fleetAction<{
        data: { extraction: { yield: { symbol: string; units: number } }; cooldown: { expiration: string } };
      }>(shipSymbol, "extract/survey", survey),

    sell: (shipSymbol: string, tradeSymbol: string, units: number) =>
      agentShipAction<{ data: { transaction: { totalPrice: number } } }>(shipSymbol, "sell", {
        symbol: tradeSymbol,
        units,
      }),

    // The transaction is optional in the type because it's only used to
    // calibrate fuel cost (observations.ts) — a refuel that reports no price
    // still refuels the ship, it just teaches us nothing.
    refuel: (shipSymbol: string) =>
      fleetAction<{ data?: { transaction?: { units?: number; totalPrice?: number } } }>(shipSymbol, "refuel"),

    purchase: (shipSymbol: string, tradeSymbol: string, units: number) =>
      agentShipAction<{ data: { transaction: { totalPrice: number } } }>(shipSymbol, "purchase", {
        symbol: tradeSymbol,
        units,
      }),

    deliverContract: (
      contractId: string,
      shipSymbol: string,
      tradeSymbol: string,
      units: number
    ) =>
      callJson<{ data: { contract: Contract } }>(`${config.fleetServiceUrl}/contracts/${contractId}/deliver`, {
        method: "POST",
        body: JSON.stringify({ shipSymbol, tradeSymbol, units }),
      }),
  };
}

export type GameClients = ReturnType<typeof createGameClients>;

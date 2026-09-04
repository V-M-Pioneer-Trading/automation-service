/**
 * Thin typed clients for the existing services (navigation/agent/fleet).
 * automation-service never calls SpaceTraders directly — every ship action and
 * every read goes through these.
 *
 * Two headers per call, per auth-design.md decisions 18 and 19:
 * `Authorization` carries automation-service's own Clerk M2M token (proves
 * *this service* is authorized to act, same as a human operator's session
 * would from command-interface); `X-SpaceTraders-Token` carries the raw
 * game token the operator armed with (what actually reaches SpaceTraders).
 * automation-service holds both, but they answer different questions, so
 * they travel separately rather than one standing in for the other.
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
  async function callJson<T>(url: string, spaceTradersToken: string, init?: RequestInit): Promise<T> {
    const m2mToken = await config.authTokenSource.getToken();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${m2mToken}`,
          "X-SpaceTraders-Token": spaceTradersToken,
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

  const fleetAction = <T>(shipSymbol: string, action: string, spaceTradersToken: string, body?: unknown) =>
    callJson<T>(`${config.fleetServiceUrl}/ships/${shipSymbol}/${action}`, spaceTradersToken, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  // Purchases and sells move credits, so they're owned by agent-service (which
  // records them into its transaction history) rather than fleet-service.
  const agentShipAction = <T>(shipSymbol: string, action: string, spaceTradersToken: string, body?: unknown) =>
    callJson<T>(`${config.agentServiceUrl}/ships/${shipSymbol}/${action}`, spaceTradersToken, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  return {
    getShip: (shipSymbol: string, spaceTradersToken: string) =>
      callJson<ShipSnapshot>(`${config.agentServiceUrl}/ships/${shipSymbol}`, spaceTradersToken),

    getAgent: (spaceTradersToken: string) => callJson<AgentSnapshot>(`${config.agentServiceUrl}/agent`, spaceTradersToken),

    getContracts: (spaceTradersToken: string) => callJson<Contract[]>(`${config.agentServiceUrl}/contracts`, spaceTradersToken),

    acceptContract: (contractId: string, spaceTradersToken: string) =>
      callJson<{ agent: AgentSnapshot; contract: Contract }>(
        `${config.agentServiceUrl}/contracts/${contractId}/accept`,
        spaceTradersToken,
        { method: "POST" }
      ),

    fulfillContract: (contractId: string, spaceTradersToken: string) =>
      callJson<{ agent: AgentSnapshot; contract: Contract }>(
        `${config.agentServiceUrl}/contracts/${contractId}/fulfill`,
        spaceTradersToken,
        { method: "POST" }
      ),

    getSystemWaypoints: (systemSymbol: string, spaceTradersToken: string) =>
      callJson<{ data: WaypointSummary[] }>(
        `${config.navigationServiceUrl}/systems/${systemSymbol}/waypoints`,
        spaceTradersToken
      ).then((r) => r.data),

    getMarket: (waypointSymbol: string, spaceTradersToken: string) =>
      callJson<MarketData>(`${config.navigationServiceUrl}/waypoints/${waypointSymbol}/market`, spaceTradersToken),

    orbit: (shipSymbol: string, spaceTradersToken: string) => fleetAction(shipSymbol, "orbit", spaceTradersToken),
    dock: (shipSymbol: string, spaceTradersToken: string) => fleetAction(shipSymbol, "dock", spaceTradersToken),

    navigate: (shipSymbol: string, waypointSymbol: string, spaceTradersToken: string) =>
      fleetAction<{ data: { nav: ShipSnapshot["nav"] } }>(shipSymbol, "navigate", spaceTradersToken, { waypointSymbol }),

    survey: (shipSymbol: string, spaceTradersToken: string) =>
      fleetAction<{ data: { surveys: SurveyData[]; cooldown: { expiration: string } } }>(
        shipSymbol,
        "survey",
        spaceTradersToken
      ),

    extractWithSurvey: (shipSymbol: string, survey: SurveyData, spaceTradersToken: string) =>
      fleetAction<{
        data: { extraction: { yield: { symbol: string; units: number } }; cooldown: { expiration: string } };
      }>(shipSymbol, "extract/survey", spaceTradersToken, survey),

    sell: (shipSymbol: string, tradeSymbol: string, units: number, spaceTradersToken: string) =>
      agentShipAction<{ data: { transaction: { totalPrice: number } } }>(shipSymbol, "sell", spaceTradersToken, {
        symbol: tradeSymbol,
        units,
      }),

    // The transaction is optional in the type because it's only used to
    // calibrate fuel cost (observations.ts) — a refuel that reports no price
    // still refuels the ship, it just teaches us nothing.
    refuel: (shipSymbol: string, spaceTradersToken: string) =>
      fleetAction<{ data?: { transaction?: { units?: number; totalPrice?: number } } }>(shipSymbol, "refuel", spaceTradersToken),

    purchase: (shipSymbol: string, tradeSymbol: string, units: number, spaceTradersToken: string) =>
      agentShipAction<{ data: { transaction: { totalPrice: number } } }>(shipSymbol, "purchase", spaceTradersToken, {
        symbol: tradeSymbol,
        units,
      }),

    deliverContract: (
      contractId: string,
      shipSymbol: string,
      tradeSymbol: string,
      units: number,
      spaceTradersToken: string
    ) =>
      callJson<{ data: { contract: Contract } }>(`${config.fleetServiceUrl}/contracts/${contractId}/deliver`, spaceTradersToken, {
        method: "POST",
        body: JSON.stringify({ shipSymbol, tradeSymbol, units }),
      }),
  };
}

export type GameClients = ReturnType<typeof createGameClients>;

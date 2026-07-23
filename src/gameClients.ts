/**
 * Thin typed clients for the existing services (navigation/agent/fleet).
 * automation-service never calls SpaceTraders directly — every ship action and
 * every read goes through these, which forward the caller's Bearer token same
 * as command-interface does.
 */

export interface ShipSnapshot {
  symbol: string;
  nav: {
    systemSymbol: string;
    waypointSymbol: string;
    status: "DOCKED" | "IN_ORBIT" | "IN_TRANSIT";
    route: { arrival: string };
  };
  cooldown: { expiration: string | null };
  fuel: { current: number; capacity: number };
  cargo: { units: number; capacity: number; inventory: { symbol: string; units: number }[] };
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

async function callJson<T>(url: string, authHeader: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: authHeader, ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}) },
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

export function createGameClients(config: {
  navigationServiceUrl: string;
  agentServiceUrl: string;
  fleetServiceUrl: string;
}) {
  const fleetAction = <T>(shipSymbol: string, action: string, authHeader: string, body?: unknown) =>
    callJson<T>(`${config.fleetServiceUrl}/ships/${shipSymbol}/${action}`, authHeader, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  // Purchases and sells move credits, so they're owned by agent-service (which
  // records them into its transaction history) rather than fleet-service.
  const agentShipAction = <T>(shipSymbol: string, action: string, authHeader: string, body?: unknown) =>
    callJson<T>(`${config.agentServiceUrl}/ships/${shipSymbol}/${action}`, authHeader, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  return {
    getShip: (shipSymbol: string, authHeader: string) =>
      callJson<ShipSnapshot>(`${config.agentServiceUrl}/ships/${shipSymbol}`, authHeader),

    getAgent: (authHeader: string) => callJson<AgentSnapshot>(`${config.agentServiceUrl}/agent`, authHeader),

    getContracts: (authHeader: string) => callJson<Contract[]>(`${config.agentServiceUrl}/contracts`, authHeader),

    acceptContract: (contractId: string, authHeader: string) =>
      callJson<{ agent: AgentSnapshot; contract: Contract }>(
        `${config.agentServiceUrl}/contracts/${contractId}/accept`,
        authHeader,
        { method: "POST" }
      ),

    fulfillContract: (contractId: string, authHeader: string) =>
      callJson<{ agent: AgentSnapshot; contract: Contract }>(
        `${config.agentServiceUrl}/contracts/${contractId}/fulfill`,
        authHeader,
        { method: "POST" }
      ),

    getSystemWaypoints: (systemSymbol: string, authHeader: string) =>
      callJson<{ data: WaypointSummary[] }>(
        `${config.navigationServiceUrl}/systems/${systemSymbol}/waypoints`,
        authHeader
      ).then((r) => r.data),

    getMarket: (waypointSymbol: string, authHeader: string) =>
      callJson<MarketData>(`${config.navigationServiceUrl}/waypoints/${waypointSymbol}/market`, authHeader),

    orbit: (shipSymbol: string, authHeader: string) => fleetAction(shipSymbol, "orbit", authHeader),
    dock: (shipSymbol: string, authHeader: string) => fleetAction(shipSymbol, "dock", authHeader),

    navigate: (shipSymbol: string, waypointSymbol: string, authHeader: string) =>
      fleetAction<{ data: { nav: ShipSnapshot["nav"] } }>(shipSymbol, "navigate", authHeader, { waypointSymbol }),

    survey: (shipSymbol: string, authHeader: string) =>
      fleetAction<{ data: { surveys: SurveyData[]; cooldown: { expiration: string } } }>(
        shipSymbol,
        "survey",
        authHeader
      ),

    extractWithSurvey: (shipSymbol: string, survey: SurveyData, authHeader: string) =>
      fleetAction<{
        data: { extraction: { yield: { symbol: string; units: number } }; cooldown: { expiration: string } };
      }>(shipSymbol, "extract/survey", authHeader, survey),

    sell: (shipSymbol: string, tradeSymbol: string, units: number, authHeader: string) =>
      agentShipAction<{ data: { transaction: { totalPrice: number } } }>(shipSymbol, "sell", authHeader, {
        symbol: tradeSymbol,
        units,
      }),

    refuel: (shipSymbol: string, authHeader: string) => fleetAction(shipSymbol, "refuel", authHeader),

    purchase: (shipSymbol: string, tradeSymbol: string, units: number, authHeader: string) =>
      agentShipAction<{ data: { transaction: { totalPrice: number } } }>(shipSymbol, "purchase", authHeader, {
        symbol: tradeSymbol,
        units,
      }),

    purchaseShip: (shipType: string, waypointSymbol: string, authHeader: string) =>
      callJson<{ data: { ship: ShipSnapshot; transaction: { price: number } } }>(
        `${config.agentServiceUrl}/ships/purchase`,
        authHeader,
        { method: "POST", body: JSON.stringify({ shipType, waypointSymbol }) }
      ),

    deliverContract: (
      contractId: string,
      shipSymbol: string,
      tradeSymbol: string,
      units: number,
      authHeader: string
    ) =>
      callJson<{ data: { contract: Contract } }>(`${config.fleetServiceUrl}/contracts/${contractId}/deliver`, authHeader, {
        method: "POST",
        body: JSON.stringify({ shipSymbol, tradeSymbol, units }),
      }),
  };
}

export type GameClients = ReturnType<typeof createGameClients>;

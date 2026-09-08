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

/**
 * Why an upstream call failed, in the only four flavours that lead anywhere
 * different.
 *
 * A status code is not a verdict. `502` from a hung fleet-service, `503` from
 * st-gateway holding no SpaceTraders credential, and `400` for "ship is not
 * currently docked" are three unrelated problems that the scheduler used to
 * treat identically: each one ticked `failureCount` until
 * `mine.failureRetryLimit` abandoned the target. So an expired M2M token or a
 * ten-minute fleet-service outage would quietly abandon every task in the
 * fleet and re-plan them onto targets that were never the problem — the exact
 * production failure auth-design decision 19 warns about.
 *
 * Classification happens here, once, at the only place that still holds both
 * the transport error and the response. Callers branch on the verdict, and the
 * status code is not kept at all.
 *
 * - `unavailable` — the request never reached the game. Network, timeout,
 *   5xx, or gateway backpressure. Nothing about the target is wrong.
 * - `credentials` — the fleet cannot authenticate. Our M2M token was rejected
 *   (401/403), or st-gateway has no SpaceTraders credential to inject. Nothing
 *   about the target is wrong here either; the difference from `unavailable`
 *   is who has to act, not what the ship should do next.
 * - `malformed` — this service asked for something the upstream service would
 *   not accept or could not find: a bug, a stale configuration, or a waypoint
 *   that no longer exists.
 * - `rejected` — the game understood the action and refused it in this state:
 *   cooldown, wrong nav status, not enough credits. This is the failure the
 *   retry-then-abandon policy was actually designed for.
 *
 * The split that matters to the scheduler is `rejected`/`malformed` (evidence
 * about the target, spend its retry budget) against
 * `unavailable`/`credentials` (evidence about the fleet's plumbing, don't).
 * `malformed` deliberately does *not* get a shorter fuse than `rejected`: a
 * `404` is emitted by fleet-service and agent-service for any unrouted path,
 * so a rolling deploy or a brief ingress gap produces one, and it is
 * indistinguishable from a permanently wrong request at every layer — giving
 * it zero retries would abandon the whole fleet on a single bad tick, which is
 * the failure this taxonomy exists to prevent.
 */
export type UpstreamFailureKind = "unavailable" | "credentials" | "malformed" | "rejected";

/**
 * The gateway answers `503` both for "auth-service has no agent token yet" and
 * for "auth-service is down", and only says which in the message (st-gateway
 * README, "Errors the gateway generates itself"). The first is a credential
 * problem an operator must fix; the second resolves on its own. There is no
 * machine-readable discriminator to read instead, so this matches the word the
 * gateway puts in exactly one of the two sentences.
 *
 * Two known gaps, both of which read `unavailable` instead — the same
 * behaviour, a less precise label. navigation-service collapses every upstream
 * 5xx into its own `502`, so a missing credential reached through a market or
 * waypoint lookup arrives with the wrong status and no matching message; and
 * st-gateway reports a *wrong shared secret* (auth-service `403`) with the
 * "auth-service unavailable" sentence, though it needs an operator too.
 */
const CREDENTIAL_UNCONFIGURED = /credential not configured/i;

/**
 * Decides the verdict from what an upstream answer actually carries.
 *
 * `400` defaults to `rejected` because that is what SpaceTraders returns for
 * nearly every gameplay refusal, and the three services pass the game's status
 * and message straight through. Our own bad request looks different *when
 * fleet-service is the one answering*: its tsoa validation failures add
 * `error.fields` (fleet-service README, "Errors"). It is the only one of the
 * three that does — agent-service answers plain text and navigation-service
 * answers RFC 9457 problem+json — so their own validation failures read as
 * `rejected`. That errs toward giving the target its full retry budget, which
 * is the safe direction, and is why the `fields` check is a bonus signal
 * rather than the rule.
 *
 * `404` is `malformed` rather than `rejected`: every ship and waypoint we name
 * comes from configuration or our own database. It is *not* proof of a
 * permanent bug — both services 404 any unrouted path, so a deploy produces
 * one — which is why `malformed` keeps the normal retry budget.
 */
export function classifyUpstreamStatus(status: number, body = ""): UpstreamFailureKind {
  if (status === 401 || status === 403) return "credentials";
  if (status === 503 && CREDENTIAL_UNCONFIGURED.test(body)) return "credentials";
  // 429 is the gateway's token bucket telling us to come back, not a refusal;
  // 408 and 425 are a proxy talking about the connection, not about the game.
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "unavailable";
  if (status === 400) return hasValidationFields(body) ? "malformed" : "rejected";
  if (status === 409 || status === 422) return "rejected";
  if (status >= 400) return "malformed";
  return "unavailable";
}

function hasValidationFields(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { fields?: unknown } };
    return parsed?.error?.fields !== undefined;
  } catch {
    return false; // not our envelope at all; fall back to the status
  }
}

export class UpstreamCallError extends Error {
  constructor(message: string, public kind: UpstreamFailureKind) {
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
      throw new UpstreamCallError(`${init?.method ?? "GET"} ${url}: ${String(err)}`, "unavailable");
    }
    const text = await res.text();
    if (!res.ok) {
      throw new UpstreamCallError(`${init?.method ?? "GET"} ${url}: ${res.status} ${text}`, classifyUpstreamStatus(res.status, text));
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

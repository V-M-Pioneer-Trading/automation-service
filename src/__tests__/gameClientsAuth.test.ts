import { M2MTokenError, MESSAGES, type M2MTokenSource } from "@v-m-pioneer-trading/introspection-client";
import { createGameClients, UpstreamCallError } from "../gameClients";
import { verdictOf } from "../scheduler";
import { startStub, type Stub } from "../testSupport/stubServers";

/**
 * What gameClients presents as `Authorization` (decision 22), and what a
 * failure to get that token is called. A token failure never reaches the
 * upstream, so it must not fall through to `internal`: the scheduler spends a
 * target's retry budget on `internal`, and an auth-service outage would then
 * abandon every task in the fleet.
 */

const SHIP = { symbol: "MINING-1", nav: { status: "DOCKED" } };
const KNOWN_TOKEN = "known-machine-token-123";

describe("gameClients outbound credential", () => {
  let upstream: Stub | null = null;
  afterEach(async () => {
    await upstream?.close();
    upstream = null;
  });

  const clientsFor = (authTokenSource: M2MTokenSource, url = "http://127.0.0.1:1") =>
    createGameClients({
      navigationServiceUrl: url,
      agentServiceUrl: url,
      fleetServiceUrl: url,
      authTokenSource,
    });

  it("sends the source's token as a bearer on a game read", async () => {
    upstream = await startStub(() => ({ status: 200, body: SHIP }));

    await clientsFor({ getToken: async () => KNOWN_TOKEN }, upstream.url).getShip("MINING-1");

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].headers.authorization).toBe(`Bearer ${KNOWN_TOKEN}`);
  });

  it("sends it on a game action too, and asks the source again for each call", async () => {
    upstream = await startStub(() => ({ status: 200, body: {} }));
    let n = 0;
    const clients = clientsFor({ getToken: async () => `${KNOWN_TOKEN}-${++n}` }, upstream.url);

    await clients.getShip("MINING-1");
    await clients.orbit("MINING-1");

    expect(upstream.calls.map((c) => c.headers.authorization)).toEqual([
      `Bearer ${KNOWN_TOKEN}-1`,
      `Bearer ${KNOWN_TOKEN}-2`,
    ]);
  });

  describe("a token that cannot be had", () => {
    const failing = (err: unknown): M2MTokenSource => ({ getToken: async () => Promise.reject(err) });

    const failure = async (source: M2MTokenSource): Promise<unknown> => {
      try {
        await clientsFor(source).getShip("MINING-1");
      } catch (err) {
        return err;
      }
      throw new Error("getShip did not fail");
    };

    it("unknown-caller is a credentials failure, not internal", async () => {
      const err = await failure(failing(new M2MTokenError("unknown-caller", "the center does not know this caller")));

      expect(err).toBeInstanceOf(UpstreamCallError);
      expect(verdictOf(err)).toBe("credentials");
    });

    it.each(["unavailable", "malformed"] as const)("%s is an unavailable failure, not internal", async (kind) => {
      const err = await failure(failing(new M2MTokenError(kind, "the center said something")));

      expect(err).toBeInstanceOf(UpstreamCallError);
      expect(verdictOf(err)).toBe("unavailable");
    });

    it("an unexpected error from the source is unavailable too, and makes no upstream request", async () => {
      upstream = await startStub(() => ({ status: 200, body: SHIP }));

      const err = await (async () => {
        try {
          await clientsFor(failing(new TypeError("boom")), upstream.url).getShip("MINING-1");
        } catch (e) {
          return e;
        }
        throw new Error("getShip did not fail");
      })();

      expect(verdictOf(err)).toBe("unavailable");
      expect(upstream.calls).toHaveLength(0);
    });

    it("never puts the error's text, which could carry a secret, in the message", async () => {
      const err = await failure(failing(new M2MTokenError("unavailable", "leaky-secret-text")));

      expect((err as Error).message).not.toContain("leaky-secret-text");
      expect((err as Error).message).toContain("unavailable");
    });
  });

  /**
   * Three different "you may not" answers, kept apart end to end through the
   * real fetch path. Who wrote the refusal decides who has to act:
   *
   * - the center would not mint our machine token (decision 22): no request
   *   is made, and the token source's mapping holds whatever the upstream
   *   would have said;
   * - a sibling's own introspection 403, `this action requires a scope this
   *   session does not carry`: our token is genuine but under-scoped, a fault
   *   in the scopes auth-service grants this caller. `credentials`, because
   *   the fix is at auth-service and no waiting or re-planning helps;
   * - SpaceTraders' own 403, relayed unchanged (meta upstream-errors.md): our
   *   credential worked and the game refused the thing we named. `denied`.
   */
  describe("whose 403 it was", () => {
    const GAME_403 = "Agent does not own or cannot access ship RADOMSKY-TEST-1.";

    const verdictFrom = async (status: number, body: unknown): Promise<unknown> => {
      upstream = await startStub(() => ({ status, body }));
      const err = await clientsFor({ getToken: async () => KNOWN_TOKEN }, upstream.url)
        .getShip("RADOMSKY-TEST-1")
        .then(() => new Error("getShip did not fail"), (e: unknown) => e);
      expect(err).toBeInstanceOf(UpstreamCallError);
      return verdictOf(err);
    };

    it("a sibling refusing our machine token for a missing scope is credentials", async () => {
      expect(await verdictFrom(403, { error: { message: MESSAGES.missingScope } })).toBe("credentials");
    });

    it.each([
      ["agent-service (plain text)", GAME_403],
      ["fleet-service (envelope)", { error: { message: GAME_403, code: 4225 } }],
      ["navigation-service (problem+json)", { status: 403, detail: GAME_403 }],
    ])("SpaceTraders' 403 relayed by %s is denied", async (_via, body) => {
      expect(await verdictFrom(403, body)).toBe("denied");
    });

    it("a machine token the center refuses is credentials, before any upstream can answer 403", async () => {
      upstream = await startStub(() => ({ status: 403, body: GAME_403 }));
      const source: M2MTokenSource = {
        getToken: async () => Promise.reject(new M2MTokenError("unknown-caller", "the center does not know this caller")),
      };

      const err = await clientsFor(source, upstream.url)
        .getShip("RADOMSKY-TEST-1")
        .then(() => new Error("getShip did not fail"), (e: unknown) => e);

      expect(verdictOf(err)).toBe("credentials");
      expect(upstream.calls).toHaveLength(0);
    });

    it("any other token failure stays unavailable, whatever the upstream would have said", async () => {
      upstream = await startStub(() => ({ status: 403, body: { error: { message: MESSAGES.missingScope } } }));
      const source: M2MTokenSource = {
        getToken: async () => Promise.reject(new M2MTokenError("unavailable", "the center is down")),
      };

      const err = await clientsFor(source, upstream.url)
        .getShip("RADOMSKY-TEST-1")
        .then(() => new Error("getShip did not fail"), (e: unknown) => e);

      expect(verdictOf(err)).toBe("unavailable");
      expect(upstream.calls).toHaveLength(0);
    });
  });
});

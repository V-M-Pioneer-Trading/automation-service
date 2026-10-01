import { M2MTokenError, type M2MTokenSource } from "@v-m-pioneer-trading/introspection-client";
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
});

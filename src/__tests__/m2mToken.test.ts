import { fetchStartupToken, resolveM2MTokenSource } from "../config";
import { startStub, type Stub } from "../testSupport/stubServers";

/**
 * The outbound credential (auth-design.md decision 22): this service asks
 * auth-service for its machine token instead of minting one. The center here
 * is a real local HTTP server, so the package's real source makes a real call.
 */

const CALLER_SECRET = "s3cr3t-caller-value";
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT-shaped token with a usable lifetime; the source reads `iat` and `exp` from it. */
const jwt = (): string => {
  const iat = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: "mch_test", iat, exp: iat + 86400 })}.sig`;
};

describe("resolveM2MTokenSource", () => {
  let center: Stub | null = null;
  afterEach(async () => {
    await center?.close();
    center = null;
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    AUTH_M2M_TOKEN_URL: "http://127.0.0.1:1/auth/v1/m2m-token",
    AUTH_M2M_CALLER_SECRET: CALLER_SECRET,
    ...extra,
  });

  const refusal = (e: NodeJS.ProcessEnv): Error => {
    try {
      resolveM2MTokenSource(e, () => undefined);
    } catch (err) {
      return err as Error;
    }
    throw new Error("resolveM2MTokenSource() did not refuse");
  };

  describe("configuration", () => {
    it("refuses to start without AUTH_M2M_TOKEN_URL, without echoing the secret", () => {
      const err = refusal(env({ AUTH_M2M_TOKEN_URL: undefined }));
      expect(err.message).toContain("AUTH_M2M_TOKEN_URL");
      expect(err.message).not.toContain(CALLER_SECRET);
    });

    it("refuses to start without AUTH_M2M_CALLER_SECRET", () => {
      expect(refusal(env({ AUTH_M2M_CALLER_SECRET: undefined })).message).toContain("AUTH_M2M_CALLER_SECRET");
    });

    it("refuses an empty value the same as a missing one", () => {
      expect(refusal(env({ AUTH_M2M_TOKEN_URL: "" })).message).toContain("AUTH_M2M_TOKEN_URL");
      expect(refusal(env({ AUTH_M2M_CALLER_SECRET: "" })).message).toContain("AUTH_M2M_CALLER_SECRET");
    });

    it("does not accept the retired variables in place of the new ones", () => {
      const retired = { CLERK_M2M_SECRET_KEY: "sk_x", DEV_M2M_SIGNING_KEY_FILE: "/tmp/key.pem" };
      expect(refusal({ ...retired }).message).toContain("AUTH_M2M_TOKEN_URL");
      expect(refusal({ ...retired, AUTH_M2M_TOKEN_URL: "http://x/m2m-token" }).message).toContain(
        "AUTH_M2M_CALLER_SECRET"
      );
    });
  });

  describe("retired variables", () => {
    const logged = (extra: NodeJS.ProcessEnv): string[] => {
      const lines: string[] = [];
      resolveM2MTokenSource(env(extra), (line) => lines.push(line));
      return lines;
    };

    it("logs one line naming CLERK_M2M_SECRET_KEY, never its value, and starts anyway", () => {
      const lines = logged({ CLERK_M2M_SECRET_KEY: "sk_live_do_not_log" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("CLERK_M2M_SECRET_KEY");
      expect(lines[0]).toContain("ignored");
      expect(lines[0]).not.toContain("sk_live_do_not_log");
    });

    it("names DEV_M2M_SIGNING_KEY_FILE the same way", () => {
      const lines = logged({ DEV_M2M_SIGNING_KEY_FILE: "/secret/path.pem" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("DEV_M2M_SIGNING_KEY_FILE");
      expect(lines[0]).not.toContain("/secret/path.pem");
    });

    it("is still one line when both are set", () => {
      const lines = logged({ CLERK_M2M_SECRET_KEY: "sk_x", DEV_M2M_SIGNING_KEY_FILE: "/k.pem" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("CLERK_M2M_SECRET_KEY");
      expect(lines[0]).toContain("DEV_M2M_SIGNING_KEY_FILE");
    });

    it("is silent when neither is set, or when one is empty", () => {
      expect(logged({})).toEqual([]);
      expect(logged({ CLERK_M2M_SECRET_KEY: "" })).toEqual([]);
    });
  });

  describe("the source it returns", () => {
    it("POSTs to the URL verbatim with the caller secret, and returns the token the center minted", async () => {
      const token = jwt();
      center = await startStub(() => ({ status: 200, body: { token, expires_at: 4102444800 } }));
      const source = resolveM2MTokenSource(
        env({ AUTH_M2M_TOKEN_URL: `${center.url}/auth/v1/m2m-token` }),
        () => undefined
      );

      await expect(source.getToken()).resolves.toBe(token);
      await expect(source.getToken()).resolves.toBe(token);

      expect(center.calls).toHaveLength(1); // cached
      expect(center.calls[0].method).toBe("POST");
      expect(center.calls[0].url).toBe("/auth/v1/m2m-token");
      expect(center.calls[0].headers["x-m2m-caller-secret"]).toBe(CALLER_SECRET);
    });
  });

  describe("fetchStartupToken", () => {
    const sourceFor = (stub: Stub) =>
      resolveM2MTokenSource(env({ AUTH_M2M_TOKEN_URL: `${stub.url}/auth/v1/m2m-token` }), () => undefined);

    const fetched = async (source: ReturnType<typeof sourceFor>) => {
      const lines: string[] = [];
      const outcome = await fetchStartupToken(source, (line) => lines.push(line));
      return { outcome, lines };
    };

    it("is fetched, and silent, when the center answers", async () => {
      center = await startStub(() => ({ status: 200, body: { token: jwt(), expires_at: 4102444800 } }));

      expect(await fetched(sourceFor(center))).toEqual({ outcome: "fetched", lines: [] });
    });

    it("reports unknown-caller when the center answers 401, so the entrypoint can exit", async () => {
      center = await startStub(() => ({ status: 401, body: { error: "unknown caller" } }));

      const { outcome } = await fetched(sourceFor(center));

      expect(outcome).toBe("unknown-caller");
    });

    it("continues with one log line when the center answers 503", async () => {
      center = await startStub(() => ({ status: 503, body: { error: "the token could not be minted" } }));

      const { outcome, lines } = await fetched(sourceFor(center));

      expect(outcome).toBe("deferred");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("unavailable");
      expect(lines[0]).not.toContain(CALLER_SECRET);
    });

    it("continues when the center is unreachable", async () => {
      center = await startStub(() => ({ status: 200, body: {} }));
      const source = sourceFor(center);
      await center.close(); // the port is now refusing connections
      center = null;

      const { outcome, lines } = await fetched(source);

      expect(outcome).toBe("deferred");
      expect(lines).toHaveLength(1);
    });

    it("continues when the answer is malformed, and never logs the body", async () => {
      center = await startStub(() => ({ status: 200, body: { token: "leaky-body-token" } }));

      const { outcome, lines } = await fetched(sourceFor(center));

      expect(outcome).toBe("deferred");
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("leaky-body-token");
    });

    it("treats a non-M2MTokenError as deferred, not fatal", async () => {
      const lines: string[] = [];
      const outcome = await fetchStartupToken(
        { getToken: async () => Promise.reject(new Error(`boom ${CALLER_SECRET}`)) },
        (line) => lines.push(line)
      );

      expect(outcome).toBe("deferred");
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(CALLER_SECRET);
    });
  });
});

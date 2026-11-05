import type { ExpressAuth } from "@v-m-pioneer-trading/clerk-client";
import { declaring, SCOPE_FLEET_CONTROL, type Policy, type Registrar } from "../auth";

// No database: the registrar is a function of (target, auth, policy) alone.
const auth = {
  ignoreCredentials: () => "IGNORE",
  requireScope: (scope: string) => `SCOPE:${scope}`,
} as unknown as ExpressAuth;

const recorder = () => {
  const calls: unknown[][] = [];
  const target: Registrar = {};
  for (const verb of ["get", "post", "put", "patch", "delete", "head", "options"]) {
    target[verb] = (...args: unknown[]) => {
      calls.push([verb, ...args]);
    };
  }
  return { calls, target };
};

const handler = () => undefined;
// A statement, not an expression: expect(() => ...) wants a throwing function, not a value.
const register = (r: Registrar, verb: string, ...args: unknown[]): void => {
  (r[verb] as (...a: unknown[]) => unknown)(...args);
};

describe("declaring", () => {
  const policy: Policy = {
    "GET /a": "ignore",
    "POST /b": SCOPE_FLEET_CONTROL,
  };

  it("puts the declaration its policy entry names ahead of the handlers", () => {
    const { calls, target } = recorder();
    const registrar = declaring(target, auth, policy);
    register(registrar, "get", "/a", handler);
    register(registrar, "post", "/b", handler);
    expect(calls).toEqual([
      ["get", "/a", "IGNORE", handler],
      ["post", "/b", `SCOPE:${SCOPE_FLEET_CONTROL}`, handler],
    ]);
  });

  it("refuses a route with no policy entry", () => {
    const { target } = recorder();
    const registrar = declaring(target, auth, policy);
    expect(() => {
      register(registrar, "get", "/c", handler);
    }).toThrow(
      /refusing to start: route GET \/c declares no credential requirement/
    );
  });

  it("refuses a mutating route that declares ignore", () => {
    const { target } = recorder();
    const registrar = declaring(target, auth, { "POST /x": "ignore" });
    expect(() => {
      register(registrar, "post", "/x", handler);
    }).toThrow(/mutating method/);
  });

  it("refuses an entry that is neither ignore nor one of this service's scopes", () => {
    const { target } = recorder();
    const registrar = declaring(target, auth, { "GET /x": "session" } as unknown as Policy);
    expect(() => {
      register(registrar, "get", "/x", handler);
    }).toThrow(/unknown credential requirement "session"/);
  });

  it("skips a route named in omit, after checking that it has an entry", () => {
    const { calls, target } = recorder();
    const registrar = declaring(target, auth, policy, new Set(["GET /a"]));
    register(registrar, "get", "/a", handler);
    expect(calls).toEqual([]);
    expect(() => {
      register(registrar, "get", "/c", handler);
    }).toThrow(/declares no credential requirement/);
  });

  it("refuses an omit key that names no policy entry", () => {
    const { target } = recorder();
    expect(() => declaring(target, auth, policy, new Set(["GET /typo"]))).toThrow(/omit.*GET \/typo/);
  });
});

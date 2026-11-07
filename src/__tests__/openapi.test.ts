import fs from "node:fs";
import path from "node:path";
import { routePolicy } from "../auth";

// openapi.json is generated from the controllers (npm run openapi); routePolicy is what is enforced.
// Each names the same routes, and each route's x-auth says what the policy enforces.
describe("openapi.json and routePolicy", () => {
  // Read with fs, not imported: the file is outside tsconfig's rootDir.
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "openapi.json"), "utf8")) as {
    paths: Record<string, Record<string, { "x-auth"?: string }>>;
  };
  const specRoutes = Object.entries(spec.paths).flatMap(([p, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ":$1")}`, auth: op["x-auth"] }))
  );

  it("name exactly the same routes", () => {
    expect(specRoutes.map((r) => r.key).sort()).toEqual(Object.keys(routePolicy).sort());
  });

  it("state the requirement the policy enforces", () => {
    const fromSpec = Object.fromEntries(specRoutes.map((r) => [r.key, r.auth]));
    const fromPolicy = Object.fromEntries(Object.entries(routePolicy).map(([k, tier]) => [k, tier === "ignore" ? "public" : tier]));
    expect(fromSpec).toEqual(fromPolicy);
  });
});

// A scoped route says so in `security` (what a consumer reads), a public read says nothing there.
describe("openapi.json security", () => {
  interface Operation {
    operationId: string;
    "x-auth": string;
    security?: Record<string, string[]>[];
  }
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "openapi.json"), "utf8")) as {
    paths: Record<string, Record<string, Operation>>;
    components: { securitySchemes: Record<string, { type?: string; scheme?: string; description?: string }> };
  };
  const operations = Object.entries(spec.paths).flatMap(([p, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ":$1")}`, op }))
  );

  it("requires the policy's scope on a scoped route and nothing on a public read, in both directions", () => {
    const fromSpec = Object.fromEntries(operations.map(({ key, op }) => [key, op.security ?? []]));
    const fromPolicy = Object.fromEntries(
      Object.entries(routePolicy).map(([key, tier]) => [key, tier === "ignore" ? [] : [{ clerk: [tier] }]])
    );
    expect(fromSpec).toEqual(fromPolicy);
  });

  it("defines the clerk bearer scheme the requirements name, and says it deviates from OpenAPI 3.0", () => {
    const clerk = spec.components.securitySchemes.clerk;
    expect(clerk.type).toBe("http");
    expect(clerk.scheme).toBe("bearer");
    expect(clerk.description).toMatch(/OpenAPI 3\.0/);
  });

  it("gives every operation its own operationId", () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers no route behind tsoa's authentication hook: the scope check is routePolicy's alone", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "generated", "routes.ts"), "utf8");
    expect(routes).not.toContain("authenticateMiddleware(");
  });
});

// A success body that is "the answer or an error" forces every generated client to narrow it (meta#168).
// An error answer is declared on its own status code, as exactly the ErrorBody schema.
describe("openapi.json error answers", () => {
  const ERROR_REF = "#/components/schemas/ErrorBody";
  interface Schema {
    $ref?: string;
    anyOf?: Schema[];
    oneOf?: Schema[];
    allOf?: Schema[];
  }
  interface Operation {
    responses: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  }
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "openapi.json"), "utf8")) as {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, Schema> };
  };
  const operations = Object.entries(spec.paths).flatMap(([p, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ":$1")}`, op }))
  );

  /** Whether `schema` is, or contains through any union or component reference, the ErrorBody schema. */
  const reachesErrorBody = (schema: Schema | undefined, seen = new Set<string>()): boolean => {
    if (schema === undefined) return false;
    if (schema.$ref !== undefined) {
      if (schema.$ref === ERROR_REF) return true;
      if (seen.has(schema.$ref)) return false;
      seen.add(schema.$ref);
      return reachesErrorBody(spec.components.schemas[schema.$ref.replace("#/components/schemas/", "")], seen);
    }
    return [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].some((s) => reachesErrorBody(s, seen));
  };

  const schemaOf = (res: Operation["responses"][string]): Schema | undefined => res.content?.["application/json"]?.schema;

  it("references the error body from no 2xx response", () => {
    const offenders = operations.flatMap(({ key, op }) =>
      Object.entries(op.responses)
        .filter(([status, res]) => status.startsWith("2") && reachesErrorBody(schemaOf(res)))
        .map(([status]) => `${key} ${status}`)
    );
    expect(offenders).toEqual([]);
  });

  it("declares exactly these 4xx answers, each as the error body", () => {
    const declared = operations.flatMap(({ key, op }) =>
      Object.entries(op.responses)
        .filter(([status]) => status.startsWith("4"))
        .map(([status, res]) => ({ answer: `${key} ${status}`, schema: schemaOf(res) }))
    );
    expect(declared.map((d) => d.answer).sort()).toEqual(
      [
        "POST /api/automation/v1/autopilot/arm 400",
        "POST /api/automation/v1/autopilot/pause 409",
        "POST /api/automation/v1/autopilot/abort 409",
        "GET /api/automation/v1/autopilot/ships/:shipSymbol 404",
        "GET /api/automation/v1/planner/knobs 400",
        "PUT /api/automation/v1/planner/knobs/:name 400",
        "PUT /api/automation/v1/planner/knobs/:name 403",
        "PUT /api/automation/v1/planner/knobs/:name 404",
        "POST /api/automation/v1/events 400",
      ].sort()
    );
    for (const { schema } of declared) expect(schema).toEqual({ $ref: ERROR_REF });
  });
});

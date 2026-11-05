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

// Writes ./openapi.json from tsoa's generated spec: pretty-printed, LF, trailing
// newline, no timestamps. Run via `npm run openapi`.
//
// JSDoc descriptions are copied from the controller sources, which a Windows
// checkout with autocrlf has as CRLF, so line endings inside strings are
// normalised to LF to keep the output identical on every platform.
//
// Each operation's `security` is derived from its `x-auth` (the one per-route
// source, set by the controller's @Extension): `public` is no requirement, any
// other value is the scope the `clerk` scheme must carry. tsoa's own @Security
// is deliberately not used: it turns on a generated authentication hook that
// would be a second auth path beside auth-service (decision 21).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(root, "src", "generated", "swagger.json"), "utf8"));
for (const [route, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const auth = operation["x-auth"];
    if (typeof auth !== "string") throw new Error(`${method.toUpperCase()} ${route} has no x-auth: add @Extension("x-auth", ...) to the controller method`);
    operation.security = auth === "public" ? [] : [{ clerk: [auth] }];
  }
}
const lf = (_key, value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value);
fs.writeFileSync(path.join(root, "openapi.json"), JSON.stringify(spec, lf, 2) + "\n");

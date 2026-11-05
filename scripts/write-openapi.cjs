// Writes ./openapi.json from tsoa's generated spec: pretty-printed, LF, trailing
// newline, no timestamps. Run via `npm run openapi`.
//
// JSDoc descriptions are copied from the controller sources, which a Windows
// checkout with autocrlf has as CRLF, so line endings inside strings are
// normalised to LF to keep the output identical on every platform.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(root, "src", "generated", "swagger.json"), "utf8"));
const lf = (_key, value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value);
fs.writeFileSync(path.join(root, "openapi.json"), JSON.stringify(spec, lf, 2) + "\n");

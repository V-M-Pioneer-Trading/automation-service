// tsoa spec-and-routes, then a `// @ts-nocheck` on the generated routes file.
// tsoa's template does not compile under exactOptionalPropertyTypes (its
// `successStatus: undefined`), and generated code is not ours to edit. Every
// hand-written file keeps the full strict set.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const cli = require.resolve("tsoa/dist/cli.js");
execFileSync(process.execPath, [cli, "spec-and-routes"], { stdio: "inherit", cwd: path.join(__dirname, "..") });

const routes = path.join(__dirname, "..", "src", "generated", "routes.ts");
const text = fs.readFileSync(routes, "utf8");
if (!text.startsWith("// @ts-nocheck")) fs.writeFileSync(routes, "// @ts-nocheck\n" + text);

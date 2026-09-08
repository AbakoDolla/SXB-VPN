import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "backend", "package.json"));
const ts = require("typescript");
const express = require("express");
const cors = require("cors");
const source = ts.createSourceFile("server.ts", readFileSync(path.join(root, "server.ts"), "utf8"), ts.ScriptTarget.Latest, true);
let corsOptions;
function visit(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "cors") {
    corsOptions = node.arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(corsOptions && ts.isObjectLiteralExpression(corsOptions), "Production CORS configuration missing");
function stringArrayOption(name) {
  const option = corsOptions.properties.find(property =>
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name);
  assert.ok(option && ts.isArrayLiteralExpression(option.initializer), `CORS ${name} is not an explicit list`);
  return option.initializer.elements.map(element => {
    assert.ok(ts.isStringLiteral(element));
    return element.text;
  });
}

const app = express();
const origin = "https://vpnsxb.afrihall.com";
app.use(cors({
  origin: [origin],
  methods: stringArrayOption("methods"),
  allowedHeaders: stringArrayOption("allowedHeaders"),
  credentials: true,
}));
app.post("/api/vpn-profiles/profile/unlock", (_req, res) => res.json({ success: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
const url = `http://127.0.0.1:${server.address().port}/api/vpn-profiles/profile/unlock`;

test("the production CORS headers permit session-bound unlock proofs and the chosen language", async () => {
  const response = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,accept-language,x-vpn-profile-unlock",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const headers = response.headers.get("access-control-allow-headers").toLowerCase().split(",").map(value => value.trim());
  for (const header of ["authorization", "content-type", "accept-language", "x-vpn-profile-unlock"]) {
    assert.ok(headers.includes(header), `Missing allowed header: ${header}`);
  }
});

test("the unlock header does not authorize an unrelated browser origin", async () => {
  const response = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: "https://untrusted.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "x-vpn-profile-unlock",
    },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

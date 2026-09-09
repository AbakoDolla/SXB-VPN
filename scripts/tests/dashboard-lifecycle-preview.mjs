// Build the dashboard first, then run: node scripts\tests\dashboard-lifecycle-preview.mjs
// Serves only synthetic data on loopback. No login, database, proxy or production API.
import http from "node:http";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { root, client, device, subscription } from "./fixtures/dashboard-lifecycle-ui.mjs";

const require = createRequire(path.join(root, "backend", "package.json"));
const { build } = require("esbuild");
const DAY = 86400000;
const GB = 1024 ** 3;
const clone = value => structuredClone(value);
const date = days => new Date(Date.now() + days * DAY).toISOString();

export function createFixtureHandler(assets = new Map()) {
  let counter = 10, delayMs = 250, failNext = false;
  let accessState = "active", quotaState = "available";
  const clients = ["active", "suspended", "disabled", "expired", "revoked"].map((status, i) => ({
    ...clone(client), id: `client-${i + 1}`, deviceId: `SXBDEVICE-DEMO-${i + 1}`, status,
    expireAt: date(status === "expired" ? -2 : 120),
    user: { name: `Demo client ${i + 1}`, email: `demo${i + 1}@example.test` },
  }));
  let subscriptions = ["expired", "suspended", "exhausted", "active", "revoked"].map((status, i) => ({
    ...clone(subscription), id: `plan-${i + 1}`, clientId: clients[i].id, client: clients[i],
    name: `Demo plan ${i + 1}`, status, expireAt: date(status === "expired" ? -1 : 15),
    quotaUsed: String((status === "exhausted" ? 5 : 1) * GB),
  }));
  const devices = clients.map((item, i) => ({
    ...clone(device), id: `device-${i + 1}`, deviceId: item.deviceId, status: item.status,
    label: `Demo device ${i + 1}`, token: item.token, expireAt: item.expireAt,
  }));
  const profiles = [{ id: "profile-1", name: "Demo VPN profile", protocol: "vless", status: "active" }];
  const token = () => `SXB-USER-DEMO-TEST-${(++counter).toString(16).padStart(4, "0").toUpperCase()}`;
  const failure = (status, code, scope) => ({ status, body: { code, scope, error: "errors.auth.forbidden", message: code } });
  const ok = body => ({ status: 200, body });
  const roster = () => devices.map(row => {
    const owner = clients.find(item => item.deviceId === row.deviceId);
    const plan = subscriptions.find(item => item.clientId === owner?.id);
    return {
      ...row, hasSubscription: !!plan, subscriptionId: plan?.id ?? null, subscriptionName: plan?.name ?? null,
      subscriptionStatus: plan?.status ?? null, subscriptionExpireAt: plan?.expireAt ?? null,
      quotaSource: plan ? "subscription" : "client", quotaTotal: plan?.quotaBytes ?? owner?.quotaTotal ?? "0",
      quotaUsed: plan?.quotaUsed ?? owner?.quotaUsed ?? "0",
      quotaRemaining: String(Math.max(0, Number(plan?.quotaBytes ?? owner?.quotaTotal ?? 0) - Number(plan?.quotaUsed ?? owner?.quotaUsed ?? 0))),
    };
  });
  function route(method, pathname, body) {
    if (method === "POST" && pathname === "/__fixture/control") {
      if (["active", "expired", "suspended"].includes(body.accessState)) accessState = body.accessState;
      if (["available", "reached", "unlimited"].includes(body.quotaState)) quotaState = body.quotaState;
      if (Number.isInteger(body.delayMs) && body.delayMs >= 0 && body.delayMs <= 5000) delayMs = body.delayMs;
      if (typeof body.failNext === "boolean") failNext = body.failNext;
      return ok({ fixture: true });
    }
    if (!pathname.startsWith("/xapi/")) return failure(404, "FIXTURE_ROUTE_NOT_FOUND");
    if (method !== "GET" && failNext) {
      failNext = false;
      return failure(409, "OWNERSHIP_FORBIDDEN");
    }
    if (method === "GET") {
      if (pathname === "/xapi/devices") return ok({ devices: roster() });
      if (pathname === "/xapi/clients") return ok(clients);
      if (pathname === "/xapi/subscriptions") return ok({ subscriptions });
      if (pathname === "/xapi/subscriptions/stats") return ok({
        total: subscriptions.length, active: subscriptions.filter(row => row.status === "active").length,
        expired: subscriptions.filter(row => row.status === "expired").length,
      });
      if (pathname === "/xapi/resellers") return ok({ resellers: [{ id: "reseller-1", name: "Demo reseller", email: "reseller@example.test" }] });
      if (pathname === "/xapi/resellers/me/access") return ok({ resellerAccess: {
        resellerId: "reseller-1", resellerName: "Demo reseller", accessState, accessExpiresAt: date(365),
        quotaState, quotaBytes: quotaState === "unlimited" ? "-1" : String((quotaState === "reached" ? 25 : 100) * GB),
        quotaAllocatedBytes: String(25 * GB), quotaRemainingBytes: String((quotaState === "reached" ? 0 : 75) * GB),
        quotaUnlimited: quotaState === "unlimited",
      } });
      if (pathname === "/xapi/vpn-profiles" || pathname === "/xapi/vpn-profiles/assigned") return ok({ profiles });
    }
    if (method === "POST" && pathname === "/xapi/devices/generate-token") {
      const existing = devices.find(row => row.deviceId === body.deviceId);
      if (existing) return { status: 409, body: { device: existing } };
      const row = { ...clone(device), id: `device-${++counter}`, deviceId: body.deviceId, label: body.label, token: token(), expireAt: date(body.durationDays ?? 365) };
      devices.push(row);
      return ok(row);
    }
    if (method === "POST" && pathname === "/xapi/clients") {
      const row = { ...clone(client), id: `client-${++counter}`, token: token(), deviceId: null, user: { name: body.name, email: body.email }, expireAt: date(365) };
      clients.push(row);
      return ok(row);
    }
    const parts = pathname.split("/");
    if (["devices", "clients"].includes(parts[2]) && parts[3]) {
      const collection = parts[2] === "devices" ? devices : clients;
      const row = collection.find(item => item.id === parts[3]);
      if (!row) return failure(404, "DEVICE_DELETED", "device");
      const linked = (parts[2] === "devices" ? clients : devices).find(item => item.deviceId === row.deviceId);
      const change = values => { Object.assign(row, values); if (linked) Object.assign(linked, values); return ok(row); };
      if (method === "DELETE") { collection.splice(collection.indexOf(row), 1); return ok({ deleted: true }); }
      if (method === "POST") {
        if (parts[4] === "suspend") return change({ status: "suspended" });
        if (parts[4] === "revoke") return change({ status: "disabled" });
        if (parts[4] === "resume" || parts[4] === "activate") {
          if (Date.parse(row.expireAt) <= Date.now()) return failure(409, "DEVICE_EXPIRED", "device");
          if (row.status === "revoked") return failure(409, "DEVICE_REVOKED", "device");
          return change({ status: "active" });
        }
        if (parts[4] === "reset-access") return change({ token: token() });
        if (parts[4] === "renew") {
          const days = Number(body.durationDays ?? (parts[2] === "devices" ? 365 : 30));
          if (!Number.isInteger(days) || days < 1 || days > 3650) return failure(400, "VALIDATION_ERROR");
          return change({ status: "active", token: token(), expireAt: new Date(Math.max(Date.now(), Date.parse(row.expireAt) || 0) + days * DAY).toISOString() });
        }
      }
    }
    const addPlan = payload => {
      const row = {
        ...clone(subscription), ...payload, id: `plan-${++counter}`, dataToken: `DATA-DEMO-${counter}`,
        name: payload.name || `Demo plan ${counter}`, client: clients.find(item => item.id === payload.clientId),
        quotaBytes: String(Number(payload.quotaGB) * GB), quotaUsed: "0", expireAt: date(Number(payload.durationDays)),
      };
      subscriptions.push(row);
      return row;
    };
    if (method === "POST" && pathname === "/xapi/subscriptions") return ok({ subscription: addPlan(body) });
    if (method === "POST" && pathname === "/xapi/subscriptions/bulk") {
      if (body.action === "deploy") {
        for (const id of body.clientIds ?? []) addPlan({ ...body, clientId: id });
      } else {
        for (const id of body.subscriptionIds ?? []) {
          const row = subscriptions.find(item => item.id === id);
          if (!row) return failure(404, "CONFIG_DELETED", "subscription");
          if (body.action === "add_data") row.quotaBytes = String(Number(row.quotaBytes) + Number(body.quotaGB) * GB);
          if (body.action === "extend_duration") row.expireAt = new Date(Math.max(Date.now(), Date.parse(row.expireAt)) + Number(body.durationDays) * DAY).toISOString();
          if (body.action === "set") {
            row.quotaBytes = String(Number(body.quotaGB) * GB);
            row.expireAt = date(Number(body.durationDays));
          }
          if (["expired", "exhausted"].includes(row.status) && Date.parse(row.expireAt) > Date.now() &&
            (Number(row.quotaBytes) <= 0 || Number(row.quotaUsed) < Number(row.quotaBytes))) row.status = "active";
        }
      }
      const ids = body.subscriptionIds ?? body.clientIds ?? [];
      return ok({ action: body.action, selected: ids.length, succeeded: ids.length, failed: 0, skipped: 0, details: ids.map(id => ({ id, status: "succeeded" })) });
    }
    if (parts[2] === "subscriptions" && parts[3]) {
      const row = subscriptions.find(item => item.id === parts[3]);
      if (!row) return failure(404, "CONFIG_DELETED", "subscription");
      if (method === "DELETE") { subscriptions = subscriptions.filter(item => item !== row); return ok({ deleted: true }); }
      if (method === "POST" && parts[4] === "revoke") { row.status = "revoked"; return ok({ revoked: true }); }
      if (method === "PUT") {
        if (body.status === "active" && Date.parse(row.expireAt) <= Date.now()) return failure(409, "CONFIG_EXPIRED", "subscription");
        if (body.status === "active" && Number(row.quotaBytes) > 0 && Number(row.quotaUsed) >= Number(row.quotaBytes)) return failure(409, "CONFIG_EXHAUSTED", "subscription");
        Object.assign(row, body);
        if (body.quotaGB !== undefined) row.quotaBytes = String(Number(body.quotaGB) * GB);
        if (body.durationDays !== undefined) row.expireAt = date(Number(body.durationDays));
        return ok({ subscription: row });
      }
    }
    return failure(404, "FIXTURE_ROUTE_NOT_FOUND");
  }
  return async (request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
    response.setHeader("Cache-Control", "no-store");
    try {
      const origin = `http://${request.headers.host}`;
      const url = new URL(request.url, origin);
      if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname) ||
        (request.headers.origin && request.headers.origin !== origin)) {
        response.writeHead(403); response.end(); return;
      }
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset) { response.setHeader("Content-Type", asset.type); response.end(asset.body); return; }
      let content = "";
      for await (const chunk of request) {
        content += chunk;
        if (Buffer.byteLength(content) > 65536) { response.writeHead(413); response.end(); return; }
      }
      let body;
      try { body = content ? JSON.parse(content) : {}; }
      catch { response.writeHead(400); response.end(); return; }
      if (request.method !== "GET" && url.pathname.startsWith("/xapi/")) await new Promise(resolve => setTimeout(resolve, delayMs));
      const result = route(request.method, url.pathname, body);
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result.body));
    } catch {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "errors.server", message: "Local fixture request failed" }));
    }
  };
}

async function previewAssets() {
  const dashboard = path.join(root, "artifacts", "sxb-dashboard");
  const assetsRoot = path.join(dashboard, "dist", "public", "assets");
  const css = (await readdir(assetsRoot)).find(file => /^index-.*\.css$/.test(file));
  if (!css) throw new Error("Build the dashboard before starting its lifecycle preview.");
  const bundle = await build({
    absWorkingDir: dashboard,
    stdin: {
      resolveDir: dashboard, loader: "tsx", contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { Toaster } from "sonner";
        import DevicesView from "./src/components/DevicesView";
        import ClientsView from "./src/components/ClientsView";
        import SubscriptionsView from "./src/components/SubscriptionsView";
        import { I18nProvider, useTranslation } from "./src/contexts/I18nContext";
        import { PermissionsProvider } from "./src/contexts/PermissionsContext";
        import { ResellerAccessProvider } from "./src/contexts/ResellerAccessContext";
        import { UserRole } from "./src/types";
        const permissions = ["clients.view", "clients.create", "clients.manage", "clients.delete", "subscription.manage", "reseller.manage"];
        function Preview() {
          const { t, language, setLanguage } = useTranslation();
          const [view, setView] = useState("devices"), [role, setRole] = useState(UserRole.SUPER_ADMIN);
          const [revision, setRevision] = useState(0), [limit, setLimit] = useState("available");
          const control = async body => {
            const response = await fetch("/__fixture/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (!response.ok) throw new Error("Fixture control failed");
          };
          return <main style={{ padding: 24, maxWidth: 1600, margin: "auto" }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24, alignItems: "center" }}>
              <strong style={{ color: "#fbbf24" }}>LOCAL FIXTURE - NO PRODUCTION API</strong>
              {["devices", "clients", "subscriptions"].map(key => <button key={key} onClick={() => setView(key)} style={{ border: "1px solid #334155", padding: 8, color: view === key ? "#22d3ee" : "#ddd" }}>{t("commerce." + key + ".title")}</button>)}
              <select aria-label={t("commerce.common.role")} value={role} onChange={event => setRole(event.target.value)} style={{ background: "#0f172a" }}>
                {Object.values(UserRole).map(value => <option key={value}>{value}</option>)}
              </select>
              <select aria-label={t("commerce.common.quota")} value={limit} onChange={async event => { const next = event.target.value; await control({ quotaState: next }); setLimit(next); setRevision(value => value + 1); }} style={{ background: "#0f172a" }}>
                {["available", "reached", "unlimited"].map(value => <option key={value}>{value}</option>)}
              </select>
              <button onClick={() => setLanguage(language === "fr" ? "en" : "fr")}>FR / EN</button>
              <button onClick={() => control({ failNext: true })}>Fail next mutation (fixture)</button>
            </div>
            <PermissionsProvider role={role} permissions={permissions}>
              <ResellerAccessProvider key={role + revision} role={role}>
                {view === "devices" ? <DevicesView key={role} currentUserRole={role} /> :
                  view === "clients" ? <ClientsView key={role} currentUserRole={role} actorName="Fixture" /> :
                  <SubscriptionsView key={role} currentUserRole={role} />}
              </ResellerAccessProvider>
            </PermissionsProvider>
            <Toaster theme="dark" richColors />
          </main>;
        }
        createRoot(document.getElementById("root")).render(<I18nProvider><Preview /></I18nProvider>);
      `,
    },
    bundle: true, platform: "browser", format: "esm", jsx: "automatic", minify: true,
    write: false, logLevel: "silent",
  });
  return new Map([
    ["/", { type: "text/html; charset=utf-8", body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local dashboard lifecycle fixture</title><link rel="stylesheet" href="/preview.css"></head><body style="background:#07090e;color:#eee"><div id="root"></div><script type="module" src="/preview.js"></script></body></html>' }],
    ["/preview.js", { type: "text/javascript; charset=utf-8", body: bundle.outputFiles[0].contents }],
    ["/preview.css", { type: "text/css; charset=utf-8", body: await readFile(path.join(assetsRoot, css)) }],
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DASHBOARD_FIXTURE_PORT ?? 4175);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid DASHBOARD_FIXTURE_PORT");
  const server = http.createServer(createFixtureHandler(await previewAssets()));
  server.listen(port, "127.0.0.1", () => console.log(`Local dashboard fixture: http://127.0.0.1:${port} (synthetic data only)`));
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

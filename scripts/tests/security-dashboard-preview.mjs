// Synthetic UI fixture only: no account, proxy, database or production network.
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'backend', 'package.json'));
const dashboard = path.join(root, 'artifacts', 'sxb-dashboard');
const buildRoot = process.env.SXB_SECURITY_DASHBOARD_BUILD;
if (!buildRoot) throw new Error('Set SXB_SECURITY_DASHBOARD_BUILD to a local dashboard build output');
const assetRoot = path.join(buildRoot, 'assets');
const html = await readFile(path.join(buildRoot, 'index.html'), 'utf8');
const css = html.match(/href="[^"]*\/assets\/([^"/]+\.css)"/)?.[1];
if (!css) throw new Error('Dashboard CSS build is missing');
const bundle = await require('esbuild').build({
  absWorkingDir: dashboard, bundle: true, platform: 'browser', format: 'esm',
  jsx: 'automatic', write: false, logLevel: 'silent',
  stdin: { resolveDir: dashboard, loader: 'tsx', contents: `
    import React, { useEffect, useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { Toaster } from "sonner";
    import SecurityCenterView from "./src/components/SecurityCenterView";
    import SessionsView from "./src/components/SessionsView";
    import { I18nProvider, useTranslation } from "./src/contexts/I18nContext";
    import { installResponsiveTables } from "./src/lib/responsiveTables";
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 30000) window.fixtureSecurityPoll = callback;
      return interval(callback, delay, ...args);
    };
    function Preview() {
      const { language, setLanguage } = useTranslation();
      const [view, setView] = useState("security");
      const [role, setRole] = useState("OWNER");
      const mainRef = useRef(null);
      useEffect(() => mainRef.current ? installResponsiveTables(mainRef.current) : undefined, []);
      return <main ref={mainRef} style={{ padding: 20, maxWidth: 1600, margin: "auto" }}>
        <header style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
          <strong>LOCAL SYNTHETIC TEST FIXTURE - NO PRODUCTION API</strong>
          <button onClick={() => setView(view === "security" ? "sessions" : "security")}>Security / Sessions</button>
          <button onClick={() => setLanguage(language === "fr" ? "en" : "fr")}>FR / EN</button>
          <select aria-label="Fixture role" value={role} onChange={async event => {
            const value = event.target.value;
            const response = await fetch("/fixture/role", {method:"POST",body:JSON.stringify({role:value})});
            if (!response.ok) throw new Error("Fixture role failed"); setRole(value);
          }}>{["OWNER","ADMIN","SUPPORT"].map(value => <option key={value}>{value}</option>)}</select>
        </header>
        {view === "security" ? <SecurityCenterView key={role} currentUserRole={role}
          currentUser={{id:"synthetic-owner",name:"Synthetic operator",email:"synthetic@example.invalid",role}} /> :
          <SessionsView key={role} />}
        <Toaster theme="dark" />
      </main>;
    }
    createRoot(document.getElementById("root")).render(<I18nProvider><Preview /></I18nProvider>);
  ` },
});
let role = 'OWNER';
const signer = '0140c97e6ba6e9bab0d0ce86935562fbdedd80a026de49642764c49dce56f726';
let policy = { version: 1, medium: 30, high: 65,
  weights: { signatureInvalid: 75, decoyTouched: 40, hooked: 50, frida: 50, xposed: 40,
    attestationFailed: 40, debugger: 30, rooted: 10, emulator: 10 },
  certificates: [signer], packageName: 'com.sxbvpn.mobile' };
let revoked = false;
const now = new Date().toISOString();
const event = { id: 'synthetic-event', eventType: 'VPN_REVOKED', severity: 'info',
  userId: 'synthetic-user', deviceId: 'synthetic-device', sessionId: 'synthetic-session',
  sessionGeneration: 7, connectionId: 'synthetic-connection', policyVersion: 1, riskLevel: 'LOW',
  actionTaken: 'CONNECTION_CLOSED', metadata: null, ipHash: null, appVersion: 'test',
  acknowledged: false, acknowledgedAt: null, createdAt: now };
const assets = new Map([
  ['/', ['text/html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local synthetic security fixture</title><link rel="stylesheet" href="/preview.css"></head><body style="background:#07090e;color:#eee"><div id="root"></div><script type="module" src="/preview.js"></script></body></html>']],
  ['/preview.js', ['text/javascript', bundle.outputFiles[0].contents]],
  ['/preview.css', ['text/css', await readFile(path.join(assetRoot, css))]],
]);
const port = Number(process.env.SXB_SECURITY_DASHBOARD_PORT ?? 4189);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback fixture port');
const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  response.setHeader('Cache-Control', 'no-store');
  const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  try {
    const origin = `http://127.0.0.1:${port}`;
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin)) return send(403, { error: 'FIXTURE_ORIGIN_DENIED' });
    const url = new URL(request.url, origin), route = url.pathname;
    if (assets.has(route)) {
      const [type, contents] = assets.get(route);
      response.writeHead(200, { 'Content-Type': type }); response.end(contents); return;
    }
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536) return send(413, { error: 'FIXTURE_BODY_TOO_LARGE' });
    }
    const body = raw ? JSON.parse(raw) : {};
    if (route === '/fixture/role') { role = body.role; return send(200, { synthetic: true }); }
    if (route.startsWith('/xapi/security/') && role !== 'OWNER') return send(404, { error: 'errors.not_found' });
    if (route === '/xapi/security/gate') return send(200, {
      configured: true, canConfigure: true, unlocked: false, unlockExpiresAt: null,
      passkeyVerified: false, passkeyRequired: false, passkeys: [], rpId: '127.0.0.1', unlockSeconds: 900, updatedAt: now,
    });
    if (route === '/xapi/security/gate/unlock') return body.password === 'synthetic-fixture'
      ? send(200, { step: 'unlocked', unlockToken: 'local-test-unlock', expiresAt: new Date(Date.now() + 900000).toISOString(), passkeyVerified: false })
      : send(403, { error: 'errors.auth.forbidden' });
    if (route.startsWith('/xapi/security/') && request.headers['x-sxb-security-unlock'] !== 'local-test-unlock') return send(423, { error: 'SECURITY_LOCKED' });
    if (route === '/xapi/security/overview') return send(200, {
      overview: { total: 1, critical: 0, warning: 0, info: 1, unacknowledged: event.acknowledged ? 0 : 1, last24h: 1, latestAt: now },
      severities: ['info', 'warning', 'critical'], eventTypes: ['VPN_REVOKED', 'APP_INTEGRITY_FAILED', 'DEVICE_MISMATCH', 'TOKEN_REPLAY'],
    });
    if (route === '/xapi/security/policy') {
      if (request.method === 'PUT') {
        if (body.version !== policy.version + 1) return send(409, { error: 'SECURITY_POLICY_VERSION_CONFLICT' });
        policy = body;
      }
      return send(200, policy);
    }
    if (route === '/xapi/security/audit') return send(200, { entries: [], total: 0, limit: 50 });
    if (route === '/xapi/security/events/acknowledge') { event.acknowledged = true; return send(200, { acknowledged: 1 }); }
    if (route === '/xapi/security/events') {
      const matches = ['sessionId', 'deviceId', 'userId', 'eventType', 'severity'].every(key => !url.searchParams.get(key) || event[key] === url.searchParams.get(key));
      return send(200, { events: matches ? [event] : [], total: matches ? 1 : 0, limit: 25, offset: 0 });
    }
    if (/\/authorize-key$/.test(route)) return route.includes('/missing/')
      ? send(404, { error: 'errors.not_found' }) : send(200, { authorized: true, expiresInSeconds: 600 });
    if (/\/(revoke|security-revoke)$/.test(route)) { revoked = body.generation === 7; return send(200, { revoked }); }
    if (route === '/xapi/sessions') return send(200, { sessions: [{
      id: 'synthetic-session', clientId: 'synthetic-client', clientName: 'SYNTHETIC client',
      clientToken: 'SXB-USER-SYNTHETIC', deviceId: 'synthetic-device', activationDate: now, expirationDate: null,
      lastSync: now, status: 'active', authGeneration: 7, authRevokedAt: revoked ? now : null,
      canRevokeSecurity: role !== 'SUPPORT', ipAddress: null, userAgent: null,
    }] });
    if (/\/security-events$/.test(route)) {
      const { userId, deviceId, metadata, ...projection } = event;
      return send(200, { events: [projection], total: 1 });
    }
    send(404, { error: 'FIXTURE_ROUTE_NOT_FOUND' });
  } catch (error) { console.error('Local synthetic UI fixture failed:', error.message); send(500, { error: 'FIXTURE_FAILED' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Synthetic fixture only: http://127.0.0.1:${port}`));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());

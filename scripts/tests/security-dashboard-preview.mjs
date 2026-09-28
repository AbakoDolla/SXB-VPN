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
    import ErrorBoundary from "./src/components/ErrorBoundary";
    import SessionsView from "./src/components/SessionsView";
    import { I18nProvider, useTranslation } from "./src/contexts/I18nContext";
    import { installResponsiveTables } from "./src/lib/responsiveTables";
    const interval = window.setInterval.bind(window);
    if (new URLSearchParams(location.search).get("notification") === "android") {
      class AndroidNotification {
        static permission = "granted";
        constructor() { throw new TypeError("Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead."); }
      }
      Object.defineProperty(window, "Notification", { configurable: true, value: AndroidNotification });
    }
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
          }}>{["OWNER","SUPER_ADMIN","ADMIN","SUPPORT"].map(value => <option key={value}>{value}</option>)}</select>
        </header>
        <ErrorBoundary resetKey={role + view}>{view === "security" ? <SecurityCenterView key={role} currentUserRole={role}
          currentUser={{id:"synthetic-" + role.toLowerCase(),name:"Synthetic operator",email:"synthetic@example.invalid",role}} /> :
          <SessionsView key={role} />}</ErrorBoundary>
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
const securityEvents = Array.from({ length: 56 }, (_, index) => ({
  ...event, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  userId: index >= 50 ? 'synthetic-owner' : event.userId,
  severity: index % 3 === 0 ? 'critical' : index % 3 === 1 ? 'warning' : 'info',
  riskLevel: index % 3 === 0 ? 'CRITICAL' : index % 3 === 1 ? 'HIGH' : 'LOW',
  metadata: JSON.stringify({ evidence: 'server_authorized', reason: `SYNTHETIC investigation ${index + 1}`, role: index >= 50 ? 'OWNER' : 'CLIENT' }),
  createdAt: new Date(Date.now() - index * 60_000).toISOString(),
}));
const securitySessions = Array.from({ length: 31 }, (_, index) => ({
  id: index === 0 ? 'synthetic-session' : `synthetic-session-${index}`,
  clientId: `synthetic-client-${index}`, deviceId: `SYNTHETIC-DEVICE-${index}`,
  activationDate: now, lastSync: now, authGeneration: 7, authRevokedAt: null,
  authExpiresAt: new Date(Date.now() + 600_000).toISOString(), ipAddress: '192.0.2.1',
  client: { deviceKeyId: signer, enrollmentGrantExpiresAt: null,
    user: { id: index >= 27 ? 'synthetic-owner' : `synthetic-client-user-${index}`, name: `SYNTHETIC ${index >= 27 ? 'PRIVATE OWNER' : 'client'} ${index + 1}` } },
}));
const auditEntries = Array.from({ length: 38 }, (_, index) => ({
  id: `synthetic-audit-${index}`, action: `SYNTHETIC ${index >= 30 ? 'PRIVATE OWNER' : 'operator'} action ${index + 1}`,
  user: { id: index >= 30 ? 'synthetic-owner' : 'synthetic-super', name: index >= 30 ? 'PRIVATE OWNER' : 'Synthetic operator', email: 'synthetic@example.invalid' },
  timestamp: new Date(Date.now() - index * 60_000).toISOString(), type: index % 2 ? 'warning' : 'info',
  ipAddress: '192.0.2.1', visibleOwnerOnly: index >= 30,
}));
let failReads = false;
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
    if (route === '/fixture/reset') {
      role = 'OWNER'; failReads = false; revoked = false;
      securityEvents.forEach(item => { item.acknowledged = false; item.acknowledgedAt = null; });
      securitySessions.forEach(item => { item.authRevokedAt = null; });
      return send(200, { synthetic: true });
    }
    if (route === '/fixture/role') { role = body.role; return send(200, { synthetic: true }); }
    if (route === '/fixture/failure') { failReads = body.enabled === true; return send(200, { synthetic: true }); }
    if (route.startsWith('/xapi/security/') && !['OWNER', 'SUPER_ADMIN'].includes(role)) return send(404, { error: 'errors.not_found' });
    if (route === '/xapi/security/gate') return send(200, {
      configured: true, canConfigure: role === 'OWNER', unlocked: false, unlockExpiresAt: null,
      passkeyVerified: false, passkeyRequired: false, passkeys: [], rpId: '127.0.0.1', unlockSeconds: 900, updatedAt: now,
    });
    if (route === '/xapi/security/gate/unlock') return body.password === 'synthetic-fixture'
      ? send(200, { step: 'unlocked', unlockToken: 'local-test-unlock', expiresAt: new Date(Date.now() + 900000).toISOString(), passkeyVerified: false })
      : send(403, { error: 'errors.auth.forbidden' });
    if (route.startsWith('/xapi/security/') && request.headers['x-sxb-security-unlock'] !== 'local-test-unlock') return send(423, { error: 'SECURITY_LOCKED' });
    if (failReads && route.startsWith('/xapi/security/') && request.method === 'GET') return send(503, { error: 'SECURITY_UNAVAILABLE' });
    const visibleEvents = securityEvents.filter(item => role === 'OWNER' || item.userId !== 'synthetic-owner');
    const page = items => {
      const limit = Number(url.searchParams.get('limit') || 25), offset = Number(url.searchParams.get('offset') || 0);
      return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
    };
    if (route === '/xapi/security/overview') return send(200, {
      overview: { total: visibleEvents.length, critical: visibleEvents.filter(item => item.severity === 'critical').length,
        warning: visibleEvents.filter(item => item.severity === 'warning').length, info: visibleEvents.filter(item => item.severity === 'info').length,
        unacknowledged: visibleEvents.filter(item => !item.acknowledged).length, last24h: visibleEvents.length, latestAt: now },
      severities: ['info', 'warning', 'critical'], eventTypes: ['VPN_REVOKED', 'APP_INTEGRITY_FAILED', 'DEVICE_MISMATCH', 'TOKEN_REPLAY'],
    });
    if (route === '/xapi/security/policy') {
      if (request.method === 'PUT') {
        if (role !== 'OWNER') return send(403, { error: 'errors.auth.forbidden' });
        if (body.version !== policy.version + 1) return send(409, { error: 'SECURITY_POLICY_VERSION_CONFLICT' });
        policy = body;
      }
      return send(200, policy);
    }
    if (route === '/xapi/security/audit') {
      const result = page(auditEntries.filter(item => (role === 'OWNER' || !item.visibleOwnerOnly)
        && (url.searchParams.get('ownerOnly') !== 'true' || item.visibleOwnerOnly)
        && (!url.searchParams.get('type') || item.type === url.searchParams.get('type'))
        && JSON.stringify(item).toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase())));
      const { items, ...meta } = result;
      return send(200, { entries: items, ...meta });
    }
    if (route === '/xapi/security/sessions') {
      const rows = securitySessions.filter(item => role === 'OWNER' || item.client.user.id !== 'synthetic-owner')
        .map(item => ({ ...item, state: item.authRevokedAt ? 'revoked' : 'active' }))
        .filter(item => (!url.searchParams.get('state') || item.state === url.searchParams.get('state'))
          && JSON.stringify(item).toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase()));
      const { items, ...meta } = page(rows);
      return send(200, { sessions: items, ...meta });
    }
    if (route === '/xapi/security/events/acknowledge') {
      const changed = visibleEvents.filter(item => body.ids.includes(item.id));
      changed.forEach(item => { item.acknowledged = body.acknowledged !== false; });
      return send(200, { acknowledged: changed.length });
    }
    if (route === '/xapi/security/events') {
      const matches = visibleEvents.filter(item =>
        ['sessionId', 'deviceId', 'userId', 'eventType', 'severity', 'riskLevel', 'acknowledged'].every(key => !url.searchParams.get(key) || String(item[key]) === url.searchParams.get(key))
        && (!url.searchParams.get('from') || Date.parse(item.createdAt) >= Date.parse(url.searchParams.get('from')))
        && (!url.searchParams.get('to') || Date.parse(item.createdAt) <= Date.parse(url.searchParams.get('to')))
        && JSON.stringify(item).toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase()));
      const { items, ...meta } = page(matches);
      return send(200, { events: items, ...meta });
    }
    if (/\/authorize-key$/.test(route)) return route.includes('/missing/')
      ? send(404, { error: 'errors.not_found' }) : send(200, { authorized: true, expiresInSeconds: 600 });
    if (/\/(revoke|security-revoke)$/.test(route)) {
      const session = securitySessions.find(item => route.includes(`/${item.id}/`));
      revoked = !!session && body.generation === session.authGeneration && (role === 'OWNER' || session.client.user.id !== 'synthetic-owner');
      if (revoked) session.authRevokedAt = new Date().toISOString();
      return send(200, { revoked });
    }
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

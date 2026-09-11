import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = (path) => readFileSync(path, 'utf8');

describe('mobile health wiring and privacy', () => {
  it('mounts the live route and protects ingestion and administration', () => {
    const server = source('server.ts');
    const route = source('server/routes/mobile-health.ts');

    assert.match(server, /app\.use\("\/api\/mobile-health", mobileHealthRouter\)/);
    assert.match(route, /router\.post\("\/report", requireAuth/);
    assert.match(route, /req\.user\?\.role !== "CLIENT"/);
    assert.match(route, /router\.get\([\s\S]{0,80}"\/summary"[\s\S]{0,120}requireAuth[\s\S]{0,80}requireRole\(\["SUPER_ADMIN", "ADMIN"\]\)/);
  });

  it('stores only pseudonymous allowlisted fields', () => {
    const service = source('server/services/mobile-health.ts');
    const schema = source('backend/prisma/schema.prisma');
    const rootSchema = source('prisma/schema.prisma');
    const deviceModel = schema.slice(schema.indexOf('model MobileHealthDevice'));

    // Le calcul vit à part (`mobile-pseudonym.ts`) pour que le suivi de
    // présence puisse l'appeler sans embarquer la validation d'entrée ni la
    // base. Ce qui compte reste vérifié : c'est un HMAC-SHA256 lié à un secret
    // serveur, et le service continue d'écrire ce pseudonyme et lui seul.
    const pseudonym = source('server/services/mobile-pseudonym.ts');
    assert.match(pseudonym, /createHmac\("sha256", secret\)/);
    assert.match(pseudonym, /\.update\(`\$\{userId\}\\0\$\{deviceId\}`\)/);
    assert.match(service, /export \{ pseudonymizeMobileDevice \} from "\.\/mobile-pseudonym"/);
    assert.doesNotMatch(pseudonym, /prisma|import .* from "\.\.\/database"/);
    assert.match(service, /\.strict\(\)/);
    assert.match(service, /reportId: z\.string\(\)\.uuid\(\)/);
    assert.match(service, /error\?\.code !== "P2002" \|\| !target\.includes\("reportId"\)/);
    assert.equal(schema.replace(/\r\n/g, '\n').trim(), rootSchema.replace(/\r\n/g, '\n').trim());
    for (const forbidden of ['host ', 'ipAddress', 'payload ', 'credentials', 'rawLog']) {
      assert.equal(deviceModel.includes(forbidden), false, `${forbidden} must not be persisted`);
    }
    assert.match(deviceModel, /@@map\("mobile_health_devices"\)/);
    assert.match(deviceModel, /@@map\("mobile_health_reports"\)/);

    const migration = source('backend/prisma/migrations/202609070507_mobile_health/migration.sql');
    const deviceTable = migration.slice(
      migration.indexOf('CREATE TABLE "mobile_health_devices"'),
      migration.indexOf('CREATE TABLE "mobile_health_reports"'),
    );
    const reportTable = migration.slice(migration.indexOf('CREATE TABLE "mobile_health_reports"'));
    assert.doesNotMatch(deviceTable, /"reportId"/);
    assert.match(reportTable, /"reportId" TEXT NOT NULL/);
  });

  it('reports on lifecycle/session events without adding telemetry polling', () => {
    const telemetry = source('app-mobile/services/mobileHealth.ts');
    const context = source('app-mobile/contexts/VpnContext.tsx');
    const nativeModule = source('app-mobile/modules/android-native/SxbVpnModule.kt');

    // The telemetry service owns no clock of its own.
    assert.doesNotMatch(telemetry, /setInterval\(/);
    // The one periodic send is the presence heartbeat, armed by the VPN context
    // for a live tunnel only and torn down as soon as the tunnel stops, so a
    // device that silently loses the network stops counting as connected.
    assert.match(telemetry, /export async function sendMobileHealthHeartbeat/);
    assert.match(telemetry, /snapshot\.tunnelState !== 'connected'\) return false/);
    assert.match(context, /vpnState !== 'connected'\) return;/);
    assert.match(context, /clearInterval\(heartbeatTimerRef\.current\)/);
    assert.match(context, /noteMobileHealthAppState\(next\)/);
    assert.match(context, /outcome: 'success'/);
    assert.match(context, /outcome: 'failure'/);
    assert.match(telemetry, /pending\.outbox\.push\(payload\)/);
    assert.match(telemetry, /pending\.outbox\.shift\(\)/);
    assert.match(nativeModule, /isIgnoringBatteryOptimizations/);
    assert.doesNotMatch(nativeModule, /REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
  });

  it('keeps the presence heartbeat cheap and non-retrying', () => {
    const telemetry = source('app-mobile/services/mobileHealth.ts');
    const service = source('server/services/mobile-health.ts');
    const heartbeat = telemetry.slice(telemetry.indexOf('export async function sendMobileHealthHeartbeat'));

    // A queued heartbeat replayed later would assert a presence that expired.
    assert.doesNotMatch(heartbeat.slice(0, heartbeat.indexOf('export async function clearMobileHealth')), /outbox|persist\(/);
    // A heartbeat writes no history row: at one every few minutes it would
    // otherwise multiply mobile_health_reports by hundreds per device per day.
    assert.match(service, /if \(input\.heartbeat\) \{/);
    assert.match(service, /heartbeat: z\.boolean\(\)\.default\(false\)/);
  });

  it('leaves the dead duplicated backend server untouched', () => {
    assert.doesNotMatch(source('backend/server.ts'), /mobile-health|mobileHealth/i);
  });

  it('exposes only an administrator dashboard with anonymized details', () => {
    const app = source('artifacts/sxb-dashboard/src/App.tsx');
    const layout = source('artifacts/sxb-dashboard/src/components/Layout.tsx');
    const view = source('artifacts/sxb-dashboard/src/components/MobileHealthView.tsx');

    assert.match(app, /case 'mobile-health'/);
    assert.match(app, /UserRole\.OWNER[\s\S]{0,100}UserRole\.SUPER_ADMIN[\s\S]{0,100}UserRole\.ADMIN/);
    assert.match(layout, /id: 'mobile-health'[\s\S]{0,120}roles: ADMINS/);
    const labels = JSON.parse(source('artifacts/sxb-dashboard/src/locales/fr/operations.json')).mobileHealth;
    for (const [key, text] of [
      ['installedVersions', /Versions installées/], ['activity', /Actifs \/ inactifs/],
      ['updatesNeeded', /Mises à jour nécessaires/], ['proxyExplanation', /ne doivent jamais être[\s\S]{0,80}interprétés comme des mAh/],
    ]) {
      assert.ok(view.includes(`operations.mobileHealth.${key}`));
      assert.match(labels[key], text);
    }
    assert.doesNotMatch(view, /\bhost\b|ipAddress|payload|credentials|rawLog/);
  });
});

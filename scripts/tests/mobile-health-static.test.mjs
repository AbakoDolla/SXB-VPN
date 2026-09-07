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

    assert.match(service, /createHmac\("sha256", secret\)/);
    assert.match(service, /\.strict\(\)/);
    assert.match(service, /reportId: z\.string\(\)\.uuid\(\)/);
    assert.match(service, /error\?\.code !== "P2002" \|\| !target\.includes\("reportId"\)/);
    assert.equal(schema.replace(/\r\n/g, '\n').trim(), rootSchema.replace(/\r\n/g, '\n').trim());
    for (const forbidden of ['host ', 'ipAddress', 'payload ', 'credentials', 'rawLog']) {
      assert.equal(deviceModel.includes(forbidden), false, `${forbidden} must not be persisted`);
    }
    assert.match(deviceModel, /@@map\("mobile_health_devices"\)/);
    assert.match(deviceModel, /@@map\("mobile_health_reports"\)/);
  });

  it('reports on lifecycle/session events without adding telemetry polling', () => {
    const telemetry = source('app-mobile/services/mobileHealth.ts');
    const context = source('app-mobile/contexts/VpnContext.tsx');
    const nativeModule = source('app-mobile/modules/android-native/SxbVpnModule.kt');

    assert.doesNotMatch(telemetry, /setInterval\(/);
    assert.match(context, /noteMobileHealthAppState\(next\)/);
    assert.match(context, /outcome: 'success'/);
    assert.match(context, /outcome: 'failure'/);
    assert.match(telemetry, /pending\.outbox\.push\(payload\)/);
    assert.match(telemetry, /pending\.outbox\.shift\(\)/);
    assert.match(nativeModule, /isIgnoringBatteryOptimizations/);
    assert.doesNotMatch(nativeModule, /REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
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
    assert.match(view, /Versions installées/);
    assert.match(view, /Actifs \/ inactifs/);
    assert.match(view, /Mises à jour nécessaires/);
    assert.match(view, /ne doivent jamais être[\s\S]{0,80}interprétés comme des mAh/);
    assert.doesNotMatch(view, /\bhost\b|ipAddress|payload|credentials|rawLog/);
  });
});

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

const SETTING = 'sxb.app-update.v1';
const APK_URL = 'https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk';
const digest = value => createHash('sha256').update(value).digest('hex');

function validateBuild(build, expectedVersion, expectedSha) {
  if (!build || !Number.isSafeInteger(build.versionCode) || build.versionCode <= 0 ||
      typeof build.versionName !== 'string' || !build.versionName ||
      build.apkUrl !== APK_URL || !/^[a-f0-9]{64}$/.test(build.apkSha256) ||
      !Number.isSafeInteger(build.sizeBytes) || build.sizeBytes <= 0) throw Error('MOBILE_BUILD_INVALID');
  if (build.versionCode !== expectedVersion || build.apkSha256 !== expectedSha) throw Error('MOBILE_BUILD_CHANGED');
}

async function rollout(db, options) {
  const setting = await db.setting.findUnique({ where: { key: SETTING } });
  const previous = setting ? digest(setting.value) : 'absent';
  const current = setting ? JSON.parse(setting.value) : null;
  if (options.mode === 'inspect') {
    const active = { status: 'active', deviceId: { not: null } };
    const [activated, legacy, sshLegacy] = await Promise.all([
      db.vpnClient.count({ where: active }),
      db.vpnClient.count({ where: { ...active, deviceKeyId: null } }),
      db.subscription.count({ where: { status: 'active', profile: { protocol: { in: ['ssh', 'ssh+payload'] } },
        client: { ...active, deviceKeyId: null } } }),
    ]);
    return { status: 'inspected', activated, legacy, sshLegacy, publicationRevision: previous,
      publication: current ? { active: current.active !== false, versionCode: current.versionCode,
        targetedDevices: current.targetDeviceIds?.length ?? 0 } : null };
  }
  if (options.mode !== 'publish-all' || !options.confirmed) throw Error('MOBILE_PUBLICATION_NOT_CONFIRMED');
  validateBuild(options.build, options.versionCode, options.apkSha256);
  if (current?.versionCode > options.build.versionCode) throw Error('MOBILE_PUBLICATION_DOWNGRADE');
  const next = {
    id: current?.id || randomUUID(), versionCode: options.build.versionCode, versionName: options.build.versionName,
    apkUrl: APK_URL, apkSha256: options.build.apkSha256,
    notes: 'Correctifs SSH multiappareils, journal de connexion et arrêt des forfaits épuisés.',
    minSupportedCode: 0, forceUpdate: false, active: true,
    targetRoles: current?.targetRoles ?? ['OWNER', 'SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'RESELLER'],
    targetDeviceIds: [], publishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  if (current?.active && current.versionCode === next.versionCode && current.apkSha256 === next.apkSha256 &&
      current.apkUrl === next.apkUrl && current.targetDeviceIds?.length === 0) {
    return { status: 'already-published', versionCode: next.versionCode, apkSha256: next.apkSha256, targetedDevices: 0 };
  }
  if (options.expectedPublication !== previous) throw Error('MOBILE_PUBLICATION_CHANGED');
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('sxb-mobile-release-rollout'))`;
    const latest = await tx.setting.findUnique({ where: { key: SETTING } });
    if ((latest ? digest(latest.value) : 'absent') !== previous) throw Error('MOBILE_PUBLICATION_CHANGED');
    if (latest) {
      const updated = await tx.setting.updateMany({ where: { key: SETTING, value: latest.value },
        data: { value: JSON.stringify(next) } });
      if (updated.count !== 1) throw Error('MOBILE_PUBLICATION_CHANGED');
    } else await tx.setting.create({ data: { key: SETTING, value: JSON.stringify(next) } });
  });
  return { status: 'published', versionCode: next.versionCode, apkSha256: next.apkSha256, targetedDevices: 0 };
}

async function main() {
  const root = '/var/www/sxb-vpn';
  if (process.platform !== 'linux' || process.cwd() !== root) throw Error('MOBILE_PRODUCTION_ROOT_REQUIRED');
  const requireBackend = createRequire(path.join(root, 'backend', 'package.json'));
  requireBackend('dotenv').config({ path: path.join(root, '.env'), quiet: true });
  const mode = process.env.SXB_MOBILE_MODE;
  let build;
  if (mode === 'publish-all') {
    build = JSON.parse(fs.readFileSync('/var/www/apk/latest-build.json', 'utf8'));
    validateBuild(build, Number(process.env.SXB_MOBILE_VERSION), process.env.SXB_MOBILE_SHA);
    const apk = path.join(root, 'dist', 'download', 'sxbvpn-latest.apk');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(apk)) { hash.update(chunk); bytes += chunk.length; }
    if (hash.digest('hex') !== build.apkSha256 || bytes !== build.sizeBytes) throw Error('MOBILE_APK_MISMATCH');
  }
  const { PrismaClient } = requireBackend('@prisma/client');
  const db = new PrismaClient();
  try {
    console.log(JSON.stringify(await rollout(db, {
      mode, build, versionCode: Number(process.env.SXB_MOBILE_VERSION), apkSha256: process.env.SXB_MOBILE_SHA,
      confirmed: process.env.SXB_MOBILE_CONFIRMED === 'true', expectedPublication: process.env.SXB_MOBILE_PUBLICATION,
    })));
  } finally { await db.$disconnect(); }
}

module.exports = { rollout, validateBuild, digest };
if (require.main === module) main().catch(error => {
  const code = /^MOBILE_[A-Z_]+$/.test(error.message) ? error.message : 'MOBILE_ROLLOUT_FAILED';
  console.error(code);
  process.exitCode = 1;
});

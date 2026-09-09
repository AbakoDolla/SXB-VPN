const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseVersionCode } = require('./android-version.cjs');

function verifyConfig(config, versionCode) {
  assert.equal(config.extra?.distribution, 'play', 'Expo config must select Play distribution');
  assert.equal(config.android?.package, 'com.sxbvpn.mobile');
  assert.equal(config.android?.versionCode, versionCode, 'Expo and native versions must agree');
  assert.ok(!config.extra?.eas?.projectId ||
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(config.extra.eas.projectId),
  'Placeholder EAS project is forbidden');
}

module.exports = { verifyConfig };

if (require.main === module) {
  verifyConfig(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
    parseVersionCode(process.env.SXB_ANDROID_VERSION_CODE));
}

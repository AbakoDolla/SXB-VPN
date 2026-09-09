const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseVersionCode } = require('./android-version.cjs');

function parseBaseline(badging, signature) {
  const identity = badging.match(/^package: name='([^']+)' versionCode='(\d+)'/m);
  assert.ok(identity, 'APK identity unavailable');
  assert.equal(identity[1], 'com.sxbvpn.mobile', 'Wrong direct APK applicationId');
  assert.doesNotMatch(signature, /Android Debug/i, 'Debug APK baseline is forbidden');
  const fingerprints = [...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$/gim)];
  assert.equal(fingerprints.length, 1, 'Exactly one verified direct APK signer required');
  assert.match(signature, /^Verified using v2 scheme \(APK Signature Scheme v2\): true$/m);
  return {
    versionCode: parseVersionCode(identity[2]),
    certificateSha256: fingerprints[0][1].toLowerCase(),
  };
}

module.exports = { parseBaseline };

if (require.main === module) {
  const root = process.env.SXB_BASELINE_DIR;
  assert.ok(root && process.env.GITHUB_ENV, 'Baseline and GitHub environment paths required');
  const baseline = parseBaseline(fs.readFileSync(path.join(root, 'badging.txt'), 'utf8'),
    fs.readFileSync(path.join(root, 'signature.txt'), 'utf8'));
  baseline.apkSha256 = createHash('sha256').update(fs.readFileSync(path.join(root, 'sxb-vpn.apk'))).digest('hex');
  fs.writeFileSync(path.join(root, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'version-code.txt'), `${baseline.versionCode}\n`);
  fs.appendFileSync(process.env.GITHUB_ENV,
    `SXB_PUBLISHED_VERSION_CODE=${baseline.versionCode}\nSXB_DIRECT_CERT_SHA256=${baseline.certificateSha256}\n`);
}

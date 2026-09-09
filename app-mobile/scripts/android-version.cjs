const EPOCH = Date.UTC(2020, 0, 1);
const MAX_VERSION_CODE = 2100000000;

function parseVersionCode(value, allowZero = false) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Invalid Android versionCode');
  const code = Number(value);
  if (!Number.isSafeInteger(code) || code < (allowZero ? 0 : 1) || code > MAX_VERSION_CODE) {
    throw new Error('Android versionCode outside Play range');
  }
  return code;
}

function selectVersionCode({ base, published = 0, previousPlay = 0, requested = '', now = Date.now() }) {
  const floor = Math.max(parseVersionCode(base), parseVersionCode(published, true),
    parseVersionCode(previousPlay, true));
  // Both channels use the same UTC clock, not independent workflow run counters.
  // The shared publication-apk concurrency group serializes builds. No future
  // manual reservation is allowed: the next direct build must remain upgradeable.
  const clock = parseVersionCode(Math.floor((now - EPOCH) / 1000));
  const code = requested === '' ? clock : parseVersionCode(requested);
  if (code <= floor) throw new Error(`versionCode ${code} must exceed known version ${floor}`);
  if (code > clock) throw new Error('Future versionCode would block subsequent direct APK updates');
  return code;
}

module.exports = { parseVersionCode, selectVersionCode };

if (require.main === module) {
  const config = require('../app.json').expo;
  const code = selectVersionCode({
    base: config.android.versionCode,
    published: process.env.SXB_PUBLISHED_VERSION_CODE || 0,
    previousPlay: process.env.SXB_PREVIOUS_PLAY_VERSION_CODE ?? 0,
    requested: process.env.SXB_REQUESTED_VERSION_CODE || '',
  });
  process.stdout.write(`${code}\n`);
}

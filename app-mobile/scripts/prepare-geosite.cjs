const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

const VERSION = '20260908094002';
const SHA256 = '03cbdc0ceab1aa8f0620af77d32e990a3850acb653ffdced8efac137277930b2';
const URL = `https://github.com/SagerNet/sing-geosite/releases/download/${VERSION}/geosite.db`;
const DEFAULT_DIRECTORY = path.resolve(__dirname, '..', 'build', 'engine-data');
const hash = data => createHash('sha256').update(data).digest('hex');

async function prepareGeosite(directory = DEFAULT_DIRECTORY) {
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'geosite.db');
  let current;
  try { current = await fs.readFile(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!current || hash(current) !== SHA256) {
    const response = await fetch(URL, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok && response.url.startsWith('https://'), 'GEOSITE_DOWNLOAD_FAILED');
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(body), SHA256, 'GEOSITE_CHECKSUM_MISMATCH');
    const temporary = path.join(directory, `.geosite-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  await fs.writeFile(path.join(directory, 'geosite.sha256'), SHA256 + '\n');
  return target;
}

module.exports = { prepareGeosite, VERSION, SHA256, URL, DEFAULT_DIRECTORY };
if (require.main === module) {
  prepareGeosite(process.argv[2]).then(() => console.log(`Pinned offline geosite database prepared: ${VERSION}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

const { createHash, createPublicKey } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function validateRootAuthority(value) {
  if (!value || value.version !== 1 || value.scope !== 'SXB-ROOT-ACCESS-1' ||
      value.origin !== 'https://vpnsxb.afrihall.com/api' ||
      typeof value.publicKey !== 'string' || !/^[A-Za-z0-9+/=]{100,256}$/.test(value.publicKey) ||
      typeof value.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(value.keyId)) {
    throw new Error('ROOT_AUTHORITY_INVALID');
  }
  const bytes = Buffer.from(value.publicKey, 'base64');
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
      bytes.toString('base64') !== value.publicKey ||
      createHash('sha256').update(bytes).digest('hex') !== value.keyId) throw new Error('ROOT_AUTHORITY_INVALID');
  return value;
}
function readRootAuthority() {
  return validateRootAuthority(JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'security', 'root-approval-authority.json'), 'utf8')));
}
function rootAuthorityForOrigin(origin) {
  const authority = readRootAuthority();
  if (origin !== authority.origin) throw new Error('ROOT_AUTHORITY_ORIGIN_UNREVIEWED');
  return authority.publicKey;
}
module.exports = { validateRootAuthority, readRootAuthority, rootAuthorityForOrigin };

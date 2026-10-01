const { createECDH, createHmac, createPrivateKey, createPublicKey, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const CREDENTIAL = 'SXB-ROOT-ACCESS-1';
const curveOrder = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

function rootSigningIdentity(secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.startsWith('CHANGE_ME')) {
    throw new Error('ROOT_SIGNING_UNAVAILABLE');
  }
  const seed = createHmac('sha256', secret).update('SXB/ROOT-APPROVAL/EC/v1').digest('hex');
  const scalar = ((BigInt(`0x${seed}`) % (curveOrder - 1n)) + 1n).toString(16).padStart(64, '0');
  const ec = createECDH('prime256v1');
  ec.setPrivateKey(Buffer.from(scalar, 'hex'));
  const point = ec.getPublicKey();
  const key = createPrivateKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', d: Buffer.from(scalar, 'hex').toString('base64url'),
    x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
  } });
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return { key, publicKey: publicKey.toString('base64'), keyId: createHash('sha256').update(publicKey).digest('hex') };
}

function publicRootAuthority(secret) {
  const signer = rootSigningIdentity(secret);
  return { version: 1, scope: CREDENTIAL, origin: 'https://vpnsxb.afrihall.com/api',
    publicKey: signer.publicKey, keyId: signer.keyId };
}

module.exports = { CREDENTIAL, rootSigningIdentity, publicRootAuthority };
if (require.main === module) {
  try {
    const root = '/var/www/sxb-vpn';
    if (process.platform !== 'linux' || process.cwd() !== root ||
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== process.env.SXB_ROOT_EXPECTED_SHA) {
      throw new Error('ROOT_SOURCE_CHANGED');
    }
    const requireBackend = createRequire(path.join(root, 'backend', 'package.json'));
    const env = requireBackend('dotenv').parse(fs.readFileSync(path.join(root, '.env'), 'utf8'));
    console.log(JSON.stringify(publicRootAuthority(env.ROOT_APPROVAL_SECRET || env.ENCRYPTION_KEY)));
  } catch (error) {
    console.error(['ROOT_SIGNING_UNAVAILABLE', 'ROOT_SOURCE_CHANGED'].includes(error?.message)
      ? error.message : 'ROOT_KEY_INSPECTION_FAILED');
    process.exitCode = 1;
  }
}

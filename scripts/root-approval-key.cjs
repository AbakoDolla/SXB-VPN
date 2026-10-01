const { createECDH, createHmac, createPrivateKey, createPublicKey, createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const CREDENTIAL = 'SXB-ROOT-ACCESS-1';
const curveOrder = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

function rootSigningIdentity(secret) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret) || new Set(secret).size < 8) {
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

function prepareRootAuthority(source, parsed, confirmed, generate = () => randomBytes(32).toString('hex')) {
  const pattern = /^[ \t]*(?:export[ \t]+)?ROOT_APPROVAL_SECRET[ \t]*=[^\r\n]*/gm;
  const lines = source.match(pattern) || [];
  if (lines.length > 1 || (lines.length === 1) !== Object.hasOwn(parsed, 'ROOT_APPROVAL_SECRET')) {
    throw new Error('ROOT_SECRET_AMBIGUOUS');
  }
  if (lines.length) return { after: source, authority: publicRootAuthority(parsed.ROOT_APPROVAL_SECRET), changed: false };
  if (!confirmed) throw new Error('ROOT_PREPARATION_NOT_CONFIRMED');
  const secret = generate();
  const authority = publicRootAuthority(secret);
  return { after: source + (source.endsWith('\n') ? '' : '\n') + `ROOT_APPROVAL_SECRET=${secret}\n`,
    authority, changed: true };
}

module.exports = { CREDENTIAL, rootSigningIdentity, publicRootAuthority, prepareRootAuthority };
if (require.main === module) {
  try {
    const root = '/var/www/sxb-vpn';
    if (process.platform !== 'linux' || process.cwd() !== root ||
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== process.env.SXB_ROOT_EXPECTED_SHA) {
      throw new Error('ROOT_SOURCE_CHANGED');
    }
    const requireBackend = createRequire(path.join(root, 'backend', 'package.json'));
    const envFile = path.join(root, '.env');
    const source = fs.readFileSync(envFile, 'utf8');
    const env = requireBackend('dotenv').parse(source);
    if (!['inspect', 'prepare'].includes(process.env.SXB_ROOT_MODE)) throw new Error('ROOT_MODE_INVALID');
    const plan = process.env.SXB_ROOT_MODE === 'prepare'
      ? prepareRootAuthority(source, env, process.env.SXB_ROOT_CONFIRMED === 'true')
      : { changed: false, authority: publicRootAuthority(env.ROOT_APPROVAL_SECRET) };
    if (plan.changed) {
      const directory = path.join(root, 'backups', 'root-approval-key');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, randomUUID() + '.env'), source, { flag: 'wx', mode: 0o600 });
      const temporary = envFile + '.root-' + randomUUID();
      try {
        if (fs.readFileSync(envFile, 'utf8') !== source) throw new Error('ROOT_ENV_CHANGED');
        fs.writeFileSync(temporary, plan.after, { flag: 'wx', mode: fs.statSync(envFile).mode & 0o777 });
        if (fs.readFileSync(envFile, 'utf8') !== source) throw new Error('ROOT_ENV_CHANGED');
        fs.renameSync(temporary, envFile);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    console.log(JSON.stringify({ ...plan.authority, prepared: plan.changed }));
  } catch (error) {
    console.error(/^ROOT_[A-Z_]+$/.test(error?.message || '')
      ? error.message : 'ROOT_KEY_INSPECTION_FAILED');
    process.exitCode = 1;
  }
}

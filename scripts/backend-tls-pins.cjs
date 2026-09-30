const { execFileSync, spawnSync } = require('node:child_process');
const { createHash, createPublicKey, X509Certificate } = require('node:crypto');
const tls = require('node:tls');

const HOST = 'vpnsxb.afrihall.com';
const SITE = '/etc/nginx/sites-enabled/sxb-vpn';
const BACKUP_KEY = '/var/lib/sxb-vpn-tls/backup.key';
const revision = source => createHash('sha256').update(source).digest('hex');
const pin = publicKey => 'sha256/' + createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

function tlsLayout(source, parseBlocks) {
  const servers = [];
  const visit = node => {
    if (node.words?.[0] === 'server' &&
        node.children.some(child => child.words[0] === 'server_name' &&
          child.words.slice(1).some(serverName => serverName === HOST)) &&
        node.children.some(child => child.words[0] === 'listen' && child.words.includes('ssl'))) servers.push(node);
    node.children.forEach(visit);
  };
  visit(parseBlocks(source));
  if (servers.length !== 1) throw new Error('TLS_PIN_SITE_AMBIGUOUS');
  const certificates = servers[0].children.filter(child => child.words[0] === 'ssl_certificate');
  if (certificates.length !== 1 || certificates[0].words.length !== 2) throw new Error('TLS_PIN_CERTIFICATE_AMBIGUOUS');
  const certificate = certificates[0].words[1];
  const live = /^\/etc\/letsencrypt\/live\/([A-Za-z0-9._-]+)\/(?:fullchain|cert)\.pem$/.exec(certificate);
  if (!live || ['.', '..'].includes(live[1])) throw new Error('TLS_PIN_CERTIFICATE_LAYOUT_UNSUPPORTED');
  return { certificate, renewal: `/etc/letsencrypt/renewal/${live[1]}.conf` };
}

function renewalReusesKey(source) {
  const lines = source.split(/\r?\n/);
  let section = '';
  let reuse;
  for (const line of lines) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) section = heading[1];
    const setting = /^\s*reuse_key\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (section === 'renewalparams' && setting) {
      if (reuse !== undefined) throw new Error('TLS_PIN_RENEWAL_AMBIGUOUS');
      reuse = setting[1].toLowerCase();
    }
  }
  return reuse === 'true';
}

function withStableRenewalKey(source) {
  renewalReusesKey(source);
  const headings = [...source.matchAll(/^\s*\[renewalparams\]\s*$/gm)];
  if (headings.length !== 1) throw new Error('TLS_PIN_RENEWAL_AMBIGUOUS');
  const start = headings[0].index + headings[0][0].length;
  const nextSection = /^\s*\[[^\]]+\]\s*$/gm;
  nextSection.lastIndex = start;
  const end = nextSection.exec(source)?.index ?? source.length;
  const section = source.slice(start, end);
  if (/^\s*new_key\s*=\s*(?:true|1|yes)\s*$/im.test(section)) throw new Error('TLS_PIN_RENEWAL_CONFLICT');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const changed = /^\s*reuse_key\s*=/m.test(section)
    ? section.replace(/^([ \t]*)reuse_key\s*=[^\r\n]*/m, '$1reuse_key = True')
    : newline + 'reuse_key = True' + section;
  return source.slice(0, start) + changed + source.slice(end);
}

// This exact function is sent to sudo's stdin. It writes only the validated
// renewal file and a root-owned fallback key; no certificate or service switch.
function prepareRoot(inputs) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  if (process.platform !== 'linux' || process.getuid() !== 0 ||
      !/^\/etc\/letsencrypt\/renewal\/[A-Za-z0-9._-]+\.conf$/.test(inputs.renewal) ||
      !/^\/etc\/letsencrypt\/live\/[A-Za-z0-9._-]+\/(?:fullchain|cert)\.pem$/.test(inputs.certificate) ||
      !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(inputs.expectedPin) ||
      !/^[a-f0-9]{64}$/.test(inputs.expectedRevision)) throw new Error('TLS_PIN_PREPARATION_INVALID');
  const keyPin = publicKey => 'sha256/' + crypto.createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  if (keyPin(new crypto.X509Certificate(fs.readFileSync(inputs.certificate)).publicKey) !== inputs.expectedPin) {
    throw new Error('TLS_PIN_CERTIFICATE_CHANGED');
  }
  const stat = fs.lstatSync(inputs.renewal);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0) throw new Error('TLS_PIN_RENEWAL_OWNERSHIP');
  const previous = fs.readFileSync(inputs.renewal, 'utf8');
  const previousHash = crypto.createHash('sha256').update(previous).digest('hex');
  if (previousHash !== inputs.expectedRevision) throw new Error('TLS_PIN_RENEWAL_CHANGED');
  const next = withStableRenewalKey(previous);
  const directory = '/var/lib/sxb-vpn-tls';
  process.umask(0o077);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const folder = fs.lstatSync(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== 0 ||
      folder.mode & 0o077) throw new Error('TLS_PIN_BACKUP_OWNERSHIP');
  const lock = path.join(directory, 'prepare.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  let temporary;
  try {
    const backup = path.join(directory, 'backup.key');
    let backupCreated = false;
    if (!fs.existsSync(backup)) {
      temporary = path.join(directory, `backup-${crypto.randomUUID()}.key`);
      execFileSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-out', temporary], { stdio: 'ignore', timeout: 20000 });
      fs.renameSync(temporary, backup);
      temporary = undefined;
      backupCreated = true;
    }
    const key = fs.lstatSync(backup);
    if (!key.isFile() || key.isSymbolicLink() || key.uid !== 0 || key.mode & 0o077) {
      throw new Error('TLS_PIN_BACKUP_OWNERSHIP');
    }
    const backupPin = keyPin(crypto.createPublicKey(fs.readFileSync(backup)));
    if (backupPin === inputs.expectedPin) throw new Error('TLS_PIN_BACKUP_NOT_INDEPENDENT');
    const renewalChanged = next !== previous;
    if (renewalChanged) {
      const archive = path.join(directory, `renewal-before-${previousHash}.conf`);
      if (!fs.existsSync(archive)) fs.writeFileSync(archive, previous, { flag: 'wx', mode: 0o600 });
      else if (!fs.lstatSync(archive).isFile() || fs.lstatSync(archive).isSymbolicLink() ||
          fs.readFileSync(archive, 'utf8') !== previous) throw new Error('TLS_PIN_BACKUP_CONFLICT');
      temporary = path.join(path.dirname(inputs.renewal), `.sxb-renewal-${crypto.randomUUID()}.conf`);
      fs.writeFileSync(temporary, next, { flag: 'wx', mode: stat.mode & 0o777 });
      if (fs.readFileSync(inputs.renewal, 'utf8') !== previous) throw new Error('TLS_PIN_RENEWAL_CHANGED');
      fs.renameSync(temporary, inputs.renewal);
      temporary = undefined;
    }
    return { backupCreated, renewalChanged, backupPin };
  } finally {
    if (temporary) fs.unlinkSync(temporary);
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

async function servedPin() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: HOST, port: 443, servername: HOST, rejectUnauthorized: true }, () => {
      try {
        if (!socket.authorized) throw new Error('TLS_PIN_PUBLIC_UNVERIFIED');
        resolve(pin(new X509Certificate(socket.getPeerCertificate().raw).publicKey));
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    const timeout = setTimeout(() => socket.destroy(new Error('TLS_PIN_PUBLIC_TIMEOUT')), 15000);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timeout));
  });
}

function sudo(args, encoding = 'utf8') {
  return execFileSync('sudo', ['-n', ...args], { encoding, maxBuffer: 256 * 1024, timeout: 20000 });
}

async function inspect(parseBlocks) {
  if (process.platform !== 'linux' || process.cwd() !== '/var/www/sxb-vpn') throw new Error('TLS_PIN_PRODUCTION_ROOT_REQUIRED');
  const layout = tlsLayout(sudo(['cat', SITE]), parseBlocks);
  const certificate = new X509Certificate(sudo(['cat', layout.certificate]));
  if (!certificate.checkHost(HOST) || Date.parse(certificate.validTo) <= Date.now()) throw new Error('TLS_PIN_CERTIFICATE_INVALID');
  const currentPin = pin(certificate.publicKey);
  if (await servedPin() !== currentPin) throw new Error('TLS_PIN_PUBLIC_MISMATCH');
  const renewal = sudo(['cat', layout.renewal]);
  const exists = spawnSync('sudo', ['-n', 'test', '-f', BACKUP_KEY], { stdio: 'ignore', timeout: 5000 });
  if (exists.error || ![0, 1].includes(exists.status)) throw new Error('TLS_PIN_BACKUP_CHECK_FAILED');
  const backupPin = exists.status === 0
    ? pin(createPublicKey({ key: sudo(['openssl', 'pkey', '-in', BACKUP_KEY, '-pubout', '-outform', 'DER'], null),
      type: 'spki', format: 'der' })) : null;
  return { status: 'inspected', currentPin, validUntil: new Date(certificate.validTo).toISOString(),
    renewalRevision: revision(renewal),
    renewalReusesKey: renewalReusesKey(renewal),
    backupPin };
}

async function main() {
  const reader = typeof blocks === 'function' ? blocks : require('./configure-ssh-relay-nginx.cjs').blocks;
  if (typeof reader !== 'function') throw new Error('TLS_PIN_READER_REQUIRED');
  const mode = process.env.SXB_TLS_PIN_MODE;
  if (!['inspect', 'prepare'].includes(mode)) throw new Error('TLS_PIN_OPERATION_UNSUPPORTED');
  const result = await inspect(reader);
  if (mode === 'inspect') { console.log(JSON.stringify(result)); return; }
  if (process.env.SXB_TLS_PIN_CONFIRMED !== 'true' ||
      process.env.SXB_TLS_PIN_EXPECTED !== result.currentPin ||
      process.env.SXB_TLS_PIN_REVISION !== result.renewalRevision) throw new Error('TLS_PIN_CONFIRMATION_REQUIRED');
  const layout = tlsLayout(sudo(['cat', SITE]), reader);
  const inputs = { ...layout, expectedPin: result.currentPin, expectedRevision: result.renewalRevision };
  const code = withStableRenewalKey.toString() + '\n' + renewalReusesKey.toString() + '\n' +
    prepareRoot.toString() + '\n' +
    `try { console.log(JSON.stringify(prepareRoot(${JSON.stringify(inputs)}))); } catch { console.error('TLS_PIN_PREPARATION_FAILED'); process.exitCode=1; }`;
  const receipt = JSON.parse(execFileSync('sudo', ['-n', 'node', '-'], {
    input: code, encoding: 'utf8', maxBuffer: 8192, timeout: 30000,
  }));
  const verified = await inspect(reader);
  if (!verified.renewalReusesKey || !verified.backupPin || verified.backupPin === verified.currentPin ||
      verified.currentPin !== result.currentPin || verified.backupPin !== receipt.backupPin) {
    throw new Error('TLS_PIN_PREPARATION_NOT_CONFIRMED');
  }
  console.log(JSON.stringify({ ...verified, status: 'prepared',
    backupCreated: receipt.backupCreated, renewalChanged: receipt.renewalChanged }));
}

module.exports = { pin, tlsLayout, renewalReusesKey, withStableRenewalKey, prepareRoot };
if (!module.parent) main().catch(error => {
  console.error(/^TLS_PIN_[A-Z_]+$/.test(error.message) ? error.message : 'TLS_PIN_INSPECTION_FAILED');
  process.exitCode = 1;
});

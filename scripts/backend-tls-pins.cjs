const { execFileSync, spawnSync } = require('node:child_process');
const { createHash, createPublicKey, X509Certificate } = require('node:crypto');
const tls = require('node:tls');

const HOST = 'vpnsxb.afrihall.com';
const SITE = '/etc/nginx/sites-enabled/sxb-vpn';
const BACKUP_KEY = '/var/lib/sxb-vpn-tls/backup.key';
const pin = publicKey => 'sha256/' + createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

function tlsLayout(source, parseBlocks) {
  const servers = [];
  const visit = node => {
    if (node.words?.[0] === 'server' &&
        node.children.some(child => child.words[0] === 'server_name' && child.words.slice(1).includes(HOST)) &&
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
    renewalReusesKey: renewalReusesKey(renewal),
    backupPin };
}

async function main() {
  const reader = typeof blocks === 'function' ? blocks : require('./configure-ssh-relay-nginx.cjs').blocks;
  if (typeof reader !== 'function') throw new Error('TLS_PIN_READER_REQUIRED');
  if (process.env.SXB_TLS_PIN_MODE !== 'inspect') throw new Error('TLS_PIN_OPERATION_UNSUPPORTED');
  const result = await inspect(reader);
  console.log(JSON.stringify(result));
}

module.exports = { pin, tlsLayout, renewalReusesKey };
if (!module.parent) main().catch(error => {
  console.error(/^TLS_PIN_[A-Z_]+$/.test(error.message) ? error.message : 'TLS_PIN_INSPECTION_FAILED');
  process.exitCode = 1;
});

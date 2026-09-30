const HEALTH_URL = 'https://vpnsxb.afrihall.com/api/health';
const tls = require('node:tls');
const { createHash, X509Certificate } = require('node:crypto');
const { readPinPolicy, validatePinPolicy } = require('./backend-pin-policy.cjs');

function verifyServedPin(policy, publicKey) {
  const reviewed = validatePinPolicy(policy);
  const served = 'sha256/' + createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  if (!reviewed.pins.includes(served)) throw new Error('BOOTSTRAP_BACKEND_PIN_MISMATCH');
}

async function verifyPublicPin() {
  const policy = readPinPolicy();
  const url = new URL(policy.origin);
  await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, servername: url.hostname, port: Number(url.port || 443),
      rejectUnauthorized: true }, () => {
      try {
        if (!socket.authorized) throw new Error('BOOTSTRAP_BACKEND_TLS_UNVERIFIED');
        verifyServedPin(policy, new X509Certificate(socket.getPeerCertificate().raw).publicKey);
        resolve();
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    const timer = setTimeout(() => socket.destroy(new Error('BOOTSTRAP_BACKEND_PIN_TIMEOUT')), 15000);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
  });
}

async function waitForBootstrapBackend(readHealth, {
  attempts = 24,
  pause = () => new Promise(resolve => setTimeout(resolve, 5000)),
  report = message => console.warn(message),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let health;
    try { health = await readHealth(); }
    catch { report(`BOOTSTRAP_BACKEND_NETWORK_PENDING attempt=${attempt}`); }
    if (health?.status === 'ok' && health.service === 'sxb-vpn-backend' &&
        Number.isSafeInteger(health.capabilities?.mobileTunnelBootstrap) &&
        health.capabilities.mobileTunnelBootstrap >= 1) return;
    report(`BOOTSTRAP_BACKEND_CAPABILITY_PENDING attempt=${attempt}`);
    if (attempt < attempts) await pause();
  }
  throw new Error('BOOTSTRAP_BACKEND_NOT_DEPLOYED');
}

module.exports = { waitForBootstrapBackend, verifyServedPin, verifyPublicPin };
if (require.main === module) {
  waitForBootstrapBackend(async () => {
    const response = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new Error('BOOTSTRAP_BACKEND_HTTP_FAILURE');
    return response.json();
  }).then(verifyPublicPin).then(() => console.log('BOOTSTRAP_BACKEND_READY')).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

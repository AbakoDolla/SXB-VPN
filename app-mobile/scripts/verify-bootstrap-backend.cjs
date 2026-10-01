const HEALTH_URL = 'https://vpnsxb.afrihall.com/api/health';
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
        health.capabilities.mobileTunnelBootstrap >= 1 &&
        Number.isSafeInteger(health.capabilities?.mobileDirectSsh) &&
        health.capabilities.mobileDirectSsh >= 1) return;
    report(`BOOTSTRAP_BACKEND_CAPABILITY_PENDING attempt=${attempt}`);
    if (attempt < attempts) await pause();
  }
  throw new Error('BOOTSTRAP_BACKEND_NOT_DEPLOYED');
}

module.exports = { waitForBootstrapBackend };
if (require.main === module) {
  waitForBootstrapBackend(async () => {
    const response = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new Error('BOOTSTRAP_BACKEND_HTTP_FAILURE');
    return response.json();
  }).then(() => console.log('BOOTSTRAP_BACKEND_READY')).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

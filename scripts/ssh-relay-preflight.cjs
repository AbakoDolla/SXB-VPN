const { createHash, timingSafeEqual } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');

const HOST_KEYS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256'];

function parseConfig(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 65536 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('PREFLIGHT_CONFIG_INVALID');
  }
  const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      Object.keys(config).some(key => !['host', 'port', 'payload', 'expectedFingerprint'].includes(key)) ||
      typeof config.host !== 'string' || config.host.length > 253 ||
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(config.host) ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      typeof config.payload !== 'string' || config.payload.length > 32768 ||
      typeof config.expectedFingerprint !== 'string' ||
      !/^(?:MD5:(?:[a-fA-F0-9]{2}:){15}[a-fA-F0-9]{2}|SHA256:[A-Za-z0-9+/]{43}=?)$/.test(config.expectedFingerprint)) {
    throw new Error('PREFLIGHT_CONFIG_INVALID');
  }
  return config;
}

function matchesFingerprint(key, expected) {
  const legacy = expected.startsWith('MD5:');
  const actual = createHash(legacy ? 'md5' : 'sha256').update(key).digest();
  const pinned = legacy
    ? Buffer.from(expected.slice(4).replace(/:/g, ''), 'hex')
    : Buffer.from(expected.slice(7), 'base64');
  return actual.length === pinned.length && timingSafeEqual(actual, pinned);
}

function inspectHostKey(socket, algorithm, expected, signal, Client) {
  return new Promise(resolve => {
    const client = new Client();
    let observed = 'key_exchange_failed', completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      client.destroy();
      socket.destroy();
      resolve(observed);
    };
    const cancelled = () => { observed = 'timeout'; finish(); };
    const timer = setTimeout(cancelled, 12000);
    client.on('error', finish);
    client.once('close', finish);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) { cancelled(); return; }
    try {
      client.connect({
        sock: socket, username: 'sxb-preflight', readyTimeout: 10000,
        algorithms: { serverHostKey: [algorithm] },
        hostVerifier: key => {
          observed = matchesFingerprint(key, expected) ? 'matched' : 'mismatch';
          // Stop at the host key, including on a match: never authenticate.
          return false;
        },
        authHandler: () => false,
      });
    } catch {
      finish();
    }
  });
}

function safeTransportError(error) {
  if (typeof error?.message === 'string' && /^RELAY_[A-Z_]+$/.test(error.message)) return error.message;
  if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(error?.code)) {
    return error.code;
  }
  return 'TRANSPORT_FAILED';
}

async function probeRelayHost(config, { open, Client }) {
  const attempts = [];
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 55000);
  try {
    for (const algorithm of HOST_KEYS) {
      if (controller.signal.aborted) {
        return { status: 'transport_unavailable', reason: 'PREFLIGHT_TIMEOUT', attempts, credentialsSent: false };
      }
      let socket;
      try {
        socket = await open({
          host: config.host, port: config.port, payload: config.payload,
          tls: false, sni: config.host, username: '', fingerprint: '',
        }, controller.signal);
      } catch (error) {
        return { status: 'transport_unavailable', reason: safeTransportError(error), attempts, credentialsSent: false };
      }
      const result = await inspectHostKey(socket, algorithm, config.expectedFingerprint, controller.signal, Client);
      attempts.push({ algorithm, result });
      if (result === 'matched') {
        return { status: 'host_key_matched', attempts, credentialsSent: false };
      }
    }
    return { status: 'host_key_unverified', attempts, credentialsSent: false };
  } finally {
    clearTimeout(deadline);
  }
}

async function main() {
  let config;
  try {
    config = parseConfig(process.env.SXB_SSH_RELAY_PREFLIGHT_CONFIG);
  } catch {
    console.error('PREFLIGHT_CONFIG_INVALID');
    process.exitCode = 1;
    return;
  }
  delete process.env.SXB_SSH_RELAY_PREFLIGHT_CONFIG;
  try {
    // Compile only the deployed transport in memory; no install or output file.
    const backendRequire = createRequire(path.join(process.cwd(), 'backend', 'package.json'));
    const output = backendRequire('esbuild').buildSync({
      entryPoints: [path.join(process.cwd(), 'server', 'services', 'ssh-relay-transport.ts')],
      bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', output.outputFiles[0].text)(backendRequire, mod, mod.exports);
    const result = await probeRelayHost(config, {
      open: mod.exports.openRelayUpstream, Client: backendRequire('ssh2').Client,
    });
    console.log(JSON.stringify(result));
    if (result.status !== 'host_key_matched') process.exitCode = 1;
  } catch {
    console.error('PREFLIGHT_EXECUTION_FAILED');
    process.exitCode = 1;
  }
}

module.exports = { parseConfig, matchesFingerprint, probeRelayHost };
if (require.main === module || !module.parent) main();

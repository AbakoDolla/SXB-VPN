const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const ENV_KEY = 'SXB_SSH_RELAY_PROFILE_IDS';
const FUTURE_KEY = 'SXB_SSH_RELAY_REQUIRED_FROM';
const ID = /^[a-zA-Z0-9_-]{1,200}$/;
const HASH = /^(?:hmac-sha256-v1:)?[a-f0-9]{64}$/;
const PROFILE_SELECT = { id: true, protocol: true, status: true, canonicalConfig: true,
  canonicalConfigHash: true, configVersion: true, createdAt: true, updatedAt: true };

function parseRequest(encoded, parseTransport) {
  if (typeof encoded !== 'string' || encoded.length > 65536 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('ROLLOUT_CONFIG_INVALID');
  }
  const value = JSON.parse(Buffer.from(encoded || '', 'base64').toString('utf8'));
  if (!value || Array.isArray(value) || Object.keys(value).some(key =>
    !['host', 'port', 'username', 'payload', 'expectedFingerprint'].includes(key)) ||
    typeof value.username !== 'string' || !value.username || value.username.length > 200) {
    throw new Error('ROLLOUT_CONFIG_INVALID');
  }
  const { username, ...transport } = value;
  return { ...parseTransport(Buffer.from(JSON.stringify(transport)).toString('base64')), username };
}

function decodeProfile(profile, api) {
  if (!['ssh', 'ssh+payload'].includes(profile.protocol) || !profile.canonicalConfig || !profile.canonicalConfigHash) {
    throw new Error('ROLLOUT_CANONICAL_INVALID');
  }
  const plain = api.decryptCanonical(profile.canonicalConfig);
  if (!plain) throw new Error('ROLLOUT_CANONICAL_INVALID');
  const canonical = JSON.parse(plain);
  if (!api.verifyCanonicalHash(canonical, profile.canonicalConfigHash)) throw new Error('ROLLOUT_CANONICAL_INVALID');
  return { profile, canonical, engine: api.engineConfigFromCanonical(canonical) };
}

function requestFromProfile(profile, expectedFingerprint, api, parseTransport) {
  const { engine } = decodeProfile(profile, api);
  return parseRequest(Buffer.from(JSON.stringify({
    host: engine.host, port: Number(engine.port), username: engine.username,
    payload: engine.payload ?? '', expectedFingerprint,
  })).toString('base64'), parseTransport);
}

function selectProfile(rows, request, api) {
  const matches = [];
  for (const profile of rows) {
    if (!['ssh', 'ssh+payload'].includes(profile.protocol) || !profile.canonicalConfig || !profile.canonicalConfigHash) continue;
    const { canonical, engine } = decodeProfile(profile, api);
    if (engine.host === request.host && Number(engine.port) === request.port &&
        engine.username === request.username && (engine.payload ?? '') === request.payload) {
      matches.push({ profile, canonical, engine });
    }
  }
  if (matches.length > 1) {
    const error = new Error('ROLLOUT_PROFILE_AMBIGUOUS');
    error.candidates = matches.map(({ profile }) => ({ profileId: profile.id, status: profile.status }));
    throw error;
  }
  if (!matches.length) throw new Error('ROLLOUT_PROFILE_NOT_FOUND');
  return matches[0];
}

function editEnvironmentValue(source, parsed, key, value) {
  if (![ENV_KEY, FUTURE_KEY].includes(key)) throw new Error('ROLLOUT_ENV_KEY_INVALID');
  const previous = parsed[key] || '';
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[^\\r\\n]*`, 'gm');
  const lines = source.match(pattern) || [];
  if (lines.length > 1 || /[\r\n]/.test(previous) ||
      (lines.length === 1) !== Object.hasOwn(parsed, key)) throw new Error('ROLLOUT_ALLOWLIST_AMBIGUOUS');
  const line = `${key}=${value}`;
  return lines.length ? source.replace(pattern, line) : source + (source.endsWith('\n') ? '' : '\n') + line + '\n';
}

function editAllowlist(source, parsed, profileId, enabled) {
  if (!ID.test(profileId)) throw new Error('ROLLOUT_PROFILE_ID_INVALID');
  const previous = parsed[ENV_KEY] || '';
  const ids = previous.split(',').map(value => value.trim()).filter(Boolean);
  if (ids.some(value => !ID.test(value))) throw new Error('ROLLOUT_ALLOWLIST_INVALID');
  const next = enabled ? [...new Set([...ids, profileId])] : ids.filter(id => id !== profileId);
  return {
    source: editEnvironmentValue(source, parsed, ENV_KEY, next.join(',')),
    value: next.join(','),
    previousValue: previous,
  };
}

function validateFuturePolicy(value) {
  if (value && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value ||
      Date.parse(value) > Date.now())) throw new Error('ROLLOUT_FUTURE_POLICY_INVALID');
}

function rolloutEnvironment(source, parsed, profileId, enabled, requiredFrom = '') {
  validateFuturePolicy(requiredFrom);
  const previousPolicy = parsed[FUTURE_KEY] || '';
  validateFuturePolicy(previousPolicy);
  if (requiredFrom && !enabled) throw new Error('ROLLOUT_FUTURE_POLICY_ENABLE_ONLY');
  if (previousPolicy && requiredFrom && Date.parse(requiredFrom) > Date.parse(previousPolicy)) {
    throw new Error('ROLLOUT_FUTURE_POLICY_DOWNGRADE');
  }
  const edited = editAllowlist(source, parsed, profileId, enabled);
  const nextPolicy = requiredFrom || previousPolicy;
  return {
    before: source,
    after: requiredFrom ? editEnvironmentValue(edited.source, parsed, FUTURE_KEY, nextPolicy) : edited.source,
    value: { [ENV_KEY]: edited.value, [FUTURE_KEY]: nextPolicy },
    previousValue: { [ENV_KEY]: edited.previousValue, [FUTURE_KEY]: previousPolicy },
  };
}

async function selectionMetadata(candidates, subscriptions) {
  const result = [];
  for (const candidate of candidates) {
    const total = await subscriptions.count({ where: { profileId: candidate.profileId } });
    const active = await subscriptions.count({
      where: { profileId: candidate.profileId, status: 'active',
        OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
    });
    result.push({ ...candidate, subscriptions: total, activeSubscriptions: active });
  }
  return result;
}

async function prepareRollout({ mode, profileId, expectedHash, confirmed }, request, deps) {
  if (!['inspect', 'inspect-direct', 'enable', 'disable'].includes(mode) ||
      (profileId && !ID.test(profileId)) || (expectedHash && !HASH.test(expectedHash))) throw new Error('ROLLOUT_INPUT_INVALID');
  if (!['inspect', 'inspect-direct'].includes(mode) && (!confirmed || !profileId || !expectedHash)) throw new Error('ROLLOUT_CONFIRMATION_REQUIRED');
  const rows = await deps.profiles(profileId);
  if (rows.length > 100) throw new Error('ROLLOUT_PROFILE_SCOPE_TOO_LARGE');
  const selected = selectProfile(rows, request, deps.api);
  if (expectedHash && selected.profile.canonicalConfigHash !== expectedHash) throw new Error('ROLLOUT_PROFILE_CHANGED');
  if (selected.profile.status !== 'active') throw new Error('ROLLOUT_PROFILE_INACTIVE');
  if (mode === 'disable') {
    if (deps.requiredFrom && new Date(selected.profile.createdAt).getTime() >= Date.parse(deps.requiredFrom)) {
      throw new Error('ROLLOUT_AUTOMATIC_POLICY_REQUIRED');
    }
    return { ...selected, mode };
  }
  const verified = await deps.verifyHost(request);
  if (verified.status !== 'host_key_matched' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(verified.verifiedFingerprint || '')) {
    throw new Error('ROLLOUT_PROVIDER_KEY_UNVERIFIED');
  }
  const canonical = { ...selected.canonical, fingerprint: verified.verifiedFingerprint };
  const upstream = deps.api.relayUpstream(deps.api.engineConfigFromCanonical(canonical));
  const transfer = await deps.verifyTransfer(upstream);
  if (!transfer.publicPageVerified || !transfer.destinationTlsVerified || transfer.uploadBytes <= 0 || transfer.downloadBytes <= 0) {
    throw new Error('ROLLOUT_TRANSFER_FAILED');
  }
  return { ...selected, canonical, mode, verifiedFingerprint: verified.verifiedFingerprint, transfer };
}

/** Read-only supplier authentication and HTTPS transfer, without a loopback SXB gateway. */
async function verifyDirectTransfer(upstream, api, Client, healthCa) {
  const abort = new AbortController(), client = new Client();
  const expected = Buffer.from(upstream.fingerprint.slice(7), 'base64');
  let socket, stream, request, agent, timer, rejectedKey = false, accountExpired = false;
  try {
    socket = await api.openRelayUpstream(upstream, abort.signal);
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('DIRECT_SSH_TRANSFER_TIMEOUT'));
      }, 30000);
      client.once('banner', message => { accountExpired = /\baccount\b.{0,40}\bexpired\b/i.test(message); });
      client.once('error', error => reject(new Error(rejectedKey ? 'DIRECT_SSH_HOST_KEY_MISMATCH'
        : accountExpired ? 'DIRECT_SSH_ACCOUNT_EXPIRED'
          : error.level === 'client-authentication' ? 'DIRECT_SSH_AUTH_REFUSED' : 'DIRECT_SSH_CONNECTION_FAILED')));
      client.once('close', () => reject(new Error('DIRECT_SSH_CLOSED')));
      client.once('ready', () => client.forwardOut('127.0.0.1', 0, 'vpnsxb.afrihall.com', 443, (error, channel) => {
        if (error) { reject(new Error('DIRECT_SSH_CHANNEL_REFUSED')); return; }
        stream = channel;
        stream.on('error', () => reject(new Error('DIRECT_SSH_CHANNEL_FAILED')));
        agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        agent.createConnection = options => tls.connect({
          ...options, socket: channel, servername: 'vpnsxb.afrihall.com', rejectUnauthorized: true,
          ...(healthCa ? { ca: healthCa } : {}),
        });
        request = https.get({
          hostname: 'vpnsxb.afrihall.com', port: 443, path: `/api/health?relayCheck=${randomUUID()}`,
          agent, headers: { Connection: 'close', 'Cache-Control': 'no-cache' },
        }, response => {
          const chunks = [];
          let size = 0;
          response.on('error', () => reject(new Error('DIRECT_SSH_RESPONSE_FAILED')));
          response.on('aborted', () => reject(new Error('DIRECT_SSH_RESPONSE_TRUNCATED')));
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 65536) {
              reject(new Error('DIRECT_SSH_RESPONSE_TOO_LARGE'));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.once('end', () => {
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { reject(new Error('DIRECT_SSH_HEALTH_INVALID')); return; }
            if (response.statusCode === 200 && body?.status === 'ok' && body.service === 'sxb-vpn-backend' &&
                Number.isFinite(Date.parse(body.timestamp)) && Math.abs(Date.now() - Date.parse(body.timestamp)) < 60000) resolve();
            else reject(new Error('DIRECT_SSH_HEALTH_INVALID'));
          });
        });
        request.on('error', () => reject(new Error('DIRECT_SSH_DESTINATION_TLS_FAILED')));
      }));
      client.connect({
        sock: socket, host: upstream.host, port: upstream.port,
        username: upstream.username, password: upstream.password,
        privateKey: upstream.privateKey, passphrase: upstream.passphrase, readyTimeout: 15000,
        hostVerifier: publicKey => {
          const actual = createHash('sha256').update(publicKey).digest();
          rejectedKey = actual.length !== expected.length || !timingSafeEqual(actual, expected);
          return !rejectedKey;
        },
      });
    });
    return { publicPageVerified: true, destinationTlsVerified: true, usesCentralGateway: false,
      providerTlsEnabled: upstream.tls === true, uploadBytes: socket.bytesWritten, downloadBytes: socket.bytesRead };
  } finally {
    clearTimeout(timer);
    abort.abort();
    request?.destroy(); agent?.destroy(); stream?.destroy(); client.destroy(); socket?.destroy();
  }
}

// Exercise the deployed gateway and provider with an operator-only, one-shot
// loopback grant. No device account, subscription or production quota is forged.
async function verifyTransfer(upstream, api, Client, healthCa) {
  const nonce = randomUUID();
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  let uploadBytes = 0, downloadBytes = 0, request, client, stream, healthRequest, healthAgent;
  const relay = api.installSshRelay(server, {
    authorize: async req => {
      if (req.headers.authorization !== `Bearer ${nonce}`) throw new Error('ROLLOUT_PROBE_UNAUTHORIZED');
      return {
        clientId: nonce, upstream, expiresAt: Date.now() + 30000,
        revalidate: async () => true,
        account: async (up, down) => { uploadBytes += up; downloadBytes += down; },
      };
    },
  });
  let timer;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ROLLOUT_TRANSFER_TIMEOUT')), 30000);
      request = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/api/mobile/ssh-relay',
        headers: { Authorization: `Bearer ${nonce}`, Connection: 'Upgrade', Upgrade: 'sxb-ssh-relay' },
      });
      request.once('error', reject);
      request.once('response', res => { res.resume(); reject(new Error('ROLLOUT_GATEWAY_REFUSED')); });
      request.once('upgrade', (res, socket, head) => {
        if (res.statusCode !== 101 || res.headers.upgrade !== 'sxb-ssh-relay') {
          socket.destroy(); reject(new Error('ROLLOUT_UPGRADE_INVALID')); return;
        }
        if (head.length) socket.unshift(head);
        client = new Client();
        client.once('error', reject);
        client.once('close', () => reject(new Error('ROLLOUT_SSH_CLOSED')));
        client.once('ready', () => client.forwardOut('127.0.0.1', 0, 'vpnsxb.afrihall.com', 443, (error, channel) => {
          if (error) { reject(new Error('ROLLOUT_CHANNEL_REFUSED')); return; }
          stream = channel;
          channel.on('error', reject);
          healthAgent = new https.Agent({ keepAlive: false, maxSockets: 1 });
          healthAgent.createConnection = options => tls.connect({
            ...options, socket: channel, servername: 'vpnsxb.afrihall.com', rejectUnauthorized: true,
            ...(healthCa ? { ca: healthCa } : {}),
          });
          healthRequest = https.get({
            hostname: 'vpnsxb.afrihall.com', port: 443, path: `/api/health?relayCheck=${nonce}`,
            agent: healthAgent, headers: { Connection: 'close', 'Cache-Control': 'no-cache' },
          }, response => {
            const chunks = [];
            let size = 0;
            response.on('error', reject);
            response.on('aborted', () => reject(new Error('ROLLOUT_HEALTH_RESPONSE_TRUNCATED')));
            response.on('data', chunk => {
              size += chunk.length;
              if (size > 65536) { reject(new Error('ROLLOUT_RESPONSE_TOO_LARGE')); response.destroy(); return; }
              chunks.push(chunk);
            });
            response.once('end', () => {
              let body;
              try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
              catch { reject(new Error('ROLLOUT_HEALTH_RESPONSE_INVALID')); return; }
              if (response.statusCode === 200 && body?.status === 'ok' && body.service === 'sxb-vpn-backend' &&
                  Number.isFinite(Date.parse(body.timestamp)) && Math.abs(Date.now() - Date.parse(body.timestamp)) < 60000) resolve();
              else reject(new Error('ROLLOUT_HEALTH_RESPONSE_INVALID'));
            });
          });
          healthRequest.on('error', reject);
        }));
        // The ephemeral frontend key belongs to this loopback-only server;
        // supplier verification is still enforced by installSshRelay.
        client.connect({ sock: socket, username: 'sxb', readyTimeout: 20000 });
      });
      request.end();
    });
    return { publicPageVerified: true, destinationTlsVerified: true, uploadBytes, downloadBytes };
  } finally {
    clearTimeout(timer);
    healthRequest?.destroy(); healthAgent?.destroy(); stream?.destroy(); client?.destroy(); request?.destroy(); relay.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function verifyIngress() {
  await new Promise((resolve, reject) => {
    const req = https.get('https://vpnsxb.afrihall.com/api/mobile/ssh-relay', { timeout: 8000 }, res => {
      res.resume();
      if (res.statusCode === 401 || res.statusCode === 403) resolve();
      else reject(new Error('ROLLOUT_INGRESS_NOT_PROTECTED'));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ROLLOUT_INGRESS_TIMEOUT')));
  });
}

function verifyRuntimePolicy(value) {
  const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 }));
  const targets = processes.filter(item => item.name === 'sxb-backend');
  if (targets.length !== 1 || targets[0].pm2_env.status !== 'online' ||
      Object.entries(value).some(([key, expected]) => (targets[0].pm2_env[key] || '') !== expected)) {
    throw new Error('ROLLOUT_RUNTIME_MISMATCH');
  }
}

function restartEnvironment(operator, application, policy) {
  const next = { ...operator, ...application, ...policy };
  for (const key of Object.keys(next)) if (key.startsWith('SXB_RELAY_')) delete next[key];
  return next;
}

function replaceFile(filename, expected, next) {
  if (fs.readFileSync(filename, 'utf8') !== expected) throw new Error('ROLLOUT_ENV_CHANGED');
  const temporary = filename + `.relay-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, next, { flag: 'wx', mode: fs.statSync(filename).mode & 0o777 });
    if (fs.readFileSync(filename, 'utf8') !== expected) throw new Error('ROLLOUT_ENV_CHANGED');
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function applyRollout(plan, deps) {
  const enabled = plan.mode === 'enable';
  const nextHash = enabled ? deps.api.computeCanonicalHash(plan.canonical) : plan.profile.canonicalConfigHash;
  const update = enabled && nextHash !== plan.profile.canonicalConfigHash ? {
    canonicalConfig: deps.api.encryptCanonical(deps.api.canonicalJson(plan.canonical)),
    canonicalConfigHash: nextHash,
    configVersion: plan.profile.configVersion + 1,
  } : null;
  const env = deps.environment(plan.profile.id, enabled);
  await deps.backup(plan.profile, env);
  let profileWritten = false, envWritten = false;
  try {
    if (update) { await deps.updateProfile(plan.profile, update); profileWritten = true; }
    else await deps.assertProfile(plan.profile);
    await deps.replaceEnvironment(env.before, env.after);
    envWritten = true;
    await deps.restart(env.value);
    await deps.healthy(env.value);
    return { profileId: plan.profile.id, enabled, configHash: nextHash };
  } catch {
    try {
      if (envWritten) await deps.replaceEnvironment(env.after, env.before);
      if (profileWritten) await deps.restoreProfile(plan.profile, update);
      if (envWritten) { await deps.restart(env.previousValue); await deps.healthy(env.previousValue); }
    } catch {
      throw new Error('ROLLOUT_FAILED_ROLLBACK_REQUIRES_REVIEW');
    }
    throw new Error('ROLLOUT_FAILED_ROLLED_BACK');
  }
}

async function main() {
  let db, stage = 'REVISION';
  try {
    const root = process.cwd();
    if (root !== '/var/www/sxb-vpn' || !/^[a-f0-9]{40}$/.test(process.env.SXB_RELAY_EXPECTED_SHA || '') ||
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== process.env.SXB_RELAY_EXPECTED_SHA) {
      throw new Error('ROLLOUT_DEPLOYED_REVISION_MISMATCH');
    }
    stage = 'ENVIRONMENT';
    const backend = createRequire(path.join(root, 'backend', 'package.json'));
    const application = require(path.join(root, 'ecosystem.config.cjs')).apps.find(app => app.name === 'sxb-backend');
    if (!application?.env?.NODE_PATH) throw new Error('ROLLOUT_RUNTIME_CONFIG_INVALID');
    const envPath = path.join(root, '.env');
    const source = fs.readFileSync(envPath, 'utf8'), env = backend('dotenv').parse(source);
    if (!env.DATABASE_URL || !env.ENCRYPTION_KEY) throw new Error('ROLLOUT_ENV_INCOMPLETE');
    process.env.DATABASE_URL = env.DATABASE_URL;
    process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
    process.env[ENV_KEY] = env[ENV_KEY] || '';
    process.env[FUTURE_KEY] = env[FUTURE_KEY] || '';
    validateFuturePolicy(process.env[FUTURE_KEY]);
    stage = 'REQUEST';
    const preflight = require(path.join(root, 'scripts', 'ssh-relay-preflight.cjs'));
    const encodedRequest = process.env.SXB_SSH_RELAY_ROLLOUT_CONFIG;
    delete process.env.SXB_SSH_RELAY_ROLLOUT_CONFIG;
    const profileId = process.env.SXB_RELAY_PROFILE_ID;
    const expectedFingerprint = process.env.SXB_RELAY_EXPECTED_FINGERPRINT;
    if (encodedRequest && expectedFingerprint) throw new Error('ROLLOUT_CONFIG_AMBIGUOUS');
    let request = encodedRequest ? parseRequest(encodedRequest, preflight.parseConfig) : null;
    if (!request && (!ID.test(profileId || '') || !expectedFingerprint)) throw new Error('ROLLOUT_SELECTOR_REQUIRED');
    const requiredFrom = process.env.SXB_RELAY_FUTURE_SSH_FROM || '';
    validateFuturePolicy(requiredFrom);
    if (requiredFrom && process.env.SXB_RELAY_MODE !== 'enable') throw new Error('ROLLOUT_FUTURE_POLICY_ENABLE_ONLY');
    stage = 'BUNDLE';
    const output = backend('esbuild').buildSync({
      stdin: { contents: [
        "export * from './server/services/canonical-config.ts';",
        "export * from './server/services/ssh-relay-transport.ts';",
        "export * from './server/services/ssh-relay.ts';",
        "export * from './server/services/ssh-relay-ticket.ts';",
      ].join('\n'), resolveDir: root, loader: 'ts' },
      bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', output.outputFiles[0].text)(backend, mod, mod.exports);
    const api = mod.exports, { Client } = backend('ssh2');
    stage = 'DATABASE';
    db = new (backend('@prisma/client').PrismaClient)({ log: [] });
    const profiles = id => {
      stage = 'PROFILE_READ';
      return db.vpnProfile.findMany({
        where: { protocol: { in: ['ssh', 'ssh+payload'] }, ...(id ? { id } : {}) }, take: 101, select: PROFILE_SELECT,
      });
    };
    let selectedRows;
    if (!request) {
      selectedRows = await profiles(profileId);
      if (selectedRows.length !== 1) throw new Error('ROLLOUT_PROFILE_NOT_FOUND');
      request = requestFromProfile(selectedRows[0], expectedFingerprint, api, preflight.parseConfig);
    }
    const plan = await prepareRollout({
      mode: process.env.SXB_RELAY_MODE,
      profileId,
      expectedHash: process.env.SXB_RELAY_EXPECTED_HASH,
      confirmed: process.env.SXB_RELAY_CONFIRMED === 'true',
    }, request, {
      api, requiredFrom: env[FUTURE_KEY],
      profiles: id => selectedRows || profiles(id),
      verifyHost: input => {
        stage = 'HOST_KEY';
        return preflight.probeRelayHost(input, { open: api.openRelayUpstream, Client });
      },
      verifyTransfer: upstream => {
        stage = 'TRANSFER';
        return process.env.SXB_RELAY_MODE === 'inspect-direct'
          ? verifyDirectTransfer(upstream, api, Client) : verifyTransfer(upstream, api, Client);
      },
    });
    if (plan.mode === 'inspect-direct') {
      console.log(JSON.stringify({
        status: 'direct-ready', profileId: plan.profile.id, configHash: plan.profile.canonicalConfigHash,
        verifiedFingerprint: plan.verifiedFingerprint, directTransfer: plan.transfer,
      }));
      return;
    }
    if (plan.mode === 'inspect') {
      stage = 'INGRESS';
      await verifyIngress();
      verifyRuntimePolicy({ [ENV_KEY]: env[ENV_KEY] || '', [FUTURE_KEY]: env[FUTURE_KEY] || '' });
      console.log(JSON.stringify({
        status: 'ready', profileId: plan.profile.id, configHash: plan.profile.canonicalConfigHash,
        verifiedFingerprint: plan.verifiedFingerprint, isolatedRelayTransfer: plan.transfer,
        tlsIngressVerified: true,
        enabled: api.relayProfileEnabled(plan.profile),
        futureSshFrom: env[FUTURE_KEY] || null,
        runtimePolicyVerified: true,
      }));
      return;
    }
    stage = 'APPLY';
    const result = await applyRollout(plan, {
      api,
      environment(id, enabled) {
        return rolloutEnvironment(source, env, id, enabled, requiredFrom);
      },
      backup: async (profile, change) => {
        const dir = path.join(root, 'backups', 'ssh-relay-rollout');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, randomUUID() + '.json'), JSON.stringify({
          createdAt: new Date().toISOString(), profile, previousGatewayPolicy: change.previousValue, nextGatewayPolicy: change.value,
        }), { flag: 'wx', mode: 0o600 });
      },
      updateProfile: async (profile, data) => {
        const result = await db.vpnProfile.updateMany({
          where: { id: profile.id, canonicalConfigHash: profile.canonicalConfigHash, updatedAt: profile.updatedAt }, data,
        });
        if (result.count !== 1) throw new Error('ROLLOUT_PROFILE_CHANGED');
      },
      assertProfile: async profile => {
        const found = await db.vpnProfile.count({
          where: { id: profile.id, canonicalConfigHash: profile.canonicalConfigHash, updatedAt: profile.updatedAt },
        });
        if (found !== 1) throw new Error('ROLLOUT_PROFILE_CHANGED');
      },
      restoreProfile: async (profile, update) => {
        const result = await db.vpnProfile.updateMany({
          where: { id: profile.id, canonicalConfig: update.canonicalConfig, canonicalConfigHash: update.canonicalConfigHash,
            configVersion: update.configVersion },
          data: { canonicalConfig: profile.canonicalConfig, canonicalConfigHash: profile.canonicalConfigHash,
            configVersion: profile.configVersion },
        });
        if (result.count !== 1) throw new Error('ROLLOUT_ROLLBACK_CONFLICT');
      },
      replaceEnvironment: (before, after) => replaceFile(envPath, before, after),
      restart: async value => {
        execFileSync('pm2', ['restart', 'sxb-backend', '--update-env'], {
          timeout: 45000, stdio: 'pipe', env: restartEnvironment(process.env, application.env, value),
        });
      },
      healthy: async value => {
        const port = Number(env.PORT || 3000);
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await new Promise((resolve, reject) => {
              const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, res => {
                res.resume(); res.statusCode === 200 ? resolve() : reject(new Error('ROLLOUT_UNHEALTHY'));
              });
              req.on('error', reject); req.on('timeout', () => req.destroy(new Error('ROLLOUT_HEALTH_TIMEOUT')));
            });
            break;
          } catch {
            if (attempt === 9) throw new Error('ROLLOUT_HEALTH_FAILED');
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        verifyRuntimePolicy(value);
        await verifyIngress();
        execFileSync('pm2', ['save'], { timeout: 10000, stdio: 'pipe' });
      },
    });
    console.log(JSON.stringify({ status: 'applied', ...result, futureSshFrom: requiredFrom || env[FUTURE_KEY] || null,
      isolatedRelayTransfer: plan.transfer }));
  } catch (error) {
    if (error?.message === 'ROLLOUT_PROFILE_AMBIGUOUS' && process.env.SXB_RELAY_MODE === 'inspect') {
      try {
        const candidates = await selectionMetadata(error.candidates, db.subscription);
        console.log(JSON.stringify({ status: 'selection_required', candidates }));
      } catch {
        console.error('ROLLOUT_SELECTION_METADATA_FAILED');
      }
    }
    console.error(/^(?:ROLLOUT|PREFLIGHT|RELAY|DIRECT_SSH)_[A-Z_]+$/.test(error?.message || '') ? error.message : `ROLLOUT_EXECUTION_FAILED_${stage}`);
    process.exitCode = 1;
  } finally {
    if (db) {
      try { await db.$disconnect(); }
      catch { console.error('ROLLOUT_DATABASE_CLOSE_FAILED'); process.exitCode = 1; }
    }
  }
}

module.exports = { PROFILE_SELECT, parseRequest, requestFromProfile, selectProfile, selectionMetadata, editAllowlist, rolloutEnvironment,
  restartEnvironment, prepareRollout, verifyTransfer, verifyDirectTransfer, replaceFile, applyRollout };
if (require.main === module || !module.parent) main();

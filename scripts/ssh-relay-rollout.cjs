const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const ENV_KEY = 'SXB_SSH_RELAY_PROFILE_IDS';
const ID = /^[a-zA-Z0-9_-]{1,200}$/;
const HASH = /^(?:hmac-sha256-v1:)?[a-f0-9]{64}$/;
const PROFILE_SELECT = { id: true, protocol: true, status: true, canonicalConfig: true,
  canonicalConfigHash: true, configVersion: true, updatedAt: true };

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

function selectProfile(rows, request, api) {
  const matches = [];
  for (const profile of rows) {
    if (!['ssh', 'ssh+payload'].includes(profile.protocol) || !profile.canonicalConfig || !profile.canonicalConfigHash) continue;
    const plain = api.decryptCanonical(profile.canonicalConfig);
    if (!plain) throw new Error('ROLLOUT_CANONICAL_INVALID');
    const canonical = JSON.parse(plain);
    if (!api.verifyCanonicalHash(canonical, profile.canonicalConfigHash)) throw new Error('ROLLOUT_CANONICAL_INVALID');
    const engine = api.engineConfigFromCanonical(canonical);
    if (engine.host === request.host && Number(engine.port) === request.port &&
        engine.username === request.username && engine.payload === request.payload) {
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

function editAllowlist(source, parsed, profileId, enabled) {
  if (!ID.test(profileId)) throw new Error('ROLLOUT_PROFILE_ID_INVALID');
  const previous = parsed[ENV_KEY] || '';
  const ids = previous.split(',').map(value => value.trim()).filter(Boolean);
  if (ids.some(value => !ID.test(value))) throw new Error('ROLLOUT_ALLOWLIST_INVALID');
  const pattern = /^[ \t]*(?:export[ \t]+)?SXB_SSH_RELAY_PROFILE_IDS[ \t]*=[^\r\n]*/gm;
  const lines = source.match(pattern) || [];
  if (lines.length > 1 || /[\r\n]/.test(previous) ||
      (lines.length === 1) !== Object.hasOwn(parsed, ENV_KEY)) throw new Error('ROLLOUT_ALLOWLIST_AMBIGUOUS');
  const next = enabled ? [...new Set([...ids, profileId])] : ids.filter(id => id !== profileId);
  const line = `${ENV_KEY}=${next.join(',')}`;
  return {
    source: lines.length ? source.replace(pattern, line) : source + (source.endsWith('\n') ? '' : '\n') + line + '\n',
    value: next.join(','),
    previousValue: previous,
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
  if (!['inspect', 'enable', 'disable'].includes(mode) ||
      (profileId && !ID.test(profileId)) || (expectedHash && !HASH.test(expectedHash))) throw new Error('ROLLOUT_INPUT_INVALID');
  if (mode !== 'inspect' && (!confirmed || !profileId || !expectedHash)) throw new Error('ROLLOUT_CONFIRMATION_REQUIRED');
  const rows = await deps.profiles(profileId);
  if (rows.length > 100) throw new Error('ROLLOUT_PROFILE_SCOPE_TOO_LARGE');
  const selected = selectProfile(rows, request, deps.api);
  if (expectedHash && selected.profile.canonicalConfigHash !== expectedHash) throw new Error('ROLLOUT_PROFILE_CHANGED');
  if (selected.profile.status !== 'active') throw new Error('ROLLOUT_PROFILE_INACTIVE');
  if (mode === 'disable') return { ...selected, mode };
  const verified = await deps.verifyHost(request);
  if (verified.status !== 'host_key_matched' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(verified.verifiedFingerprint || '')) {
    throw new Error('ROLLOUT_PROVIDER_KEY_UNVERIFIED');
  }
  const canonical = { ...selected.canonical, fingerprint: verified.verifiedFingerprint };
  const upstream = deps.api.relayUpstream(deps.api.engineConfigFromCanonical(canonical));
  const transfer = await deps.verifyTransfer(upstream);
  if (!transfer.publicPageVerified || transfer.uploadBytes <= 0 || transfer.downloadBytes <= 0) {
    throw new Error('ROLLOUT_TRANSFER_FAILED');
  }
  return { ...selected, canonical, mode, verifiedFingerprint: verified.verifiedFingerprint, transfer };
}

// Exercise the deployed gateway and provider with an operator-only, one-shot
// loopback grant. No device account, subscription or production quota is forged.
async function verifyTransfer(upstream, api, Client) {
  const nonce = randomUUID();
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  let uploadBytes = 0, downloadBytes = 0, request, client, stream;
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
        client.once('ready', () => client.forwardOut('127.0.0.1', 0, 'example.com', 80, (error, channel) => {
          if (error) { reject(new Error('ROLLOUT_CHANNEL_REFUSED')); return; }
          stream = channel;
          const chunks = [];
          let size = 0;
          channel.on('error', reject);
          channel.on('data', chunk => {
            size += chunk.length;
            if (size > 65536) { reject(new Error('ROLLOUT_RESPONSE_TOO_LARGE')); channel.destroy(); return; }
            chunks.push(chunk);
          });
          channel.once('end', () => {
            const response = Buffer.concat(chunks).toString('utf8');
            if (/^HTTP\/1\.[01] 200\b/.test(response) && response.includes('Example Domain')) resolve();
            else reject(new Error('ROLLOUT_PUBLIC_PAGE_INVALID'));
          });
          channel.end('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
        }));
        // The ephemeral frontend key belongs to this loopback-only server;
        // supplier verification is still enforced by installSshRelay.
        client.connect({ sock: socket, username: 'sxb', readyTimeout: 20000 });
      });
      request.end();
    });
    return { publicPageVerified: true, uploadBytes, downloadBytes };
  } finally {
    clearTimeout(timer);
    stream?.destroy(); client?.destroy(); request?.destroy(); relay.close();
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
    const envPath = path.join(root, '.env');
    const source = fs.readFileSync(envPath, 'utf8'), env = backend('dotenv').parse(source);
    if (!env.DATABASE_URL || !env.ENCRYPTION_KEY) throw new Error('ROLLOUT_ENV_INCOMPLETE');
    process.env.DATABASE_URL = env.DATABASE_URL;
    process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
    stage = 'REQUEST';
    const preflight = require(path.join(root, 'scripts', 'ssh-relay-preflight.cjs'));
    const request = parseRequest(process.env.SXB_SSH_RELAY_ROLLOUT_CONFIG, preflight.parseConfig);
    delete process.env.SXB_SSH_RELAY_ROLLOUT_CONFIG;
    stage = 'BUNDLE';
    const output = backend('esbuild').buildSync({
      stdin: { contents: [
        "export * from './server/services/canonical-config.ts';",
        "export * from './server/services/ssh-relay-transport.ts';",
        "export * from './server/services/ssh-relay.ts';",
      ].join('\n'), resolveDir: root, loader: 'ts' },
      bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', output.outputFiles[0].text)(backend, mod, mod.exports);
    const api = mod.exports, { Client } = backend('ssh2');
    stage = 'DATABASE';
    db = new (backend('@prisma/client').PrismaClient)({ log: [] });
    const plan = await prepareRollout({
      mode: process.env.SXB_RELAY_MODE,
      profileId: process.env.SXB_RELAY_PROFILE_ID,
      expectedHash: process.env.SXB_RELAY_EXPECTED_HASH,
      confirmed: process.env.SXB_RELAY_CONFIRMED === 'true',
    }, request, {
      api,
      profiles: id => {
        stage = 'PROFILE_READ';
        return db.vpnProfile.findMany({
          where: { protocol: { in: ['ssh', 'ssh+payload'] }, ...(id ? { id } : {}) }, take: 101, select: PROFILE_SELECT,
        });
      },
      verifyHost: input => {
        stage = 'HOST_KEY';
        return preflight.probeRelayHost(input, { open: api.openRelayUpstream, Client });
      },
      verifyTransfer: upstream => { stage = 'TRANSFER'; return verifyTransfer(upstream, api, Client); },
    });
    if (plan.mode === 'inspect') {
      stage = 'INGRESS';
      await verifyIngress();
      console.log(JSON.stringify({
        status: 'ready', profileId: plan.profile.id, configHash: plan.profile.canonicalConfigHash,
        verifiedFingerprint: plan.verifiedFingerprint, isolatedRelayTransfer: plan.transfer,
        tlsIngressVerified: true,
        enabled: (env[ENV_KEY] || '').split(',').map(id => id.trim()).includes(plan.profile.id),
      }));
      return;
    }
    stage = 'APPLY';
    const result = await applyRollout(plan, {
      api,
      environment(id, enabled) {
        const edited = editAllowlist(source, env, id, enabled);
        return { before: source, after: edited.source, value: edited.value, previousValue: edited.previousValue };
      },
      backup: async (profile, change) => {
        const dir = path.join(root, 'backups', 'ssh-relay-rollout');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, randomUUID() + '.json'), JSON.stringify({
          createdAt: new Date().toISOString(), profile, previousAllowlist: change.previousValue, nextAllowlist: change.value,
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
          timeout: 45000, stdio: 'pipe', env: { ...process.env, [ENV_KEY]: value },
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
        const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 }));
        const targets = processes.filter(item => item.name === 'sxb-backend');
        if (targets.length !== 1 || targets[0].pm2_env.status !== 'online' ||
            targets[0].pm2_env[ENV_KEY] !== value) throw new Error('ROLLOUT_RUNTIME_MISMATCH');
        await verifyIngress();
        execFileSync('pm2', ['save'], { timeout: 10000, stdio: 'pipe' });
      },
    });
    console.log(JSON.stringify({ status: 'applied', ...result, isolatedRelayTransfer: plan.transfer }));
  } catch (error) {
    if (error?.message === 'ROLLOUT_PROFILE_AMBIGUOUS' && process.env.SXB_RELAY_MODE === 'inspect') {
      try {
        const candidates = await selectionMetadata(error.candidates, db.subscription);
        console.log(JSON.stringify({ status: 'selection_required', candidates }));
      } catch {
        console.error('ROLLOUT_SELECTION_METADATA_FAILED');
      }
    }
    console.error(/^(?:ROLLOUT|PREFLIGHT|RELAY)_[A-Z_]+$/.test(error?.message || '') ? error.message : `ROLLOUT_EXECUTION_FAILED_${stage}`);
    process.exitCode = 1;
  } finally {
    if (db) {
      try { await db.$disconnect(); }
      catch { console.error('ROLLOUT_DATABASE_CLOSE_FAILED'); process.exitCode = 1; }
    }
  }
}

module.exports = { PROFILE_SELECT, parseRequest, selectProfile, selectionMetadata, editAllowlist, prepareRollout, verifyTransfer, replaceFile, applyRollout };
if (require.main === module || !module.parent) main();

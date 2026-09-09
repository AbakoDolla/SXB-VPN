const assert = require('node:assert/strict');

const CONFIRMATION = 'RESET SXB VPN';
const PROTECTED_ROLES = ['OWNER', 'ADMIN', 'SUPER_ADMIN'];
const COUNT_KEYS = [
  'users', 'resellers', 'clients', 'registrations', 'activations', 'subscriptions',
  'subscriptionDevices', 'tokens', 'vouchers', 'profiles', 'profileAssignments',
  'sshAccounts', 'xrayAccounts', 'singboxAccounts', 'payloads', 'traffic', 'vpnLogs',
  'pushTokens', 'healthReports', 'healthDevices', 'supportTickets', 'adminTokens',
];

function trustedBase(raw) {
  const url = new URL(raw);
  const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  const production = url.protocol === 'https:' && url.hostname === 'vpnsxb.afrihall.com' && !url.port;
  assert.ok((local || production) && url.pathname === '/api' &&
    !url.username && !url.password && !url.search && !url.hash, 'RESET_UNTRUSTED_ORIGIN');
  return url.toString().replace(/\/$/, '');
}

function counts(value) {
  assert.ok(value && typeof value === 'object', 'RESET_COUNTS_MISSING');
  return Object.fromEntries(COUNT_KEYS.map(key => {
    assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0, `RESET_COUNT_INVALID:${key}`);
    return [key, value[key]];
  }));
}

function protectedUsers(value) {
  assert.ok(value && typeof value === 'object', 'RESET_PROTECTED_USERS_MISSING');
  const result = Object.fromEntries(PROTECTED_ROLES.map(role => {
    assert.ok(Number.isSafeInteger(value[role]) && value[role] >= 0, 'RESET_PROTECTED_USERS_INVALID');
    return [role, value[role]];
  }));
  assert.ok(result.OWNER >= 1, 'RESET_OWNER_MUST_SURVIVE');
  return result;
}

async function runOperation({
  action = 'inventory',
  confirmation = '',
  email,
  password,
  base = 'https://vpnsxb.afrihall.com/api',
  request = fetch,
}) {
  assert.ok(['inventory', 'reset'].includes(action), 'RESET_ACTION_INVALID');
  if (action === 'reset') assert.equal(confirmation, CONFIRMATION, 'RESET_CONFIRMATION_REQUIRED');
  assert.ok(typeof email === 'string' && email.trim() && typeof password === 'string' && password,
    'RESET_OWNER_CREDENTIALS_REQUIRED');
  const origin = trustedBase(base);
  async function json(route, method = 'GET', body, token) {
    const response = await request(origin + route, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10 * 60_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.headers.get('content-type')?.includes('application/json'), 'RESET_NON_JSON_RESPONSE');
    const data = await response.json();
    if (!response.ok) {
      const code = typeof data?.code === 'string' && /^[A-Z_]+$/.test(data.code) ? data.code : 'REQUEST_FAILED';
      throw new Error(`RESET_HTTP_${response.status}:${code}`);
    }
    return data;
  }
  const session = await json('/auth/login', 'POST', { email: email.trim().toLowerCase(), password });
  assert.equal(session.user?.role, 'OWNER', 'RESET_OWNER_REQUIRED');
  assert.ok(typeof session.accessToken === 'string' && session.accessToken.length > 20, 'RESET_SESSION_MISSING');
  const preview = await json('/ops/reset/preview', 'GET', undefined, session.accessToken);
  assert.equal(preview.mode, 'production', 'RESET_MODE_MISMATCH');
  assert.equal(preview.confirmationText, CONFIRMATION, 'RESET_CONFIRMATION_MISMATCH');
  assert.equal(preview.backupRequired, true, 'RESET_BACKUP_REQUIRED');
  assert.equal(preview.preserved?.projectFiles, true, 'RESET_PROJECT_MUST_SURVIVE');
  const before = counts(preview.counts);
  const preserved = protectedUsers(preview.preserved?.usersByRole);
  if (action === 'inventory') {
    return { action, mode: preview.mode, counts: before, preservedUsers: preserved,
      backupRequired: true, projectFilesPreserved: true };
  }
  assert.ok(typeof preview.challenge === 'string' && preview.challenge.length > 20, 'RESET_CHALLENGE_MISSING');
  assert.ok(Date.parse(preview.expiresAt) > Date.now(), 'RESET_CHALLENGE_EXPIRED');
  const result = await json('/ops/reset/execute', 'POST', {
    mode: 'production', challenge: preview.challenge, confirmation, password,
  }, session.accessToken);
  assert.equal(result.status, 'completed', 'RESET_NOT_COMPLETED');
  assert.equal(result.maintenanceRestored, true, 'RESET_MAINTENANCE_RECOVERY_REQUIRED');
  const after = counts(result.countsAfter);
  assert.ok(Object.values(after).every(count => count === 0), 'RESET_DATA_REMAINS');
  assert.deepEqual(protectedUsers(result.retainedUsersByRole), preserved, 'RESET_ADMIN_PRESERVATION_FAILED');
  assert.ok(result.backup && typeof result.backup.id === 'string' &&
    /^[a-zA-Z0-9._-]{1,180}$/.test(result.backup.id) &&
    Number.isSafeInteger(result.backup.bytes) && result.backup.bytes >= 1024 &&
    /^[a-f0-9]{64}$/i.test(result.backup.sha256), 'RESET_BACKUP_RECEIPT_INVALID');
  return {
    action, status: 'completed', resetId: result.resetId, completedAt: result.completedAt,
    deletedCounts: counts(result.deletedCounts), countsAfter: after,
    retainedUsersByRole: preserved,
    backup: { id: result.backup.id, bytes: result.backup.bytes, sha256: result.backup.sha256 },
    maintenanceRestored: true, projectFilesPreserved: true,
  };
}

module.exports = { runOperation, trustedBase, CONFIRMATION, COUNT_KEYS, PROTECTED_ROLES };

if (require.main === module) {
  runOperation({
    action: process.argv[2] || 'inventory',
    confirmation: process.env.SXB_RESET_CONFIRMATION || '',
    email: process.env.OWNER_EMAIL,
    password: process.env.OWNER_PASSWORD,
    base: process.env.SXB_RESET_API_BASE || 'https://vpnsxb.afrihall.com/api',
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    const code = typeof error.message === 'string'
      ? error.message.match(/^RESET_[A-Z_0-9:]+(?=\n|$)/)?.[0] || 'RESET_OPERATION_FAILED'
      : 'RESET_OPERATION_FAILED';
    console.error(code);
    process.exitCode = 1;
  });
}

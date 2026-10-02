import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDecipheriv } from 'node:crypto';
import { connectionDnsValue, ConnectionDnsError } from '../../server/services/connection-dns.ts';
import { configHashForProfile } from '../../server/services/config-hash.ts';
import { db, api, row, ok } from './reseller-http.test.mjs';

const imported = JSON.stringify({
  protocol: 'vless', host: 'dns-fixture.example.test', port: 443,
  uuid: 'e4382d89-cc83-478c-bcbc-fd18078c9023', tls: true,
  sni: 'dns-fixture.example.test', dns: '1.1.1.1',
});
const password = 'synthetic-DNS-profile-lock-only';

test('connection DNS accepts explicit presets/transports and rejects malformed values without a fallback', () => {
  for (const dns of ['', '8.8.8.8', '1.1.1.1', 'local', 'tcp://8.8.8.8:53',
    'tls://dns.google', 'https://dns.google/dns-query', '[2001:4860:4860::8888]']) {
    assert.equal(connectionDnsValue(dns), dns);
  }
  for (const dns of [{}, 8, '8.8.8.8\r\nInjected', 'tcp://8.8.8.8:0',
    'http://dns.google', 'tls://user:password@dns.google', '8.8.8.999', 'tcp://8.8.8.8/unexpected']) {
    assert.throws(() => connectionDnsValue(dns), ConnectionDnsError);
  }
});

test('a DNS override changes cache identity without rewriting canonical integrity', () => {
  const profile = { canonicalConfigHash: 'opaque-original-integrity', configVersion: 1 };
  assert.equal(configHashForProfile(profile), profile.canonicalConfigHash);
  const google = configHashForProfile({ ...profile, dns: '8.8.8.8' });
  assert.notEqual(google, profile.canonicalConfigHash);
  assert.notEqual(google, configHashForProfile({ ...profile, dns: '1.1.1.1' }));
  assert.equal(configHashForProfile({ ...profile, dns: '' }), profile.canonicalConfigHash);
});

test('Google selection survives encrypted import, reaches authenticated provisioning and can reset to profile DNS', async () => {
  const created = await api('root', 'POST', '/vpn-profiles', {
    name: 'Synthetic DNS override', importConfig: imported, lockPassword: password, dns: '8.8.8.8',
  });
  ok(created, 201);
  const profileId = created.body.profile.id;
  assert.equal(row('VpnProfile', profileId).dns, '8.8.8.8');
  const originalCanonical = row('VpnProfile', profileId).canonicalConfig;
  const originalHash = row('VpnProfile', profileId).canonicalConfigHash;
  row('VpnClient', 'direct').deviceId = 'SYNTHETIC-DNS-DEVICE';
  row('VpnClient', 'direct').activatedAt = new Date();
  const sold = await api('root', 'POST', '/subscriptions', { clientId: 'direct', profileId, quotaGB: 1, durationDays: 30 });
  ok(sold, 201);
  const provision = await api('direct-user', 'POST', '/provision/activate', {
    dataToken: sold.body.subscription.dataToken, deviceId: 'SYNTHETIC-DNS-DEVICE',
  });
  ok(provision);
  const [prefix, iv, encrypted, tag] = provision.body.encryptedBlob.split(':');
  assert.equal(prefix, 'gcm');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(provision.body.configKey, 'hex'),
    Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const runtime = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString());
  assert.equal(runtime.connectionDns, '8.8.8.8');
  assert.equal(runtime.dns, '1.1.1.1', 'the supplier/SlowDNS field must not be rewritten');
  const unlocked = await api('root', 'POST', `/vpn-profiles/${profileId}/unlock`, { password });
  ok(unlocked);
  const headers = { 'X-VPN-Profile-Unlock': unlocked.body.unlockToken };
  const version = row('VpnProfile', profileId).configVersion;
  ok(await api('root', 'PUT', `/vpn-profiles/${profileId}`, { dns: '1.1.1.1' }, headers));
  assert.equal(row('VpnProfile', profileId).configVersion, version + 1);
  assert.equal(row('VpnProfile', profileId).canonicalConfig, originalCanonical);
  assert.equal(row('VpnProfile', profileId).canonicalConfigHash, originalHash);
  ok(await api('root', 'PUT', `/vpn-profiles/${profileId}`, { dns: '' }, headers));
  assert.equal(row('VpnProfile', profileId).dns, null);
  ok(await api('root', 'PUT', `/vpn-profiles/${profileId}`, { dns: 'bad input' }, headers), 400);
});

test('batch imports keep the same selected connection DNS and invalid DNS is atomic', async () => {
  const invalid = await api('root', 'POST', '/vpn-profiles/import-batch', {
    namePrefix: 'Synthetic DNS batch', importConfig: imported, lockPassword: password, dns: 'invalid resolver',
  });
  ok(invalid, 400);
  assert.equal(db.state.VpnProfile.length, 1);
  const created = await api('root', 'POST', '/vpn-profiles/import-batch', {
    namePrefix: 'Synthetic DNS batch', importConfig: imported, lockPassword: password, dns: '8.8.8.8',
  });
  ok(created, 201);
  assert.ok(created.body.profiles.every(profile => row('VpnProfile', profile.id).dns === '8.8.8.8'));
});

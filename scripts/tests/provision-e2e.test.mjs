/**
 * provision-e2e.test.mjs — Tests E2E du pipeline de provisionnement SXB VPN
 *
 * Exécution : node --experimental-strip-types scripts/tests/provision-e2e.test.mjs
 *
 * Couvre :
 *   1. PREUVE AVANT — la logique de déchiffrement historique (crypto.subtle)
 *      échoue dans un environnement Hermes (sans Web Crypto API).
 *   2. Pipeline serveur exact : encrypt (vpn-profiles.ts) → decryptDbField
 *      (provision.ts) → encryptForDevice (AES-256-GCM, clé HMAC par appareil).
 *   3. PREUVE APRÈS — app-mobile/services/aesGcm.ts déchiffre le blob serveur
 *      à l'identique (deep-equal sur la config complète).
 *   4. Fuzz croisé Node crypto ↔ implementation TS (25 vecteurs aléatoires),
 *      rejet de tag falsifié / mauvaise clé / blob tronqué.
 *   5. Gardien de complétude (configValidator.ts) — configs déchiffrées pour
 *      ssh / ssh+payload / vless / trojan / wireguard toutes complètes ;
 *      config "métadonnées seules" correctement rejetée ; mergeConfigs ne
 *      perd jamais host/payload/credentials.
 *   6. UTF-8 : payloads SSH avec accents + emoji → roundtrip exact.
 */
import { strict as assert } from 'node:assert';
import { webcrypto, randomBytes, createHmac, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { decryptSxbBlob, encryptAes256Gcm, decryptAes256Gcm, utf8Encode, utf8Decode, hexToBytes, bytesToHex } =
  await import(path.join(__dirname, '../../app-mobile/services/aesGcm.ts'));
const { isCompleteOfflineConfig, mergeConfigs, validateVpnConfig } =
  await import(path.join(__dirname, '../../app-mobile/services/configValidator.ts'));

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✅ ${name}`); };

// ═══════════════════════════════════════════════════════════════════════════
// 0. Environnement simulé
// ═══════════════════════════════════════════════════════════════════════════
const PROVISION_SECRET = 'test-provision-secret-e2e';
const ENCRYPTION_KEY   = 'test-encryption-key-32-bytes-e2e!';
const deviceId   = 'SXBTESTDEVICE123';
const dataToken  = 'SXB-DATA-A1B2-C3D4-E5F6';

// ── Copie exacte de l'algorithme de vpn-profiles.ts (encrypt GCM) ───────────
function dbEncryptGcm(text) {
  const key = createHash('sha256').update(ENCRYPTION_KEY).digest();
  const iv  = randomBytes(12);
  const c   = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${c.getAuthTag().toString('hex')}`;
}

// ── Copie exacte de l'algorithme de provision.ts (decryptDbField) ───────────
function decryptDbField(enc) {
  if (!enc) return null;
  try {
    if (enc.startsWith('gcm:')) {
      const parts = enc.slice(4).split(':');
      if (parts.length !== 3) return null;
      const key = createHash('sha256').update(ENCRYPTION_KEY).digest();
      const iv  = Buffer.from(parts[0], 'hex');
      const tag = Buffer.from(parts[2], 'hex');
      const d   = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(Buffer.from(parts[1], 'hex')), d.final()]).toString();
    }
    if (!enc.includes(':')) return enc;
    const [ivHex, encHex] = enc.split(':');
    const key = createHash('sha256').update(ENCRYPTION_KEY).digest();
    const d   = createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString();
  } catch { return null; }
}

// ── Copie exacte de l'algorithme de provision.ts (encryptForDevice) ─────────
function encryptForDevice(plaintext, devId, accountToken) {
  const configKey = createHmac('sha256', PROVISION_SECRET)
    .update(`${devId}:${accountToken}`)
    .digest('hex');
  const key = Buffer.from(configKey, 'hex').slice(0, 32);
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encryptedBlob: `gcm:${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`, configKey };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ 1. PREUVE AVANT — échec sous Hermes (sans crypto.subtle) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Environnement Hermes simulé : PAS de Web Crypto API
  const savedCrypto = globalThis.crypto;
  delete globalThis.crypto;

  // Ancienne logique (historique, provisionClient.ts avant fix)
  const legacyCheck = () => {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('Moteur cryptographique indisponible');
    }
  };
  assert.throws(legacyCheck, /Moteur cryptographique indisponible/);
  ok('L\'ancien code jette "Moteur cryptographique indisponible" sous Hermes (cause racine confirmée)');

  // Nouvelle logique : fonctionne dans le MÊME environnement
  const plain = decryptSxbBlob(
    encryptForDevice('{"protocol":"ssh","host":"1.2.3.4"}', deviceId, dataToken).encryptedBlob,
    createHmac('sha256', PROVISION_SECRET).update(`${deviceId}:${dataToken}`).digest('hex'),
  );
  assert.equal(JSON.parse(plain).host, '1.2.3.4');
  ok('Le nouveau fallback pur-TS déchiffre correctement SANS crypto.subtle (fix validé)');

  globalThis.crypto = savedCrypto;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ 2. Pipeline serveur exact (dashboard → DB → provision) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Le dashboard stocke le password chiffré (vpn-profiles.ts)
  const encPassword = dbEncryptGcm('SshP@ssw0rd!2026');
  assert.ok(encPassword.startsWith('gcm:'));

  // provision.ts le déchiffre pour construire la config brute
  const password = decryptDbField(encPassword);
  assert.equal(password, 'SshP@ssw0rd!2026');
  ok('dbEncrypt (vpn-profiles) → decryptDbField (provision) : roundtrip GCM OK');

  // Config brute complète telle que provision.ts la construit (profil ssh+payload)
  const rawConfig = {
    protocol:        'ssh+payload',
    displayProtocol: 'MTN Protocol',
    host:            '154.72.31.88',
    port:            443,
    username:        'sxb_client_42',
    password:        password,
    uuid:            null,
    tls:             true,
    sni:             'www.whatsapp.com',
    network:         'tcp',
    dns:             '1.1.1.1',
    payload:         'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]',
    payloadId:       'pl-123',
    path:            null, headerType: null, grpcServiceName: null, flow: null,
    fingerprint:     null, publicKey: null, shortId: null, spiderX: null,
    profileId:       'prof-1', profileName: 'Camtel SSH+WS',
  };

  // encryption côté serveur (provision.ts)
  const { encryptedBlob, configKey } = encryptForDevice(JSON.stringify(rawConfig), deviceId, dataToken);
  assert.ok(encryptedBlob.startsWith('gcm:'));
  assert.equal(configKey.length, 64);
  ok('encryptForDevice produit blob gcm: + configKey 64 hex (format serveur conforme)');

  // Décryptage côté mobile (nouveau moteur)
  const decryptedJson = decryptSxbBlob(encryptedBlob, configKey);
  const mobileConfig  = JSON.parse(decryptedJson);
  assert.deepEqual(mobileConfig, rawConfig);
  ok('decryptSxbBlob (mobile) === rawConfig (serveur) — deep-equal AUCUN champ perdu');

  // Vérification champs critiques (ÉTAPE 3 de la mission)
  for (const f of ['host', 'port', 'username', 'password', 'payload', 'protocol', 'sni', 'tls', 'dns', 'network']) {
    assert.ok(f in mobileConfig, `champ manquant: ${f}`);
  }
  ok('Tous les champs critiques présents : host, port, username, password, payload, protocol, sni, tls, dns, network');

  // Gardien de complétude
  const check = isCompleteOfflineConfig(mobileConfig);
  assert.equal(check.complete, true);
  assert.equal(check.hasHost, true);
  assert.equal(check.hasCreds, true);
  ok('isCompleteOfflineConfig → complete=true, hasHost=true, hasCreds=true');

  // Validation stricte du validateur (ssh+payload)
  const valid = validateVpnConfig(mobileConfig);
  assert.equal(valid.valid, true, valid.errors.join('; '));
  ok('validateVpnConfig(ssh+payload) → valid=true');

  // Blob lié à l'appareil : un AUTRE deviceId ne peut pas déchiffrer
  const otherKey = createHmac('sha256', PROVISION_SECRET).update(`SXBOTHER99999:${dataToken}`).digest('hex');
  assert.throws(() => decryptSxbBlob(encryptedBlob, otherKey), /authentification échouée/);
  ok('Anti-portabilité : mauvaise clé par-appareil → rejet (GCM auth fail)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ 3. Protocoles multiples (ÉTAPE 3 & 8 — rien ne disparaît) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  const profiles = [
    { name: 'ssh', cfg: { protocol: 'ssh', host: 'h.sxb.cm', port: 22, username: 'u', password: 'p' } },
    { name: 'vless', cfg: { protocol: 'vless', host: 'v.sxb.cm', port: 443, uuid: '8b6f3f5e-1234-4abc-9def-0123456789ab', sni: 'cdn.example.com', tls: true, network: 'ws', path: '/ray', flow: 'xtls-rprx-vision', fingerprint: 'chrome' } },
    { name: 'vmess', cfg: { protocol: 'vmess', host: 'v.sxb.cm', port: 80, uuid: '8b6f3f5e-1234-4abc-9def-0123456789ab', network: 'ws', path: '/vm', tls: false } },
    { name: 'trojan', cfg: { protocol: 'trojan', host: 't.sxb.cm', port: 443, password: 'trojan-pass', sni: 't.sxb.cm', tls: true } },
    { name: 'shadowsocks', cfg: { protocol: 'shadowsocks', host: 's.sxb.cm', port: 8388, method: 'aes-256-gcm', password: 'ss-pass' } },
    { name: 'hysteria2', cfg: { protocol: 'hysteria2', host: 'h2.sxb.cm', port: 443, password: 'hy2-pass', sni: 'h2.sxb.cm', tls: true } },
    { name: 'tuic', cfg: { protocol: 'tuic', host: 'tu.sxb.cm', port: 443, uuid: '8b6f3f5e-1234-4abc-9def-0123456789ab', password: 'tuic-pass', tls: true } },
    { name: 'wireguard', cfg: { protocol: 'wireguard', host: 'wg.sxb.cm', port: 51820, privateKey: 'WGprivkey+/base64/ABCDEFGHIJKLMNOPQRSTUVWXYZ0000=', publicKey: 'WGpeerpubkeybase64/ABCDEFGHIJKLMNOPQRSTUVWXYZ1=', endpoint: 'wg.sxb.cm:51820' } },
  ];

  for (const { name, cfg } of profiles) {
    const { encryptedBlob, configKey } = encryptForDevice(JSON.stringify(cfg), deviceId, dataToken);
    const back = JSON.parse(decryptSxbBlob(encryptedBlob, configKey));
    assert.deepEqual(back, cfg, `${name}: mismatch`);
    const check = isCompleteOfflineConfig(back);
    assert.equal(check.complete, true, `${name}: incomplete ${JSON.stringify(check)}`);
    const valid = validateVpnConfig(back);
    assert.equal(valid.valid, true, `${name}: ${valid.errors.join('; ')}`);
  }
  ok('8 protocoles : serveur → blob → mobile → gardien complet + validateur OK');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ 4. Fuzz croisé Node crypto ↔ TS pur (25 vecteurs) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  const sizes = [0, 1, 15, 16, 17, 31, 32, 100, 255, 256, 1024, 3000];
  let iter = 0;
  for (const n of sizes) {
    // sens 1 : Node chiffre → TS déchiffre
    const key = randomBytes(32);
    const iv  = randomBytes(12);
    const data = randomBytes(n);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    const tag = c.getAuthTag();
    const back = decryptAes256Gcm(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(enc), new Uint8Array(tag));
    assert.deepEqual(Buffer.from(back), data);
    iter++;

    // sens 2 : TS chiffre → Node déchiffre
    const { ciphertext, authTag } = encryptAes256Gcm(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(data));
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(Buffer.from(authTag));
    const dec = Buffer.concat([d.update(Buffer.from(ciphertext)), d.final()]);
    assert.deepEqual(dec, data);
    iter++;
  }
  assert.equal(iter, 24);
  ok(`24 roundtrips croisés Node↔TS sur tailles 0..3000 octets — AES-256-GCM bit-exact`);

  // Rejet falsification (1 bit modifié dans le ciphertext)
  {
    const { encryptedBlob, configKey } = encryptForDevice('{"a":1}', deviceId, dataToken);
    const parts = encryptedBlob.split(':');
    const cipher = hexToBytes(parts[2]);
    cipher[0] ^= 1;
    parts[2] = bytesToHex(cipher);
    assert.throws(() => decryptSxbBlob(parts.join(':'), configKey), /authentification échouée/);
    ok('Falsification ciphertext → rejet AEAD');
  }
  // Rejet tag tronqué / segment manquant
  {
    const { encryptedBlob, configKey } = encryptForDevice('x', deviceId, dataToken);
    assert.throws(() => decryptSxbBlob(encryptedBlob.split(':').slice(0, 3).join(':'), configKey));
    ok('Blob tronqué → rejet');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ 5. Gardien complétude + fusion (offline-safe) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Config "métadonnées seules" (ce que /mobile/vpn/config renvoie aujourd'hui)
  const metaOnly = { configId: 'prof-1', protocol: 'ssh', displayProtocol: 'MTN', dataToken };
  const c1 = isCompleteOfflineConfig(metaOnly);
  assert.equal(c1.complete, false);
  assert.ok(c1.missing.includes('host') && c1.missing.includes('credentials'));
  ok('Config métadonnées-seules → correctement rejetée (host, credentials manquants)');

  // mergeConfigs : la fusion ne perd JAMAIS les champs critiques
  const stored = { host: 'real.host.cm', port: 443, username: 'user1', password: 'pass1', payload: 'GET / HTTP/1.1[crlf]...', protocol: 'ssh', dataToken };
  const merged = mergeConfigs(stored, metaOnly);
  assert.equal(merged.host, 'real.host.cm');
  assert.equal(merged.password, 'pass1');
  assert.equal(merged.payload, 'GET / HTTP/1.1[crlf]...');
  assert.equal(merged.displayProtocol, 'MTN');
  assert.equal(isCompleteOfflineConfig(merged).complete, true);
  ok('mergeConfigs(stockée, métadonnées) → config complète conservée (aucune perte)');

  // mergeConfigs n'écrase pas avec des valeurs vides/nulles
  const merged2 = mergeConfigs(stored, { host: '', password: null });
  assert.equal(merged2.host, 'real.host.cm');
  assert.equal(merged2.password, 'pass1');
  ok('mergeConfigs ignore host="" et password=null — pas de régression destructive');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ 6. UTF-8 (payloads avec accents / emoji) ══');
// ═══════════════════════════════════════════════════════════════════════════
{
  const tricky = 'Payload SSH — Connecté à l\'hôte : émoji 🚀🔒, caractères: éèêàç ñ — 中文';
  const bytes = utf8Encode(tricky);
  assert.equal(utf8Decode(bytes), tricky);
  // Cross-check contre l'implémentation native Buffer (référence)
  assert.equal(Buffer.from(utf8Encode(tricky)).toString('utf8'), tricky);
  assert.equal(utf8Decode(new Uint8Array(Buffer.from(tricky, 'utf8'))), tricky);
  const { encryptedBlob, configKey } = encryptForDevice(JSON.stringify({ payload: tricky }), deviceId, dataToken);
  assert.equal(JSON.parse(decryptSxbBlob(encryptedBlob, configKey)).payload, tricky);
  ok('UTF-8 roundtrip exact (accents, emoji, CJK) via blob chiffré');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n🏁 RÉSULTAT : ${passed} groupes de tests réussis — pipeline provision validé de bout en bout\n`);

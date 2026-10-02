/**
 * ssh-relay-dns.test.mjs — Le DNS des applications passe par le tunnel.
 *
 * SIGNALÉ : « ça se connecte, les compteurs montent et descendent, bon ping,
 * mais les données ne sont pas utilisables hors de l'app ».
 *
 * CAUSE MESURÉE avec sing-box 1.12.9 : un serveur DNS sans `detour` sort EN
 * DIRECT depuis 1.12 (en 1.11 il prenait l'outbound par défaut, donc le
 * tunnel). Le relais SSH déclarait son résolveur `dns-r` sans détour : toutes
 * les résolutions des applications partaient vers 8.8.8.8 hors tunnel. Sur un
 * forfait qui ne décompte que le tunnel, elles échouaient — et avec elles tout
 * le trafic des autres applications.
 *
 * Le comportement est prouvé sur JVM (StabilityPolicyTest) et contre le vrai
 * moteur ; ce banc tient les deux points d'ancrage dans le source.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lire = (...p) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const service = lire('app-mobile', 'modules', 'android-native', 'SxbVpnService.kt');
const schema = lire('app-mobile', 'modules', 'android-native', 'SxbEngineSchema.kt');
const relais = service.slice(service.indexOf('private fun buildSshSocksRelayConfig('),
  service.indexOf('// SOCKS5 SERVER (pour relayer SSH → TUN)'));

test('le résolveur du relais SSH sort explicitement par le tunnel', () => {
  assert.ok(relais.length > 200, 'générateur du relais introuvable');
  assert.match(relais, /put\("tag", "dns-r"\)[\s\S]{0,1200}?\.put\("detour", requestedResolver\?\.optString\("detour"\) \?: "proxy"\)\)/,
    'dns-r doit porter detour=proxy : sans lui, sing-box 1.12 résout en direct');
  // L'amorçage, lui, reste hors tunnel : il résout le serveur à joindre.
  assert.match(relais, /val requestedResolver = profileDnsObject\(dnsChoice\)/);
  assert.match(relais, /put\("tag", "dns-l"\)[\s\S]{0,200}?put\("detour", "direct"\)/);
});

test('la traduction garde le chemin hérité des serveurs DNS sans détour', () => {
  assert.match(schema, /private fun outboundParDefautHerite\(config: JSONObject\): String\?/);
  // Lu avant la réécriture des outbounds, qui retire dns/block.
  const moderniser = schema.slice(schema.indexOf('fun moderniser('), schema.indexOf('private fun resolveurDAmorcage'));
  assert.ok(moderniser.indexOf('outboundParDefautHerite(config)') < moderniser.indexOf('moderniserOutbounds(config)'));
  assert.match(schema, /detour\.isEmpty\(\) && defautHerite != null && traduit\.optString\("type"\) !in TYPES_SANS_DETOUR/);
});

test('sans UDPGW, le relais refuse QUIC tout de suite au lieu de le laisser expirer', () => {
  assert.match(service, /buildSshSocksRelayConfig\(host, relaisUdp = udpMode == "udpgw", dnsChoice = connectionDnsChoice\(cfg\)\)/);
  assert.match(relais, /if \(!relaisUdp\) \{\s*routeRules\.put\(JSONObject\(\)\.put\("network", "udp"\)\.put\("port", JSONArray\(\)\.put\(443\)\)\.put\("outbound", "block"\)\)/);
  assert.match(relais, /put\("type", "block"\)\.put\("tag", "block"\)/, 'la règle doit désigner un outbound qui existe');
});

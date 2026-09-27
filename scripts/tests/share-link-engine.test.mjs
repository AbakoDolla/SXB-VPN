/**
 * share-link-engine.test.mjs — Les liens VLESS/VMess/Trojan « de fournisseur »
 * fonctionnent dans l'application comme dans les autres clients.
 *
 * CAS D'ORIGINE (compte réel, jamais recopié ici) : VLESS sur WebSocket + TLS,
 * adresse et SNI sur un domaine Google, en-tête Host sur un relais Cloud Run,
 * `fp=chrome`, chemin `/@…`. Le tunnel a été établi de bout en bout avec le
 * moteur sing-box 1.12.9 de l'application. Trois écritures voisines, courantes
 * chez les fournisseurs, le cassaient en revanche — reproduites sur le même
 * compte avec le même moteur :
 *   • `path=/x?ed=2048` → 404 du relais (sing-box envoyait `?ed=` tel quel) ;
 *   • `alpn=h2,http/1.1` sur WebSocket → EOF juste après TLS ;
 *   • `fp=Chrome` / `fp=randomizednoalpn` → moteur refusé au démarrage.
 * L'adaptation vit dans le moteur natif (SxbTunnelPolicy, testé sur JVM) ; ce
 * banc vérifie qu'elle est branchée sur les deux chemins et que le tableau de
 * bord valide le même chemin que l'appareil.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lire = (...p) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const { parseImportedConfig, validateTransportCoherence } = await import('../../server/services/canonical-config.ts');
const { websocketRequestPath } = await import('../../server/services/transport-probe.ts');
const { parseVlessUri } = await import('../../app-mobile/services/vlessUri.ts');

// Même forme que le compte d'origine, valeurs synthétiques.
const FRONTED = 'vless://11111111-2222-4333-8444-555555555555@front.example.test:443'
  + '?path=%2F%40relay006&security=tls&encryption=none&insecure=0&host=relay.example.test'
  + '&fp=chrome&type=ws&allowInsecure=0&sni=front.example.test#websocket-relay';

test('un lien fronté garde ses trois noms distincts, côté serveur comme côté application', () => {
  const server = parseImportedConfig(FRONTED);
  assert.ok(server.ok, server.errors.join(' | '));
  const mobile = parseVlessUri(FRONTED).config;
  for (const config of [server.canonical, mobile]) {
    assert.equal(config.host, 'front.example.test', 'adresse TCP jointe');
    assert.equal(config.sni, 'front.example.test', 'nom présenté pendant TLS');
    assert.equal(config.wsHost, 'relay.example.test', 'en-tête Host du WebSocket');
    assert.equal(config.path, '/@relay006');
    assert.equal(config.fingerprint, 'chrome');
    assert.equal(config.alpn, 'http/1.1', 'un WebSocket ne peut négocier que HTTP/1.1');
    assert.equal(config.insecure, false);
    assert.equal(config.network, 'ws');
  }
  assert.deepEqual(validateTransportCoherence(server.canonical), { errors: [], warnings: [] });
});

test('la sonde du tableau de bord demande le chemin que demandera l’appareil', () => {
  assert.equal(websocketRequestPath('/@relay006?ed=2048'), '/@relay006');
  assert.equal(websocketRequestPath('/ws?a=1&ed=4096&eh=X-Early&b=2'), '/ws?a=1&b=2');
  assert.equal(websocketRequestPath('ws'), '/ws');
  assert.equal(websocketRequestPath(''), '/');
  // Rien n'est retiré hors d'une vraie demande d'early data.
  assert.equal(websocketRequestPath('/ws?token=ed'), '/ws?token=ed');
  assert.equal(websocketRequestPath('/ws?ed=abc'), '/ws?ed=abc');
  assert.equal(websocketRequestPath('/ws?ed=0'), '/ws?ed=0');
});

test('un transport que le moteur embarqué ne sait pas ouvrir est signalé à l’import', () => {
  for (const network of ['xhttp', 'splithttp', 'kcp']) {
    const { errors, warnings } = validateTransportCoherence({
      protocol: 'vless', host: 'h.example.test', port: 443, uuid: '11111111-2222-4333-8444-555555555555', network,
    });
    assert.deepEqual(errors, [], 'signalé, jamais refusé : des profils existants le portent');
    assert.ok(warnings.some(w => w.includes(network) && w.includes('sing-box')), warnings.join(' | '));
  }
  assert.deepEqual(validateTransportCoherence({
    protocol: 'vless', host: 'h.example.test', port: 443, uuid: '11111111-2222-4333-8444-555555555555', network: 'ws',
  }).warnings, []);
});

test('les deux chemins du moteur passent par la même adaptation', () => {
  const service = lire('app-mobile', 'modules', 'android-native', 'SxbVpnService.kt');
  const plat = service.slice(service.indexOf('private fun buildSingBoxConfig('), service.indexOf('private fun transportSansUdp('));
  assert.match(plat, /SxbTunnelPolicy\.rejectUnsupportedStreamTransport\(network\)/);
  assert.match(plat, /SxbTunnelPolicy\.normalizeStreamOutbound\(proxyOutbound\)/);
  const brut = service.slice(service.indexOf('private fun buildRawSingBoxConfig('));
  const boucle = brut.slice(0, brut.indexOf('// Au moins un outbound non spécial'));
  assert.match(boucle, /SxbTunnelPolicy\.normalizeStreamOutbound\(o\)/);
  // Le refus doit être classé comme tel, pas comme une panne réseau.
  const politique = lire('app-mobile', 'modules', 'android-native', 'SxbTunnelPolicy.kt');
  assert.match(politique, /"CONFIG_UNSUPPORTED — transport « \$kind » non supporté/);
  assert.match(service, /lower\.contains\("non supporté"\)[\s\S]{0,400}?"CONFIG_UNSUPPORTED"/);
});

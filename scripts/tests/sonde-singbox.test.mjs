/**
 * sonde-singbox.test.mjs — Le point d'entrée réellement composé par l'appareil.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 * ═══════════════════════════════════════════════════════════════════════════
 * Une configuration sing-box — importée telle quelle ou traduite depuis Xray —
 * ne porte ni `host` ni `port` à sa racine : tout vit dans `outbounds`. La
 * sonde du tableau de bord la déclarait donc « non applicable », et
 * l'exploitant n'avait AUCUN moyen de vérifier un profil avant de le
 * distribuer. C'est pourtant la forme exacte des profils de fournisseur,
 * chaînés derrière un proxy d'opérateur.
 *
 * Ce qui est sondé, c'est le PREMIER SAUT. Quand la sortie principale possède
 * un `detour`, l'appareil ouvre d'abord sa connexion vers CE maillon, pas vers
 * le serveur final. Sonder le serveur final donnerait un verdict sur une
 * adresse que l'appareil ne compose jamais directement — souvent injoignable
 * depuis un VPS, donc un faux négatif qui ferait jeter un profil valide.
 *
 * Ces contrôles n'ouvrent aucune socket : ils portent sur le CHOIX de la cible.
 *
 * Exécution : npx tsx --test scripts/tests/sonde-singbox.test.mjs
 */
import './register-hooks.mjs';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e2e-encryption-key-32-bytes-pad!';

const { pointEntreeSingbox } = await import(
  pathToFileURL(path.join(ROOT, 'server/services/transport-probe.ts')).href
);
const { parseImportedConfig } = await import(
  pathToFileURL(path.join(ROOT, 'server/services/canonical-config.ts')).href
);

describe('point d’entrée d’une configuration sing-box', () => {
  it('suit la chaîne jusqu’au maillon composé en premier', () => {
    // Le cas réel : un Trojan/WS chaîné derrière un proxy d'opérateur. C'est
    // le proxy qui est joint en premier ; le serveur Trojan ne l'est jamais
    // directement.
    const entree = pointEntreeSingbox({
      outbounds: [
        { type: 'trojan', tag: 'TROJAN', server: 'srv.example.test', server_port: 8443,
          detour: 'hunters', transport: { type: 'ws', path: '/s', headers: { Host: 'srv.example.test' } },
          tls: { enabled: true, insecure: true, server_name: 'srv.example.test' } },
        { type: 'http', tag: 'hunters', server: '203.0.113.9', server_port: 8080 },
        { type: 'direct', tag: 'direct' },
      ],
      route: { final: 'TROJAN' },
    });
    assert.equal(entree.host, '203.0.113.9', 'c’est le proxy amont qui est composé');
    assert.equal(entree.port, 8080);
    assert.equal(entree.chaine, true);
    assert.equal(entree.tls, false, 'le proxy amont ne présente pas de TLS');
  });

  it('sonde directement le serveur quand il n’y a pas de chaîne', () => {
    const entree = pointEntreeSingbox({
      outbounds: [
        { type: 'vless', tag: 'proxy', server: 'front.example.test', server_port: 443,
          transport: { type: 'ws', path: '/@x', headers: { Host: 'svc.example.test' } },
          tls: { enabled: true, server_name: 'front.example.test' } },
        { type: 'direct', tag: 'direct' },
      ],
      route: { final: 'proxy' },
    });
    assert.equal(entree.host, 'front.example.test');
    assert.equal(entree.chaine, false);
    assert.equal(entree.tls, true);
    assert.equal(entree.sni, 'front.example.test', 'le nom TLS est celui de la façade');
    assert.equal(entree.wsHost, 'svc.example.test', 'l’en-tête Host désigne le vrai service');
    assert.equal(entree.path, '/@x');
    assert.equal(entree.network, 'ws');
  });

  it('ne tourne pas en rond sur un détour circulaire', () => {
    // Un profil malformé ne doit pas faire boucler la sonde du serveur.
    const entree = pointEntreeSingbox({
      outbounds: [
        { type: 'vless', tag: 'a', server: 'a.example.test', server_port: 443, detour: 'b' },
        { type: 'http', tag: 'b', server: 'b.example.test', server_port: 8080, detour: 'a' },
      ],
      route: { final: 'a' },
    });
    assert.ok(entree, 'un point d’entrée est tout de même rendu');
    assert.ok(['a.example.test', 'b.example.test'].includes(entree.host));
  });

  it('rend null plutôt que d’inventer une cible', () => {
    assert.equal(pointEntreeSingbox({}), null);
    assert.equal(pointEntreeSingbox({ outbounds: [] }), null);
    // Aucune sortie utile : seulement des outbounds spéciaux.
    assert.equal(pointEntreeSingbox({
      outbounds: [{ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }],
      route: { final: 'direct' },
    }), null);
    // Une sortie sans adresse n'est pas sondable.
    assert.equal(pointEntreeSingbox({
      outbounds: [{ type: 'vless', tag: 'p', server: '', server_port: 0 }], route: { final: 'p' },
    }), null);
  });

  it('trouve le point d’entrée du JSON Xray réel, après traduction', () => {
    // Le chemin complet : le JSON du fournisseur est traduit à l'import, puis
    // la sonde lit la forme traduite. Vérifier les deux séparément laisserait
    // passer une rupture entre les deux.
    const r = parseImportedConfig(JSON.stringify({
      log: { loglevel: 'warning' },
      dns: { servers: ['8.8.8.8'] },
      inbounds: [{ listen: '127.0.0.1', port: '10808', protocol: 'socks',
        settings: { auth: 'noauth', udp: true }, tag: 'socks-inbound' }],
      outbounds: [
        { protocol: 'trojan', tag: 'TROJAN',
          proxySettings: { tag: 'hunters', transportLayer: true },
          settings: { servers: [{ address: 'basic.example.test', level: 8, password: 'x', port: 8443 }] },
          streamSettings: { network: 'ws', security: 'tls',
            tlsSettings: { allowInsecure: true, serverName: 'basic.example.test' },
            wsSettings: { path: '/stuffboy', headers: { Host: 'basic.example.test' } } } },
        { protocol: 'http', tag: 'hunters',
          settings: { servers: [{ address: '203.0.113.32', port: 8080 }],
            headers: { Host: 'm.example.test:443', 'X-iorg-bsid': '@hunters' } } },
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'block' },
      ],
      routing: { rules: [{ type: 'field', inboundTag: ['socks-inbound'], outboundTag: 'TROJAN' }] },
    }));
    assert.equal(r.ok, true, r.errors.join(' | '));
    assert.equal(r.canonical.protocol, 'singbox');

    const entree = pointEntreeSingbox(r.canonical);
    assert.ok(entree, 'la configuration traduite doit rester sondable');
    assert.equal(entree.host, '203.0.113.32', 'c’est le proxy d’opérateur qui est joint en premier');
    assert.equal(entree.port, 8080);
    assert.equal(entree.chaine, true);
  });
});

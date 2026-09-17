/**
 * couverture-formats.test.mjs — Tout format VLESS courant entre des DEUX côtés.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA QUESTION À LAQUELLE CE FICHIER RÉPOND
 * ═══════════════════════════════════════════════════════════════════════════
 * « Est-ce qu'une configuration VLESS, quel que soit son format, s'importe
 * partout ? » On ne peut y répondre qu'en passant les formats réels dans les
 * VRAIS analyseurs — celui du tableau de bord et celui de l'application.
 *
 * Deux analyseurs, c'est deux occasions de diverger. Et une divergence ici ne
 * se voit pas : le même fichier est accepté d'un côté, refusé de l'autre, et
 * l'utilisateur ne comprend pas pourquoi « ça marche sur le site mais pas dans
 * l'app ». Deux défauts de ce genre ont été trouvés en écrivant ce fichier —
 * l'IPv6 littérale refusée par le tableau de bord, le format de partage
 * v2rayN refusé par l'application.
 *
 * Exécution : npx tsx --test scripts/tests/couverture-formats.test.mjs
 */
import './register-hooks.mjs';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e2e-encryption-key-32-bytes-pad!';

const { parseImportedConfig } = await import(
  pathToFileURL(path.join(ROOT, 'server/services/canonical-config.ts')).href
);
const { validateVpnConfig, isCompleteOfflineConfig } = await import(
  pathToFileURL(path.join(ROOT, 'app-mobile/services/configValidator.ts')).href
);
const { lireProfilV2rayN } = await import(
  pathToFileURL(path.join(ROOT, 'app-mobile/services/v2rayNProfile.ts')).href
);

const UUID = 'ae446a7b-9988-4353-80c7-050a915e1a1e';

/** Les formats sous lesquels un profil VLESS circule réellement. */
const FORMATS = {
  'URI ws+tls, trois hôtes distincts':
    `vless://${UUID}@front.example.com:443?path=%2F%40x&security=tls&encryption=none`
    + `&host=svc.example.run.app&fp=chrome&type=ws&sni=front.example.com#A`,
  'URI ws+tls sans sni':
    `vless://${UUID}@front.example.com:443?type=ws&security=tls&host=svc.example.run.app&path=%2Fws`,
  'URI tcp sans TLS':
    `vless://${UUID}@1.2.3.4:8080?type=tcp&security=none`,
  'URI Reality + gRPC':
    `vless://${UUID}@ex.example.com:443?security=reality&type=grpc&pbk=ABC123&sid=ff00&serviceName=svc&fp=firefox#R`,
  'URI httpupgrade':
    `vless://${UUID}@ex.example.com:443?type=httpupgrade&security=tls&host=h.example.com&path=%2Fu`,
  'URI avec flow xtls-rprx-vision':
    `vless://${UUID}@ex.example.com:443?security=tls&type=tcp&flow=xtls-rprx-vision&fp=chrome`,
  'URI avec IPv6 littérale':
    `vless://${UUID}@[2001:db8::1]:443?type=ws&security=tls&host=h.example.com&path=%2Fw`,
  'URI avec ALPN imposé':
    `vless://${UUID}@ex.example.com:443?type=ws&security=tls&alpn=h2&host=h.example.com&path=%2Fw`,
  'JSON Xray complet': JSON.stringify({
    inbounds: [], outbounds: [{
      protocol: 'vless', tag: 'VLESS',
      settings: { vnext: [{ address: 'front.example.com', port: 443, users: [{ id: UUID, encryption: 'none', level: 8 }] }] },
      streamSettings: {
        network: 'ws', security: 'tls',
        tlsSettings: { allowInsecure: true, serverName: 'front.example.com' },
        wsSettings: { headers: { Host: 'svc.example.run.app' }, path: '/@x' },
      },
    }],
  }),
  'JSON sing-box natif': JSON.stringify({
    outbounds: [
      { type: 'vless', tag: 'proxy', server: 'front.example.com', server_port: 443, uuid: UUID,
        transport: { type: 'ws', path: '/@x', headers: { Host: 'svc.example.run.app' } },
        tls: { enabled: true, server_name: 'front.example.com' } },
      { type: 'direct', tag: 'direct' },
    ],
    route: { rules: [{ ip_is_private: true, outbound: 'direct' }], final: 'proxy' },
  }),
  'JSON de partage v2rayN': JSON.stringify({
    v: '2', ps: 'Test', add: 'front.example.com', port: '443', id: UUID,
    net: 'ws', type: 'none', host: 'svc.example.run.app', path: '/@x',
    tls: 'tls', sni: 'front.example.com', protocol: 'vless',
  }),
  'JSON canonique SXB': JSON.stringify({
    protocol: 'vless', host: 'front.example.com', port: 443, uuid: UUID,
    network: 'ws', tls: true, path: '/@x', wsHost: 'svc.example.run.app', sni: 'front.example.com',
  }),
  'liste d’URI (abonnement)':
    `vless://${UUID}@a.example.com:443?type=ws&security=tls&host=h1.example.com&path=%2F1#un\n`
    + `vless://${UUID}@b.example.com:443?type=ws&security=tls&host=h2.example.com&path=%2F2#deux`,
};

describe('couverture des formats — les deux côtés acceptent la même chose', () => {
  for (const [nom, brut] of Object.entries(FORMATS)) {
    it(`accepte « ${nom} » au tableau de bord ET dans l’application`, () => {
      const serveur = parseImportedConfig(brut);
      assert.equal(serveur.ok, true, `tableau de bord : ${serveur.errors.join(' | ')}`);

      const app = validateVpnConfig(brut);
      assert.equal(app.valid, true, `application : ${app.errors.join(' | ')}`);

      // Accepter à l'import ne suffit pas : une configuration incomplète
      // s'importe puis échoue à l'ouverture du tunnel, ce qui est pire qu'un
      // refus net — l'utilisateur croit son profil bon.
      const complet = isCompleteOfflineConfig(app.config);
      assert.equal(complet.complete, true, `champs manquants : ${complet.missing.join(', ')}`);
    });
  }
});

describe('les trois adresses restent distinctes dans tous les formats', () => {
  /**
   * Les trois valeurs, quelle que soit la FORME du profil.
   *
   * Un JSON Xray collé tel quel garde sa forme : c'est le code natif qui le
   * traduit au démarrage. Chercher uniquement la forme sing-box passerait donc
   * à côté du cas le plus courant.
   */
  function adresses(cfg) {
    if (cfg.protocol === 'vless') {
      return { adresse: cfg.host, enTete: cfg.wsHost, nomTls: cfg.sni };
    }
    for (const o of cfg.outbounds || []) {
      if (o.type === 'vless') {
        return {
          adresse: o.server,
          enTete: o.transport?.headers?.Host,
          nomTls: o.tls?.server_name,
        };
      }
      if (o.protocol === 'vless') {
        const flux = o.streamSettings || {};
        return {
          adresse: o.settings?.vnext?.[0]?.address,
          enTete: flux.wsSettings?.headers?.Host,
          nomTls: flux.tlsSettings?.serverName,
        };
      }
    }
    return {};
  }

  for (const nom of ['URI ws+tls, trois hôtes distincts', 'JSON Xray complet',
    'JSON sing-box natif', 'JSON de partage v2rayN', 'JSON canonique SXB']) {
    it(`« ${nom} » ne confond pas adresse, nom TLS et en-tête Host`, () => {
      const app = validateVpnConfig(FORMATS[nom]);
      assert.equal(app.valid, true, app.errors.join(' | '));
      const { adresse, enTete, nomTls } = adresses(app.config);

      assert.equal(adresse, 'front.example.com', 'l’adresse jointe est celle de la façade');
      assert.equal(enTete, 'svc.example.run.app', 'l’en-tête Host désigne le vrai service');
      assert.equal(nomTls, 'front.example.com', 'le nom présenté en TLS est celui de la façade');
      // Confondre l'adresse et l'en-tête écrirait le vrai service en clair
      // dans le premier paquet, ce qui vide une façade de tout son sens.
      assert.notEqual(adresse, enTete);
    });
  }
});

describe('parité v2rayN — tableau de bord et application', () => {
  const BASE = {
    v: '2', ps: 'Test', add: 'front.example.com', port: '443', id: UUID,
    net: 'ws', type: 'none', host: 'svc.example.run.app', path: '/@x',
    tls: 'tls', sni: 'front.example.com', protocol: 'vless',
  };
  /** Les variantes qui font vraiment diverger deux lectures. */
  const CAS = {
    'profil complet': BASE,
    'sans sni': (() => { const c = { ...BASE }; delete c.sni; return c; })(),
    'sans TLS': { ...BASE, tls: '' },
    'transport tcp': { ...BASE, net: 'tcp', type: 'none' },
    'avec flow': { ...BASE, flow: 'xtls-rprx-vision' },
    'avec empreinte et alpn': { ...BASE, fp: 'chrome', alpn: ['h2', 'http/1.1'] },
  };

  for (const [nom, entree] of Object.entries(CAS)) {
    it(`lit « ${nom} » de façon identique des deux côtés`, () => {
      const serveur = parseImportedConfig(JSON.stringify(entree));
      assert.equal(serveur.ok, true, serveur.errors.join(' | '));
      const mobile = lireProfilV2rayN(entree);
      assert.notEqual(mobile, null, 'application : profil refusé');

      for (const champ of ['protocol', 'host', 'port', 'uuid', 'network', 'tls', 'path', 'wsHost', 'sni', 'flow', 'fingerprint']) {
        if (mobile[champ] === undefined && serveur.canonical[champ] === undefined) continue;
        assert.deepEqual(
          serveur.canonical[champ], mobile[champ],
          `champ « ${champ} » divergent : serveur=${JSON.stringify(serveur.canonical[champ])} `
          + `application=${JSON.stringify(mobile[champ])}`,
        );
      }
    });
  }

  it('ne détourne jamais un canonique SXB déjà formé', () => {
    // Un canonique porte son adresse dans `host` ; ce format y met l'EN-TÊTE
    // Host. Les confondre ferait joindre le vrai service en clair.
    assert.equal(lireProfilV2rayN({
      protocol: 'vless', host: 'front.example.com', port: 443, uuid: UUID,
      network: 'ws', wsHost: 'svc.example.run.app',
    }), null);
    assert.equal(lireProfilV2rayN({ outbounds: [], route: {} }), null);
    assert.equal(lireProfilV2rayN(null), null);
    // Et un protocole que le moteur ne sait pas exécuter est refusé net plutôt
    // que deviné : deviner produirait un import qui échoue au démarrage.
    assert.equal(lireProfilV2rayN({ add: 'a.test', port: 443, protocol: 'inconnu' }), null);
  });
});

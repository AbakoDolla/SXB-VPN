/**
 * parite-uri-import.test.mjs — Une URI importée par un administrateur produit
 * dans l'application EXACTEMENT ce que le serveur en a tiré.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MANQUE QUE CE FICHIER COMBLE
 * ══════════════════════════════════════════════════════════════════════════
 * `couverture-formats.test.mjs` vérifie déjà que les deux côtés ACCEPTENT les
 * mêmes formats, et il compare champ par champ — mais seulement pour le JSON
 * de partage v2rayN. Pour une URI, il vérifie l'acceptation des deux côtés,
 * jamais l'ÉGALITÉ du résultat.
 *
 * Or l'URI est la forme sous laquelle un profil arrive presque toujours : on
 * la colle dans le tableau de bord, elle est chiffrée en base, puis restituée
 * à l'appareil par /api/provision/activate. Si les deux lectures divergent
 * d'un seul champ, le symptôme est celui que le propriétaire décrit :
 * « ça marche depuis le tableau de bord, pas quand on colle dans l'app ».
 *
 * Une divergence de ce genre ne se voit pas à l'import. Elle se voit à un
 * tunnel qui monte et ne transporte rien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA SEULE DIVERGENCE TOLÉRÉE, ET POURQUOI
 * ══════════════════════════════════════════════════════════════════════════
 * `encryption: "none"` est conservé par l'application et retiré par le
 * serveur. Ce n'est pas un défaut : sing-box REFUSE ce champ sur un outbound
 * VLESS. Le code natif le retire lui-même avant de démarrer le moteur
 * (SxbVpnService.kt — « SINGBOX_VLESS_ENCRYPTION_REMOVED »). Les deux chemins
 * convergent donc au moteur. Ce fichier VÉRIFIE cette retenue native plutôt
 * que de l'affirmer : si elle disparaissait, la tolérance deviendrait un vrai
 * écart et le test échouerait.
 *
 * Exécution : npx tsx --test scripts/tests/parite-uri-import.test.mjs
 */
import './register-hooks.mjs';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e2e-encryption-key-32-bytes-pad!';

const { parseImportedConfig, engineConfigFromCanonical, validateTransportCoherence } = await import(
  pathToFileURL(path.join(ROOT, 'server/services/canonical-config.ts')).href
);
const { parseVlessUri } = await import(
  pathToFileURL(path.join(ROOT, 'app-mobile/services/vlessUri.ts')).href
);

const UUID = 'ae446a7b-9988-4353-80c7-050a915e1a1e';

/**
 * Champs dont l'absence d'un côté est admise, avec sa justification mesurée.
 * Toute autre divergence fait échouer le test.
 */
const TOLERES = {
  // Refusé par sing-box sur un outbound VLESS ; retiré par le natif.
  encryption: 'retiré par le natif avant démarrage du moteur',
};

/** Les formes d'URI sous lesquelles un profil circule réellement. */
const URIS = {
  'façade ws+tls — trois adresses distinctes':
    `vless://${UUID}@crashlyticsreports-pa.googleapis.com:443`
    + '?path=%2F%40stuff006&security=tls&encryption=none&insecure=0'
    + '&host=stuffm-cloud-run-proxy-1023926914988.europe-west1.run.app&fp=chrome&type=ws'
    + '&allowInsecure=0&sni=crashlyticsreports-pa.googleapis.com#websocket-coldplay',
  'ws+tls sans sni — l’adresse jointe est présentée':
    `vless://${UUID}@front.example.com:8443?type=ws&host=svc.example.run.app&path=%2Fws&security=tls&fp=chrome`,
  'adresse IP littérale — l’en-tête reprend le rôle du nom':
    `vless://${UUID}@203.0.113.7:443?type=ws&host=svc.example.run.app&path=%2Fws&security=tls`,
  'chemin porteur de paramètres':
    `vless://${UUID}@front.example.com:443?network=WS&security=TLS&path=%2Fapi%3Fed%3D2048&host=svc.example.com`,
  'ALPN imposé par la façade':
    `vless://${UUID}@front.example.com:443?type=ws&security=tls&alpn=h2&host=h.example.com&path=%2Fw`,
  'certificat auto-signé assumé':
    `vless://${UUID}@front.example.com:443?type=ws&security=tls&host=h.example.com&path=%2Fw&insecure=1`,
  'transport tcp sans TLS':
    `vless://${UUID}@1.2.3.4:8080?type=tcp&security=none`,
  'Reality + gRPC':
    `vless://${UUID}@ex.example.com:443?security=reality&type=grpc&pbk=ABC123&sid=ff00&serviceName=svc&fp=firefox#R`,
  'httpupgrade':
    `vless://${UUID}@ex.example.com:443?type=httpupgrade&security=tls&host=h.example.com&path=%2Fu`,
  'flow xtls-rprx-vision':
    `vless://${UUID}@ex.example.com:443?security=tls&type=tcp&flow=xtls-rprx-vision&fp=chrome`,
};

describe('parité d’import — une URI se lit à l’identique des deux côtés', () => {
  for (const [nom, uri] of Object.entries(URIS)) {
    it(`« ${nom} » produit la même configuration au serveur et dans l’application`, () => {
      const serveur = parseImportedConfig(uri);
      assert.equal(serveur.ok, true, `serveur : ${serveur.errors.join(' | ')}`);
      assert.equal(serveur.sourceFormat, 'vless-uri');

      const { config: application } = parseVlessUri(uri);

      const champs = [...new Set([...Object.keys(serveur.canonical), ...Object.keys(application)])].sort();
      const divergents = [];
      for (const champ of champs) {
        const cotéServeur = JSON.stringify(serveur.canonical[champ]);
        const cotéApp = JSON.stringify(application[champ]);
        if (cotéServeur === cotéApp) continue;
        if (champ in TOLERES) continue;
        divergents.push(`${champ} : serveur=${cotéServeur} application=${cotéApp}`);
      }
      assert.deepEqual(divergents, [], `champs divergents — ${divergents.join(' ; ')}`);

      // Une parité sur un objet vide ne prouverait rien.
      assert.ok(champs.length >= 6, `trop peu de champs comparés (${champs.length})`);

      // Le serveur juge la cohérence du transport ; il doit accepter ce qu'il
      // vient lui-même de produire, sinon l'import reste bloqué au dépôt.
      const coherence = validateTransportCoherence(serveur.canonical);
      assert.deepEqual(coherence.errors, [], `cohérence serveur : ${coherence.errors.join(' | ')}`);
    });
  }
});

describe('la configuration remise au moteur conserve ce qui fait la façade', () => {
  it('garde l’adresse jointe, le nom TLS et l’en-tête Host distincts', () => {
    const uri = URIS['façade ws+tls — trois adresses distinctes'];
    const { canonical } = parseImportedConfig(uri);
    const moteur = engineConfigFromCanonical(canonical);

    // 1. Adresse réellement jointe en TCP.
    assert.equal(moteur.host, 'crashlyticsreports-pa.googleapis.com');
    assert.equal(moteur.port, 443);
    // 2. Nom présenté pendant la négociation TLS.
    assert.equal(moteur.sni, 'crashlyticsreports-pa.googleapis.com');
    // 3. En-tête Host du WebSocket — le seul qui désigne le vrai service.
    assert.equal(moteur.wsHost, 'stuffm-cloud-run-proxy-1023926914988.europe-west1.run.app');
    // Confondre l'adresse et l'en-tête écrirait le vrai service en clair dans
    // le premier paquet, ce qui vide une façade de tout son sens.
    assert.notEqual(moteur.host, moteur.wsHost);

    // `%2F%40` doit redevenir « /@ » : réencodé, la façade renvoie 404 et le
    // tunnel « se connecte » sans jamais rien transporter.
    assert.equal(moteur.path, '/@stuff006');
    assert.equal(moteur.network, 'ws');
    assert.equal(moteur.tls, true);
    assert.equal(moteur.fingerprint, 'chrome');
    // `insecure=0` NE DOIT PAS désactiver la vérification du certificat.
    assert.equal(moteur.insecure, false);
    // uTLS « chrome » annonce h2 en premier ; le WebSocket de sing-box parle
    // HTTP/1.1 Upgrade. Sans cet ALPN, le TLS aboutit et rien ne passe.
    assert.equal(moteur.alpn, 'http/1.1');
  });

  it('n’envoie jamais « encryption » au moteur, qui le refuse', () => {
    for (const uri of Object.values(URIS)) {
      const { canonical } = parseImportedConfig(uri);
      assert.equal(
        'encryption' in engineConfigFromCanonical(canonical), false,
        'sing-box refuse « encryption » sur un outbound VLESS',
      );
    }
  });

  it('le code natif retire lui-même « encryption », ce qui justifie la tolérance', () => {
    // Sans cette retenue, la divergence tolérée plus haut deviendrait réelle :
    // l'application enverrait au moteur un champ qu'il rejette.
    const natif = readFileSync(
      path.join(ROOT, 'app-mobile/modules/android-native/SxbVpnService.kt'), 'utf8',
    );
    assert.match(natif, /equals\("vless", ignoreCase = true\) && outbound\.has\("encryption"\)/);
    assert.match(natif, /outbound\.remove\("encryption"\)/);
  });
});

describe('une liste d’URI — un abonnement en porte plusieurs', () => {
  const LISTE = `${URIS['façade ws+tls — trois adresses distinctes']}\n`
    + `${URIS['ws+tls sans sni — l’adresse jointe est présentée']}\n`
    + `${URIS['ALPN imposé par la façade']}`;

  it('importe le premier profil et signale les autres sans les perdre', () => {
    const resultat = parseImportedConfig(LISTE);
    assert.equal(resultat.ok, true, resultat.errors.join(' | '));
    // Le propriétaire doit savoir que sa liste en contenait davantage ; un
    // import silencieux du premier seul lui ferait croire à une perte.
    assert.ok(
      resultat.warnings.some(a => /2 autres configurations/.test(a)),
      `avertissement de liste absent — ${JSON.stringify(resultat.warnings)}`,
    );
    assert.equal(resultat.canonical.host, 'crashlyticsreports-pa.googleapis.com');
  });

  it('chaque profil de la liste reste lisible à l’identique par l’application', () => {
    const lignes = LISTE.split('\n');
    for (const ligne of lignes) {
      const serveur = parseImportedConfig(ligne);
      const { config: application } = parseVlessUri(ligne);
      assert.equal(serveur.ok, true, serveur.errors.join(' | '));
      for (const champ of ['host', 'port', 'uuid', 'network', 'tls', 'path', 'wsHost', 'sni']) {
        assert.deepEqual(
          serveur.canonical[champ], application[champ],
          `champ « ${champ} » divergent sur une ligne de la liste`,
        );
      }
    }
  });
});

describe("miroir `backend/` — les trois règles de transport ne doivent pas re-diverger", () => {
  // ── PORTÉE DE CE BLOC, explicitement ────────────────────────────────────
  //
  // `backend/server/services/canonical-config.ts` accuse plusieurs centaines
  // de lignes de retard sur la racine. Ce bloc NE PRÉTEND PAS à la parité
  // générale — l'affirmer serait faux, et un test qui ment est pire qu'un
  // test absent.
  //
  // Il épingle exactement les TROIS règles dont l'absence rend un tunnel muet
  // sans le moindre message : l'alias `network=`, l'ALPN déduit, et le nom TLS
  // par défaut. Le miroir est atteignable — `cd backend && npm run dev` sert
  // `backend/server.ts`, qui monte ces routes-là.
  const CHEMIN_MIROIR = path.join(ROOT, 'backend/server/services/canonical-config.ts');
  const BASE = 'vless://11111111-2222-3333-4444-555555555555@';

  it("lit `network=` comme `type=`, et en déduit l'ALPN, exactement comme la racine", async () => {
    const miroir = await import(pathToFileURL(CHEMIN_MIROIR).href);
    const uri = `${BASE}exemple.test:443?security=tls&network=ws&host=facade.test&path=%2Fws&fp=chrome#miroir`;

    const racine = parseImportedConfig(uri);
    const copie = miroir.parseImportedConfig(uri);

    assert.equal(racine.ok, true, racine.errors.join(' | '));
    assert.equal(copie.ok, true, copie.errors.join(' | '));
    // Le défaut se lisait ICI : `network=undefined` avec `ok=true, errors=[]`.
    assert.equal(copie.canonical.network, 'ws');
    for (const champ of ['network', 'alpn', 'sni', 'wsHost', 'path', 'tls']) {
      assert.deepEqual(
        copie.canonical[champ], racine.canonical[champ],
        `champ « ${champ} » divergent entre la racine et le miroir`,
      );
    }
  });

  it("déduit le même nom TLS qu'à la racine, y compris sur une adresse littérale", async () => {
    const miroir = await import(pathToFileURL(CHEMIN_MIROIR).href);
    for (const [etiquette, uri] of [
      ['domaine sans sni', `${BASE}exemple.test:443?security=tls&type=ws&host=facade.test&path=%2Fws#a`],
      ['IP littérale', `${BASE}203.0.113.7:443?security=tls&type=ws&host=facade.test&path=%2Fws#b`],
      ['sni explicite', `${BASE}203.0.113.7:443?security=tls&type=ws&host=facade.test&sni=choisi.test&path=%2Fws#c`],
    ]) {
      const racine = parseImportedConfig(uri);
      const copie = miroir.parseImportedConfig(uri);
      assert.equal(copie.ok, true, `${etiquette} : ${copie.errors.join(' | ')}`);
      assert.equal(
        copie.canonical.sni, racine.canonical.sni,
        `nom TLS divergent entre la racine et le miroir — ${etiquette}`,
      );
    }
  });

  it("CE QUE CE BLOC NE DIT PAS — le retard du miroir est mesuré, pas masqué", () => {
    // Si cet écart se referme un jour, c'est que quelqu'un a réellement
    // réaligné les deux arbres ; il faudra alors remplacer ce bloc par une
    // vraie parité. Tant qu'il est grand, personne ne peut lire les tests
    // ci-dessus comme une garantie générale.
    const racine = readFileSync(path.join(ROOT, 'server/services/canonical-config.ts'), 'utf8').split('\n').length;
    const copie = readFileSync(CHEMIN_MIROIR, 'utf8').split('\n').length;
    assert.ok(racine > copie, 'le miroir est censé être en retard, pas en avance');
    assert.ok(
      racine - copie > 100,
      `retard mesuré de ${racine - copie} lignes : si l'écart s'est refermé, remplacer ce bloc par une vraie parité`,
    );
  });
});

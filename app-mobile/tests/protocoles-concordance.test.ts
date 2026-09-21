/**
 * Les trois listes de protocoles disent-elles la même chose ?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE PROBLÈME QU'ILS PRÉVIENNENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Un protocole doit franchir trois portes avant d'atteindre un tunnel :
 *
 *   1. `SupportedProtocol`  (services/configValidator)  — ce que l'app valide
 *   2. `VpnProtocolType`    (modules/expo-sxb-vpn)      — ce que le pont type
 *   3. `when (proto)`       (SxbVpnService.kt)          — ce que le moteur sait faire
 *
 * Les trois vivent dans trois fichiers, deux langages et deux processus. Rien
 * ne les oblige à rester d'accord, et une divergence ne se voit pas :
 *
 *   - présent côté app, absent côté moteur → `CONFIG_UNSUPPORTED` à l'exécution,
 *     après que l'utilisateur a cru sa configuration acceptée ;
 *   - présent côté moteur, absent du type  → un profil parfaitement valide est
 *     refusé à la compilation, et l'on conclut que le moteur ne sait pas faire.
 *
 * Ces contrôles ne devinent rien : ils relisent les trois sources.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QU'ILS N'EXIGENT PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * Le moteur accepte aussi les variantes de saisie (`ssh+tls`, `ssh+slowdns`,
 * `ssh+http-connect`…). Elles ne figurent volontairement dans aucun des deux
 * types TypeScript : `configValidator` les ramène à `ssh` ou `ssh+payload`
 * avant l'envoi. Exiger leur présence reviendrait à réclamer une redondance
 * que le code a justement supprimée.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const racine = path.resolve(__dirname, '..');

/** Relève les valeurs d'une union TypeScript `type X = | 'a' | 'b';`. */
function unionTypeScript(source: string, nom: string): string[] {
  const debut = source.indexOf(`export type ${nom} =`);
  assert.ok(debut > 0, `type ${nom} introuvable`);

  const fin = source.indexOf(';', debut);
  assert.ok(fin > debut, `fin du type ${nom} introuvable`);

  return [...source.slice(debut, fin).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const validateur = readFileSync(path.join(racine, 'services', 'configValidator.ts'), 'utf8');
const pont = readFileSync(
  path.join(racine, 'modules', 'expo-sxb-vpn', 'src', 'SxbVpn.types.ts'),
  'utf8',
);
const service = readFileSync(
  path.join(racine, 'modules', 'android-native', 'SxbVpnService.kt'),
  'utf8',
);

const cotéApp = unionTypeScript(validateur, 'SupportedProtocol');
const cotéPont = unionTypeScript(pont, 'VpnProtocolType');

/** Le vocabulaire réellement accepté par le répartiteur du service natif. */
function vocabulaireDuMoteur(): string[] {
  const debut = service.indexOf('when (proto) {');
  assert.ok(debut > 0, 'répartiteur `when (proto)` introuvable dans SxbVpnService');

  const fin = service.indexOf('else ->', debut);
  assert.ok(fin > debut, 'branche `else` du répartiteur introuvable');

  return [...service.slice(debut, fin).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('protocoles — les deux types TypeScript concordent', () => {
  it('le relevé a bien trouvé des valeurs des deux côtés', () => {
    assert.ok(cotéApp.length >= 9, `SupportedProtocol : ${cotéApp.length} valeurs relevées`);
    assert.ok(cotéPont.length >= 9, `VpnProtocolType : ${cotéPont.length} valeurs relevées`);
  });

  it('aucun protocole validé par l’app n’est refusé par le type du pont', () => {
    const manquants = cotéApp.filter((p) => !cotéPont.includes(p));
    assert.deepEqual(
      manquants,
      [],
      `VpnProtocolType ignore : ${manquants.join(', ')} — un profil valide serait refusé`,
    );
  });

  it('aucun protocole typé par le pont n’est inconnu du validateur', () => {
    const inconnus = cotéPont.filter((p) => !cotéApp.includes(p));
    assert.deepEqual(
      inconnus,
      [],
      `SupportedProtocol ignore : ${inconnus.join(', ')} — le type promet plus que l’app ne valide`,
    );
  });
});

describe('protocoles — le moteur natif sait faire ce que l’app annonce', () => {
  const moteur = vocabulaireDuMoteur();

  it('le relevé du répartiteur natif a trouvé un vocabulaire plausible', () => {
    assert.ok(moteur.length >= 15, `seulement ${moteur.length} protocoles relevés dans le natif`);
    assert.ok(moteur.includes('ssh'), 'le relevé ne contient même pas « ssh »');
  });

  it('chaque protocole validé par l’app est dispatché par le moteur', () => {
    const orphelins = cotéApp.filter((p) => !moteur.includes(p));
    assert.deepEqual(
      orphelins,
      [],
      `le moteur répondrait CONFIG_UNSUPPORTED pour : ${orphelins.join(', ')}`,
    );
  });

  it('les variantes de saisie restent connues du moteur, même absentes des types', () => {
    // Elles ne transitent pas telles quelles — `configValidator` les normalise.
    // Mais un profil importé brut peut encore les porter : le moteur doit
    // continuer de les reconnaître plutôt que de les rejeter.
    for (const variante of ['ssh+tls', 'ssh+slowdns', 'ssh+http-connect', 'ssh+udp']) {
      assert.ok(moteur.includes(variante), `le moteur ne reconnaît plus « ${variante} »`);
    }
  });

  it('le validateur ramène bien ces variantes au vocabulaire normalisé', () => {
    for (const variante of ['ssh+tls', 'ssh+slowdns', 'ssh+http-connect', 'ssh+udp']) {
      assert.ok(
        validateur.includes(`'${variante}'`),
        `configValidator ne sait plus normaliser « ${variante} »`,
      );
    }
  });
});

/**
 * journal-partage.test.ts — Le journal se chronomètre, et se partage sans fuir.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUI A MOTIVÉ CE FICHIER
 * ═══════════════════════════════════════════════════════════════════════════
 * La première version prenait l'étape précédente à `liste[index - 1]`. Mais le
 * journal s'affiche du PLUS RÉCENT au plus ancien : ce voisin est l'étape
 * SUIVANTE. La soustraction devenait négative, le seuil de bruit l'écartait,
 * et plus AUCUNE durée ne s'affichait — la fonctionnalité était morte en
 * silence, sans erreur ni écran cassé.
 *
 * Un contrôle qui lit le code source n'aurait rien vu : le code compilait et
 * se lisait bien. Ces contrôles EXÉCUTENT donc la logique sur des étapes
 * fabriquées, et comparent ce qui sort.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA GARANTIE QUI NE DOIT PAS BOUGER
 * ═══════════════════════════════════════════════════════════════════════════
 * Le texte partagé est reconstruit depuis les MÊMES clés de traduction que
 * l'écran. Il ne peut donc contenir ni plus ni autre chose que ce qui est
 * affiché — la confidentialité tient par construction, pas par vigilance.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { chronometrer, ecart, heure } from '../services/journalChronologie';

const RACINE = path.resolve(__dirname, '..');
const JOURNAL = readFileSync(path.join(RACINE, 'app/journal.tsx'), 'utf8');

/** Une connexion lente : trois étapes, dont une qui coûte 47 secondes. */
const CONNEXION_LENTE = [
  { key: 'prepare', timestamp: '2026-01-05T10:00:00.000Z' },
  { key: 'resolve', timestamp: '2026-01-05T10:00:00.400Z' },
  { key: 'handshake', timestamp: '2026-01-05T10:00:47.400Z' },
];

/** Telle que l'écran la présente : la plus récente en tête. */
const AFFICHEE = [...CONNEXION_LENTE].reverse();

describe('chronométrage — désigner l’étape coûteuse', () => {
  it('attribue la durée à l’étape qui l’a réellement consommée', () => {
    const resultat = chronometrer(AFFICHEE);

    // La poignée de main est en tête (la plus récente) et porte les 47 s.
    assert.equal(resultat[0].etape.key, 'handshake');
    assert.equal(resultat[0].duree, '+47.0 s');

    // La résolution n'a coûté que 400 ms.
    assert.equal(resultat[1].etape.key, 'resolve');
    assert.equal(resultat[1].duree, '+400 ms');
  });

  it('n’invente pas de durée pour la toute première étape', () => {
    const resultat = chronometrer(AFFICHEE);
    const premiere = resultat[resultat.length - 1];
    assert.equal(premiere.etape.key, 'prepare');
    assert.equal(premiere.duree, null, 'rien ne précède la première étape');
  });

  it('conserve l’ordre reçu pour que l’écran n’ait rien à réordonner', () => {
    const resultat = chronometrer(AFFICHEE);
    assert.deepEqual(
      resultat.map((ligne) => ligne.etape.key),
      AFFICHEE.map((etape) => etape.key),
    );
  });

  it('signale l’étape qui explique l’attente, et elle seule', () => {
    const resultat = chronometrer(AFFICHEE);
    // 47 s : c'est celle-là qu'on cherche.
    assert.equal(resultat[0].lent, true, 'la poignée de main de 47 s doit ressortir');
    // 400 ms : normale, elle ne doit pas crier.
    assert.equal(resultat[1].lent, false, '400 ms ne sont pas une lenteur');
    // Sans mesure, aucune alarme.
    assert.equal(resultat[2].lent, false, 'une étape sans précédent ne peut pas être lente');
  });

  it('place le seuil de lenteur à trois secondes', () => {
    const presque = chronometrer([
      { key: 'b', timestamp: '2026-01-05T10:00:02.900Z' },
      { key: 'a', timestamp: '2026-01-05T10:00:00.000Z' },
    ]);
    assert.equal(presque[0].lent, false, '2,9 s reste acceptable');

    const franchi = chronometrer([
      { key: 'b', timestamp: '2026-01-05T10:00:03.000Z' },
      { key: 'a', timestamp: '2026-01-05T10:00:00.000Z' },
    ]);
    assert.equal(franchi[0].lent, true, '3 s doivent alerter');
  });

  it('tait les étapes instantanées plutôt que d’encombrer chaque ligne', () => {
    assert.equal(ecart('2026-01-05T10:00:00.050Z', '2026-01-05T10:00:00.000Z'), null);
    assert.equal(ecart('2026-01-05T10:00:00.150Z', '2026-01-05T10:00:00.000Z'), '+150 ms');
  });

  it('ne rend jamais une durée négative ou illisible', () => {
    // Une horloge qui recule, ou des étapes mal ordonnées : rien plutôt qu’un « -3 s ».
    assert.equal(ecart('2026-01-05T10:00:00.000Z', '2026-01-05T10:00:03.000Z'), null);
    assert.equal(ecart('pas une date', '2026-01-05T10:00:00.000Z'), null);
    assert.equal(ecart(undefined, '2026-01-05T10:00:00.000Z'), null);
  });

  it('montre une heure lisible, jamais un horodatage machine', () => {
    const lisible = heure('2026-01-05T10:00:00.000Z');
    assert.ok(lisible && !lisible.includes('T'), `« ${lisible} » reste un horodatage brut`);
    assert.equal(heure(undefined), null);
    // Un horodatage étrange vaut mieux affiché que masqué pendant un diagnostic.
    assert.equal(heure('inattendu'), 'inattendu');
  });

  it('est bien ce que l’écran utilise — pas une copie qui divergera', () => {
    assert.match(JOURNAL, /import \{ chronometrer \} from "@\/services\/journalChronologie"/);
    assert.match(JOURNAL, /chronometrer\(\[\.\.\.stepLogs\]\.reverse\(\)\)/);
    assert.ok(
      !/function ecart\(/.test(JOURNAL),
      'l’écran ne doit pas garder sa propre copie du calcul',
    );
  });

  it('donne à l’étape lente un traitement visuel distinct', () => {
    // Sans cela, la durée se noie parmi les codes de diagnostic, tous rendus
    // dans la même pastille grise — l'information la plus utile de l'écran
    // devient la plus difficile à repérer.
    assert.match(JOURNAL, /lent\s*\n?\s*\? \{ backgroundColor: colors\.warningDim/);
    assert.match(JOURNAL, /color=\{colors\.warning\}/);
    // Une pastille avec icône ET texte doit être disposée en ligne.
    assert.match(JOURNAL, /codePill: \{\s*\n\s*flexDirection: "row"/);
  });
});

describe('partage — sortir le diagnostic du téléphone sans rien divulguer', () => {
  const partage = JOURNAL.slice(
    JOURNAL.indexOf('const partager'),
    JOURNAL.indexOf('}, [etapes, t]);'),
  );

  it('ne peut contenir que ce que l’écran affiche', () => {
    assert.ok(partage.length > 0, 'la fonction de partage doit exister');

    // Le texte vient des CLÉS de traduction, pas d'une source libre : c'est ce
    // qui rend la fuite impossible plutôt qu'improbable.
    assert.match(partage, /t\(etape\.translationKey as any\)/);
    // Et des seuls champs déjà rendus : heure, faits du moteur, durée, code.
    assert.match(
      partage,
      /\[heure, t\(etape\.translationKey as any\), \.\.\.\(etape\.technique \?\? \[\]\), duree, detailAffichable\(etape\.detail\)\]/,
    );

    for (const interdit of ['config', 'host', 'server', 'uuid', 'password', 'token', 'payload', 'sni']) {
      assert.ok(
        !new RegExp(`\\b${interdit}\\b`, 'i').test(partage),
        `le partage ne doit jamais toucher « ${interdit} »`,
      );
    }
  });

  it('remet la chronologie à l’endroit et n’échoue jamais bruyamment', () => {
    // L'écran liste du plus récent au plus ancien ; une chronologie se lit
    // dans l'autre sens.
    assert.match(partage, /\[\.\.\.etapes\]\.reverse\(\)/);
    // Un partage annulé par l'utilisateur n'est pas une erreur à lui montrer.
    assert.match(partage, /catch \{/);
  });

  it('propose le bouton dans les deux langues', () => {
    for (const langue of ['fr', 'en']) {
      const libelles = readFileSync(path.join(RACINE, `localization/${langue}.ts`), 'utf8');
      assert.match(libelles, /journal_share:/, `libellé manquant en ${langue}`);
    }
  });
});

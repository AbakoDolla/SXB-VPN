/**
 * Ce que le journal montre — et ce qu'il refuse de montrer.
 *
 * Ces contrôles portent sur `journalFiltres`, le module qui décide quelles
 * étapes atteignent l'écran. Ils vérifient trois choses :
 *
 *   1. que « Problèmes » ne laisse jamais filer un échec ;
 *   2. que « Réussites » ne promeut pas une étape encore en cours ;
 *   3. que la frontière application / moteur repose sur la convention
 *      réellement posée par VpnContext, et non sur une liste écrite à la main.
 *
 * Le troisième point est le plus important. Si `inscrireFaitMoteur` changeait
 * de préfixe, le filtre « Moteur » se viderait sans bruit et l'utilisateur
 * conclurait que le moteur n'a rien dit — alors qu'il aurait tout dit.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  PREFIXE_MOTEUR,
  retenue,
  vientDuMoteur,
  type EtapeFiltrable,
  type Niveau,
  type Source,
} from '../services/journalFiltres';

const racine = path.resolve(__dirname, '..');

function etape(key: string, status: EtapeFiltrable['status']): EtapeFiltrable {
  return { key, status };
}

/** Un échantillon qui ressemble à une vraie session : app + moteur, tous états. */
const CHRONOLOGIE: EtapeFiltrable[] = [
  etape('profile_loaded', 'done'),
  etape('permission', 'done'),
  etape('moteur:LIBBOX_STARTED', 'done'),
  etape('moteur:SSH_HANDSHAKE_START', 'active'),
  etape('moteur:SSH_AUTH_FAILED', 'error'),
  etape('moteur:CONNECTED_PRESUMED', 'warning'),
  etape('handshake', 'pending'),
];

function filtrer(niveau: Niveau, source: Source): string[] {
  return CHRONOLOGIE.filter((e) => retenue(e, niveau, source)).map((e) => e.key);
}

describe('journalFiltres — le niveau', () => {
  it('« tout » ne retire rien', () => {
    assert.equal(filtrer('tout', 'tout').length, CHRONOLOGIE.length);
  });

  it('« problèmes » garde les échecs ET les avertissements', () => {
    assert.deepEqual(filtrer('probleme', 'tout'), [
      'moteur:SSH_AUTH_FAILED',
      'moteur:CONNECTED_PRESUMED',
    ]);
  });

  it('« problèmes » ne laisse passer aucune étape réussie ou en attente', () => {
    for (const cle of filtrer('probleme', 'tout')) {
      const trouvee = CHRONOLOGIE.find((e) => e.key === cle);
      assert.ok(trouvee && (trouvee.status === 'error' || trouvee.status === 'warning'));
    }
  });

  it('« réussites » refuse une étape encore en cours', () => {
    const gardees = filtrer('reussite', 'tout');
    assert.ok(!gardees.includes('moteur:SSH_HANDSHAKE_START'), 'active n’est pas une réussite');
    assert.ok(!gardees.includes('handshake'), 'pending n’est pas une réussite');
  });

  it('« réussites » ne garde que les étapes terminées', () => {
    assert.deepEqual(filtrer('reussite', 'tout'), [
      'profile_loaded',
      'permission',
      'moteur:LIBBOX_STARTED',
    ]);
  });
});

describe('journalFiltres — la source', () => {
  it('« moteur » ne garde que les étapes préfixées', () => {
    for (const cle of filtrer('tout', 'moteur')) {
      assert.ok(cle.startsWith(PREFIXE_MOTEUR), `${cle} n’est pas une trace du moteur`);
    }
  });

  it('« application » ne garde aucune étape du moteur', () => {
    assert.deepEqual(filtrer('tout', 'application'), ['profile_loaded', 'permission', 'handshake']);
  });

  it('les deux sources réunies redonnent la chronologie entière', () => {
    const reunion = [...filtrer('tout', 'application'), ...filtrer('tout', 'moteur')];
    assert.equal(reunion.length, CHRONOLOGIE.length);
  });

  it('vientDuMoteur ne se laisse pas tromper par un préfixe au milieu de la clé', () => {
    assert.equal(vientDuMoteur(etape('relais moteur:X', 'done')), false);
  });
});

describe('journalFiltres — les filtres se combinent', () => {
  it('« problèmes » + « moteur » isole la panne du tunnel', () => {
    assert.deepEqual(filtrer('probleme', 'moteur'), [
      'moteur:SSH_AUTH_FAILED',
      'moteur:CONNECTED_PRESUMED',
    ]);
  });

  it('une combinaison sans résultat renvoie une liste vide, pas une erreur', () => {
    assert.deepEqual(filtrer('probleme', 'application'), []);
  });
});

describe('journalFiltres — la convention `moteur:` est celle de VpnContext', () => {
  /**
   * Le contrôle décisif. `inscrireFaitMoteur` est le seul endroit qui compose
   * la clé d'une étape du moteur. Si son préfixe changeait sans que ce module
   * suive, le filtre « Moteur » deviendrait vide en silence.
   */
  it('inscrireFaitMoteur préfixe bien ses clés avec PREFIXE_MOTEUR', () => {
    const source = readFileSync(path.join(racine, 'contexts', 'VpnContext.tsx'), 'utf8');
    const debut = source.indexOf('const inscrireFaitMoteur');
    assert.ok(debut > 0, 'inscrireFaitMoteur introuvable dans VpnContext');

    const corps = source.slice(debut, debut + 2000);
    assert.ok(
      corps.includes(`\`${PREFIXE_MOTEUR}`) || corps.includes(`"${PREFIXE_MOTEUR}`),
      `inscrireFaitMoteur n’utilise plus le préfixe « ${PREFIXE_MOTEUR} »`,
    );
  });

  it('l’écran du journal n’a pas gardé sa propre copie du filtrage', () => {
    const ecran = readFileSync(path.join(racine, 'app', 'journal.tsx'), 'utf8');
    assert.ok(
      ecran.includes('from "@/services/journalFiltres"'),
      'journal.tsx doit importer le filtrage plutôt que le réécrire',
    );
    assert.doesNotMatch(
      ecran,
      /function\s+retenue/,
      'le filtrage ne doit exister qu’à un seul endroit',
    );
  });
});

describe('journal — ce que l’écran promet à l’utilisateur', () => {
  const ecran = readFileSync(path.join(racine, 'app', 'journal.tsx'), 'utf8');

  it('le partage exporte ce qui est affiché, filtres compris', () => {
    const debut = ecran.indexOf('const partager');
    const fin = ecran.indexOf('}, [etapes, t]);', debut);
    assert.ok(debut > 0 && fin > debut, 'la fonction de partage est introuvable');

    const corps = ecran.slice(debut, fin);
    assert.ok(
      corps.includes('etapes'),
      'le partage doit reprendre la liste filtrée, pas la liste brute',
    );
    assert.ok(
      !corps.includes('toutes'),
      'le partage ne doit pas contourner les filtres en repartant de la liste brute',
    );
  });

  it('le gel n’efface rien : il cesse seulement de rafraîchir', () => {
    const debut = ecran.indexOf('const basculerGel');
    assert.ok(debut > 0, 'basculerGel introuvable');

    const corps = ecran.slice(debut, debut + 400);
    assert.ok(
      !corps.includes('resetStepLogs'),
      'figer l’affichage ne doit jamais effacer les étapes',
    );
  });

  it('l’effacement demande confirmation avant de perdre la chronologie', () => {
    const debut = ecran.indexOf('const effacer');
    assert.ok(debut > 0, 'effacer introuvable');

    const corps = ecran.slice(debut, debut + 900);
    assert.ok(corps.includes('Alert.alert'), 'l’effacement doit être confirmé');
    assert.ok(
      corps.includes('journal_clear_confirm'),
      'la confirmation doit expliquer ce qui sera perdu',
    );
  });

  it('un journal vidé par les filtres ne se confond pas avec un journal réellement vide', () => {
    assert.ok(
      ecran.includes('journal_filtered_title'),
      'l’état « masqué par les filtres » doit avoir son propre message',
    );
    assert.ok(
      ecran.includes('journal_empty_title'),
      'l’état « rien à montrer » doit rester distinct',
    );
  });
});

describe('journal — les libellés existent dans les deux langues', () => {
  const fr = readFileSync(path.join(racine, 'localization', 'fr.ts'), 'utf8');
  const en = readFileSync(path.join(racine, 'localization', 'en.ts'), 'utf8');
  const ecran = readFileSync(path.join(racine, 'app', 'journal.tsx'), 'utf8');

  it('chaque clé t("journal_…") demandée par l’écran est traduite', () => {
    const demandees = new Set(
      [...ecran.matchAll(/t\("(journal_[a-z_]+)"\)/g)].map((m) => m[1]),
    );
    assert.ok(demandees.size >= 10, 'trop peu de clés repérées, le relevé a dû échouer');

    for (const cle of demandees) {
      assert.ok(fr.includes(`${cle}:`), `« ${cle} » manque en français`);
      assert.ok(en.includes(`${cle}:`), `« ${cle} » manque en anglais`);
    }
  });

  it('le compteur d’étapes masquées garde son emplacement de valeur', () => {
    for (const [langue, source] of [
      ['fr', fr],
      ['en', en],
    ] as const) {
      const ligne = source.split('\n').find((l) => l.includes('journal_hidden_count:'));
      assert.ok(ligne, `journal_hidden_count absent de ${langue}.ts`);
      assert.ok(ligne.includes('{n}'), `journal_hidden_count sans « {n} » dans ${langue}.ts`);
    }
  });
});

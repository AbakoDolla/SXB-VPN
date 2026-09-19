/**
 * arret-explique.test.ts — Un tunnel ne doit jamais tomber sans un mot.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA PLAINTE QUI A MOTIVÉ CE FICHIER
 * ═══════════════════════════════════════════════════════════════════════════
 * « J'appuie pour me connecter, ça se déconnecte tout seul et je ne sais pas
 * pourquoi, en affichant un changer de configuration. »
 *
 * Le mécanisme était celui-ci : dès que le moteur annonce `handshaking`,
 * l'application vérifie l'accès. Si le profil en cours porte la moindre
 * restriction, elle appelle `stopForAccess()` — qui coupait le tunnel SANS
 * UN MOT. Ni message, ni entrée au journal. Le bouton passait ensuite en
 * « bloqué », et appuyer sur un bouton bloqué ouvre le sélecteur de
 * configuration : d'où l'impression d'un caprice.
 *
 * Constaté en production : 5 appareils actifs ne portaient AUCUN forfait tout
 * en gardant des configurations en mémoire. `reduceSnapshot` marque `deleted`
 * tout profil absent de l'inventaire — c'est exactement ce cas.
 *
 * Deux garanties à tenir désormais :
 *   1. tout arrêt d'accès nomme sa cause ;
 *   2. quand une autre configuration est VRAIMENT utilisable, l'application
 *      la propose en un geste — et se tait quand aucune ne convient.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RACINE = path.resolve(__dirname, '..');
const CONTEXTE = readFileSync(path.join(RACINE, 'contexts/VpnContext.tsx'), 'utf8');
const ACCUEIL = readFileSync(path.join(RACINE, 'app/(tabs)/index.tsx'), 'utf8');

describe('l’arrêt d’accès nomme toujours sa cause', () => {
  it('chaque motif a une phrase, dans les deux langues', () => {
    const motifs = [
      'stop_profil_retire',
      'stop_profil_suspendu',
      'stop_profil_expire',
      'stop_profil_revoque',
      'stop_appareil_bloque',
      'stop_quota_epuise',
    ];
    for (const langue of ['fr', 'en']) {
      const libelles = readFileSync(path.join(RACINE, `localization/${langue}.ts`), 'utf8');
      for (const motif of motifs) {
        assert.match(libelles, new RegExp(`${motif}:`), `${motif} manquant en ${langue}`);
      }
    }
  });

  it('l’arrêt écrit au journal ET au log', () => {
    assert.match(CONTEXTE, /addLog\(`⛔ \$\{t\(cle as any\)\}`\)/);
    assert.match(CONTEXTE, /addStepLog\('acces', cle, 'error'\)/);
  });

  it('aucun appel d’arrêt d’accès ne reste muet', () => {
    // Les trois chemins qui coupent pour cause d'accès doivent passer un motif.
    const appels = CONTEXTE.match(/stopForAccess(?:Ref\.current\?\.)?\(([^)]*)\)/g) || [];
    const muets = appels.filter((a) => /\(\s*\)$/.test(a));
    assert.deepEqual(muets, [], `appels sans motif : ${muets.join(', ')}`);
    assert.ok(appels.length >= 3, `seulement ${appels.length} appel(s) trouvé(s)`);
  });

  it('le motif se déduit de l’état réel de la restriction', () => {
    assert.match(CONTEXTE, /function motifPourRestriction\(statut: string \| undefined\)/);
    for (const [etat, motif] of [
      ['suspended', 'profil_suspendu'],
      ['expired', 'profil_expire'],
      ['revoked', 'profil_revoque'],
      ['exhausted', 'quota_epuise'],
    ]) {
      assert.match(CONTEXTE, new RegExp(`case '${etat}':\\s*return '${motif}';`), `${etat} mal traduit`);
    }
    // Le cas le plus courant — le forfait a disparu de l'inventaire.
    assert.match(CONTEXTE, /default:\s*return 'profil_retire';/);
  });

  it('le motif ne peut pas transporter de texte libre', () => {
    // Une liste fermée de mots, jamais une chaîne venue d'ailleurs.
    assert.match(CONTEXTE, /type MotifArretAcces =/);
    assert.match(CONTEXTE, /const CLE_MOTIF_ARRET: Record<MotifArretAcces, string>/);
  });
});

describe('changer de configuration doit mener quelque part', () => {
  it('une configuration de secours est cherchée parmi les valables', () => {
    assert.match(ACCUEIL, /const configDeSecours = useMemo\(/);
    assert.match(ACCUEIL, /!ETATS_BLOQUANTS\.has\(String\(c\.status \?\? 'active'\)\)/);
    // Jamais celle déjà active : basculer sur soi-même n'apprendrait rien.
    assert.match(ACCUEIL, /!c\.isActive/);
  });

  it('les états qui rendent une configuration inutile sont nommés', () => {
    for (const etat of ['deleted', 'revoked', 'suspended', 'expired', 'exhausted']) {
      assert.match(ACCUEIL, new RegExp(`'${etat}'`), `${etat} absent des états bloquants`);
    }
  });

  it('le bandeau ne paraît que s’il y a vraiment où aller', () => {
    // Deux conditions : un problème ET une issue. Sans l'une, rien ne s'affiche.
    assert.match(ACCUEIL, /revokedStatus !== 'none' && configDeSecours &&/);
    assert.match(ACCUEIL, /onPress=\{\(\) => void switchConfig\(configDeSecours\.id\)\}/);
  });

  it('le bandeau se nomme dans les deux langues', () => {
    for (const langue of ['fr', 'en']) {
      const libelles = readFileSync(path.join(RACINE, `localization/${langue}.ts`), 'utf8');
      assert.match(libelles, /switch_suggestion:/, `switch_suggestion manquant en ${langue}`);
      assert.match(libelles, /switch_action:/, `switch_action manquant en ${langue}`);
    }
  });
});

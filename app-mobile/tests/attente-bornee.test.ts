/**
 * attente-bornee.test.ts — Le tournis doit toujours s'arrêter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA PLAINTE QUI A MOTIVÉ CE FICHIER
 * ═══════════════════════════════════════════════════════════════════════════
 * « J'appuie encore sur charger et ça tourne indéfiniment. »
 *
 * L'accueil annonçait le rafraîchissement par un tournis, et attendait une
 * chaîne réseau que rien ne bornait : état d'accès 35 s, liste des connexions
 * 15 s, puis près de 46 s par configuration à provisionner (trois tentatives
 * de 15 s séparées de pauses). Avec deux configurations neuves, le bouton
 * restait désactivé plus de deux minutes, sans un mot.
 *
 * Ces contrôles EXÉCUTENT le butoir sur de vraies promesses et de vrais
 * minuteurs. Un contrôle qui se contenterait de relire le code ne verrait pas
 * la différence entre un butoir qui borne et un butoir qui laisse passer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { avecDelai, estLenteur, LENTEUR } from '../services/attenteBornee';

/** Une promesse qui n'aboutit jamais — ce que subissait l'utilisateur. */
const jamais = () => new Promise<never>(() => {});

const apres = <T>(ms: number, valeur: T) =>
  new Promise<T>((resoudre) => setTimeout(() => resoudre(valeur), ms));

describe('attente bornée — ce qui met fin au tournis', () => {
  it('rend la main quand le travail n’aboutit jamais', async () => {
    const debut = Date.now();
    await assert.rejects(() => avecDelai(jamais(), 60), (raison) => raison === LENTEUR);
    const ecoule = Date.now() - debut;
    assert.ok(ecoule < 1000, `l’attente a duré ${ecoule} ms — elle devait être bornée`);
  });

  it('laisse passer un travail qui finit à temps', async () => {
    assert.equal(await avecDelai(apres(10, 'fini'), 500), 'fini');
  });

  it('distingue « c’est long » de « c’est cassé »', async () => {
    // Confondre les deux ferait ressusciter une annonce déjà traitée au seul
    // motif que le réseau a pris son temps.
    const panne = new Error('réseau injoignable');
    await assert.rejects(
      () => avecDelai(Promise.reject(panne), 500),
      (raison) => raison === panne && !estLenteur(raison),
    );
    await assert.rejects(() => avecDelai(jamais(), 30), (raison) => estLenteur(raison));
  });

  it('ne prend pas un échec du travail pour une lenteur', () => {
    assert.equal(estLenteur(LENTEUR), true);
    for (const autre of [new Error('x'), 'lenteur', null, undefined, Symbol('lenteur')]) {
      assert.equal(estLenteur(autre), false, `« ${String(autre)} » n’est pas une lenteur`);
    }
  });

  it('désarme son minuteur même quand le travail gagne la course', async () => {
    // Sans ce désarmement, chaque rafraîchissement retiendrait un minuteur
    // jusqu'à son échéance — et sur Node, empêcherait le processus de sortir.
    const avant = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    await avecDelai(apres(5, 'fini'), 30_000);
    const apresCourse = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    assert.ok(
      apresCourse <= avant,
      `un minuteur est resté armé (${avant} → ${apresCourse})`,
    );
  });

  it('le travail poursuit sa route au-delà du délai', async () => {
    // On borne l'attente VISIBLE, pas le travail : annuler ferait perdre un
    // provisionnement déjà engagé, et l'utilisateur devrait tout recommencer.
    let acheve = false;
    const travail = apres(80, 'tardif').then((v) => { acheve = true; return v; });

    await assert.rejects(() => avecDelai(travail, 20), estLenteur);
    assert.equal(acheve, false, 'le travail ne doit pas être achevé au dépassement');

    assert.equal(await travail, 'tardif', 'le travail doit aboutir de lui-même');
    assert.equal(acheve, true);
  });
});

describe('l’écran d’accueil s’appuie bien sur ce butoir', () => {
  it('borne son rafraîchissement et sépare les trois issues', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const accueil = readFileSync(
      path.join(path.resolve(__dirname, '..'), 'app/(tabs)/index.tsx'),
      'utf8',
    );

    assert.match(accueil, /await avecDelai\(travail, DELAI_RAFRAICHISSEMENT_MS\)/);
    assert.match(accueil, /return estLenteur\(erreur\) \? 'lent' : 'echec';/);
    // Le tournis s'éteint quoi qu'il arrive.
    assert.match(accueil, /finally \{\s*\n\s*rafraichissementRef\.current = false;\s*\n\s*setIsRefreshing\(false\);/);
    // La garde tient par référence : deux appuis rapprochés lisent la même
    // valeur d'état et passeraient tous les deux.
    assert.match(accueil, /if \(rafraichissementRef\.current\) return 'lent';/);
  });

  it('mémorise AVANT de rafraîchir, et restaure sur échec seul', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const accueil = readFileSync(
      path.join(path.resolve(__dirname, '..'), 'app/(tabs)/index.tsx'),
      'utf8',
    );

    const geste = accueil.slice(
      accueil.indexOf('const chargerNouvellesConnexions'),
      accueil.indexOf('}, [nouvellesConnexions, handleRefresh]);'),
    );
    assert.ok(geste.length > 0, 'le geste « Charger » doit exister');

    // L'ordre est le correctif : la mémorisation précède le rafraîchissement.
    assert.ok(
      geste.indexOf('await memoriser(aTraiter)') < geste.indexOf('await handleRefresh()'),
      'memoriser doit précéder handleRefresh',
    );
    // Et seul un ÉCHEC rallume l'annonce — jamais une simple lenteur.
    assert.match(geste, /if \(issue === 'echec'\)/);
    assert.match(geste, /await oublier\(aTraiter\)/);
  });
});

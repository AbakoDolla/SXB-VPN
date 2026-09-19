/**
 * annonce-poussee.test.mjs — Une annonce ne doit pas mentir sur sa portée.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CES CONTRÔLES FIGENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Le serveur renvoie, à chaque publication, ce qu'il a fait de l'envoi :
 *
 *     { announcement: {…}, push: { status: "disabled", reason: "FCM_NOT_CONFIGURED" } }
 *
 * Le tableau de bord jetait ce compte rendu. L'exploitant publiait, ne voyait
 * aucune erreur, et en concluait que son annonce était arrivée sur tous les
 * téléphones.
 *
 * Mesuré en production avant correction : zéro destinataire sur TRENTE-HUIT
 * appareils enregistrés. Aucune annonce n'avait jamais été poussée, et rien
 * ne le disait — c'est la forme d'échec la plus coûteuse, parce qu'on continue
 * de s'appuyer dessus.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lire = (p) => readFileSync(path.join(RACINE, p), 'utf8');

const API = lire('artifacts/sxb-dashboard/src/api/announcements.ts');
const API_MAJ = lire('artifacts/sxb-dashboard/src/api/app-updates.ts');
const AVIS = lire('artifacts/sxb-dashboard/src/lib/avisPoussee.ts');
const VUE = lire('artifacts/sxb-dashboard/src/components/AnnouncementsView.tsx');
const VUE_MAJ = lire('artifacts/sxb-dashboard/src/components/AppUpdatesView.tsx');
const ROUTE = lire('server/routes/announcements.ts');

describe('le serveur rend compte de l’envoi', () => {
  it('la publication renvoie ce qu’elle a fait de la poussée', () => {
    // Sans ce champ, le tableau de bord n'a rien à afficher et devrait deviner.
    assert.match(ROUTE, /push/);
  });

  it('les mises à jour de l’app aussi', () => {
    assert.match(lire('server/routes/app-updates.ts'), /const push = await sendAppUpdatePush\(update\)/);
  });
});

describe('le tableau de bord ne jette plus ce compte rendu', () => {
  it('createAnnouncement remonte le résultat de l’envoi', () => {
    assert.match(API, /export interface ResultatPoussee/);

    const creation = API.slice(
      API.indexOf('export async function createAnnouncement'),
      API.indexOf('export async function updateAnnouncement'),
    );
    assert.ok(creation.length > 0, 'createAnnouncement doit exister');
    assert.match(creation, /return \{ announcement: data\.announcement, push: data\.push \};/);
    // L'ancienne écriture jetait tout sauf l'annonce. La mise à jour, elle,
    // n'envoie rien : elle a le droit de ne renvoyer que l'annonce.
    assert.ok(
      !/return data\.announcement;/.test(creation),
      'le compte rendu d’envoi ne doit plus être jeté',
    );
  });

  it('lit le champ que le SERVEUR écrit réellement', () => {
    // Défaut constaté en direct : le type nommait ce champ `reason`, alors que
    // le serveur écrit `error`. Les contrôles passaient — ils vérifiaient la
    // comparaison, pas le nom — et l'écran retombait sur le message générique
    // « L'envoi a échoué (disabled) », taisant justement la cause qu'on
    // voulait nommer. C'est le genre d'écart qu'une lecture du code ne montre
    // pas, et qu'un essai en conditions réelles révèle aussitôt.
    const service = lire('server/services/fcm.ts');
    assert.match(service, /error: "FCM_NOT_CONFIGURED"/, 'le serveur nomme ce champ « error »');
    assert.match(API, /error\?: string;/);
    assert.match(API, /return push\?\.error \?\? push\?\.reason;/);
  });

  it('les quatre états d’envoi du serveur sont connus du type', () => {
    for (const etat of ['sent', 'partial', 'failed', 'disabled', 'skipped']) {
      assert.match(API, new RegExp(`'${etat}'`), `état « ${etat} » absent du type`);
    }
  });
});

describe('ce que l’exploitant voit après avoir publié', () => {
  it('un envoi qui n’a pas eu lieu est ANNONCÉ, pas tu', () => {
    assert.match(VUE, /const \{ push \} = await createAnnouncement\(payload\);/);
    assert.match(VUE, /signalerPoussee\(push, t\)/);
    assert.match(AVIS, /if \(push\.status === 'sent'\)/);
    assert.match(AVIS, /toast\.warning\(t\('operations\.announcements\.pushNotDelivered'\)/);
  });

  it('les DEUX écrans qui publient disent la même chose', () => {
    // Écrire deux fois le même avis les ferait diverger — l'un finirait
    // corrigé et l'autre pas, comme cela s'est déjà produit côté Android avec
    // le canal de notification.
    assert.match(VUE, /import \{ signalerPoussee \} from '\.\.\/lib\/avisPoussee'/);
    assert.match(VUE_MAJ, /import \{ signalerPoussee \} from '\.\.\/lib\/avisPoussee'/);
    assert.match(VUE_MAJ, /signalerPoussee\(result\.push, t\)/);
    assert.match(API_MAJ, /push\?: ResultatPoussee;/);
  });

  it('l’avis est FUGACE, et non un bandeau qui reste', () => {
    // Une information juste devient un reproche si elle ne s'en va jamais :
    // le bandeau restait à l'écran jusqu'à la publication suivante, sans
    // moyen de l'écarter.
    assert.ok(!/avisPoussee &&/.test(VUE), 'plus aucun bandeau persistant');
    assert.ok(!/setAvisPoussee/.test(VUE), 'plus d’état retenu pour l’afficher');
    assert.match(AVIS, /toast\./);
  });

  it('ne rien affirmer quand le serveur ne dit rien', () => {
    // Un serveur antérieur à ce compte rendu n'en envoie pas : supposer une
    // réussite serait revenir au mensonge qu'on vient de corriger.
    assert.match(AVIS, /if \(!push\) return;/);
  });

  it('le cas « non configuré » est nommé, pas réduit à un code', () => {
    // « FCM_NOT_CONFIGURED » ne dit rien à un exploitant : il lui faut savoir
    // quoi faire, pas quel symbole le serveur a produit.
    assert.match(AVIS, /motif === 'FCM_NOT_CONFIGURED'/);
    assert.match(AVIS, /operations\.announcements\.pushNotConfigured/);
  });

  it('un envoi réussi dit COMBIEN d’appareils ont été touchés', () => {
    assert.match(AVIS, /operations\.announcements\.pushDelivered/);
    assert.match(AVIS, /count: String\(push\.sent \?\? 0\)/);
  });

  it('les libellés existent dans les deux langues', () => {
    for (const langue of ['fr', 'en']) {
      const libelles = JSON.parse(lire(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`));
      for (const cle of ['pushNotDelivered', 'pushNotConfigured', 'pushFailed', 'pushDelivered']) {
        assert.ok(
          typeof libelles.announcements?.[cle] === 'string' && libelles.announcements[cle].length > 0,
          `« ${cle} » manquant en ${langue}`,
        );
      }
    }
  });

  it('le message « non configuré » dit quoi faire', () => {
    // Un avertissement qui ne mène à aucune action est un bruit de plus.
    const fr = JSON.parse(lire('artifacts/sxb-dashboard/src/locales/fr/operations.json'));
    assert.match(fr.announcements.pushNotConfigured, /Firebase/);
    const en = JSON.parse(lire('artifacts/sxb-dashboard/src/locales/en/operations.json'));
    assert.match(en.announcements.pushNotConfigured, /Firebase/);
  });
});

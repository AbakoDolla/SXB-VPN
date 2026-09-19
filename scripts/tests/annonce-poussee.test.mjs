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
const VUE = lire('artifacts/sxb-dashboard/src/components/AnnouncementsView.tsx');
const ROUTE = lire('server/routes/announcements.ts');

describe('le serveur rend compte de l’envoi', () => {
  it('la publication renvoie ce qu’elle a fait de la poussée', () => {
    // Sans ce champ, le tableau de bord n'a rien à afficher et devrait deviner.
    assert.match(ROUTE, /push/);
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
    assert.match(VUE, /setAvisPoussee\(push \?\? null\)/);
    assert.match(VUE, /avisPoussee && avisPoussee\.status !== 'sent'/);
  });

  it('le cas « non configuré » est nommé, pas réduit à un code', () => {
    // « FCM_NOT_CONFIGURED » ne dit rien à un exploitant : il lui faut savoir
    // quoi faire, pas quel symbole le serveur a produit.
    assert.match(VUE, /motifPoussee\(avisPoussee\) === 'FCM_NOT_CONFIGURED'/);
    assert.match(VUE, /operations\.announcements\.pushNotConfigured/);
  });

  it('un envoi réussi dit COMBIEN d’appareils ont été touchés', () => {
    assert.match(VUE, /operations\.announcements\.pushDelivered/);
    assert.match(VUE, /count: String\(avisPoussee\.sent \?\? 0\)/);
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

  it('l’avertissement ne repose pas sur du gris sur fond coloré', () => {
    // Un texte gris sur un fond ambre se délave : l'avertissement le plus
    // important de cet écran serait le moins lisible.
    const bandeau = VUE.slice(VUE.indexOf('avisPoussee && avisPoussee.status !==', 0), VUE.indexOf('avisPoussee && avisPoussee.status === '));
    assert.ok(bandeau.length > 0);
    assert.ok(!/text-gray-/.test(bandeau), 'l’avertissement doit rester lisible');
  });
});

/**
 * Le taux d'utilisation compare des fiches comparables.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION
 * ──────────────────────────────
 * `/api/analytics/traffic` annonçait `utilizationPercentage: 744.68` — un taux
 * impossible, qui décrédibilise le tableau de bord auprès du client.
 *
 * Le dénominateur ne retenait que les fiches munies d'un quota (31 sur 309),
 * tandis que le numérateur additionnait la consommation des 309, y compris
 * celle des accès sans limite, qui n'ont aucun quota à saturer. Le facteur
 * variait dans le temps (13,4 puis 5,3 puis 7,4) : ni double comptage, ni
 * erreur d'unité — deux populations différentes.
 *
 * Ce banc exerce la vraie fonction, et reproduit d'abord la forme exacte du
 * parc observé pour vérifier que le taux absurde ne peut plus se produire.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { agregerTrafic, enGo, tauxUtilisation } = await import('../../server/services/trafic-agrege.ts');

const GO = BigInt(1024 * 1024 * 1024);

/** 31 fiches plafonnées à 20 Go, 278 sans plafond — la forme observée. */
function parcObserve() {
  const fiches = [];
  for (let i = 0; i < 31; i++) fiches.push({ quotaTotal: GO * BigInt(20), quotaUsed: GO * BigInt(12) });
  for (let i = 0; i < 278; i++) fiches.push({ quotaTotal: null, quotaUsed: GO * BigInt(9) });
  return fiches;
}

test('le parc réel ne produit plus de taux absurde', () => {
  const taux = tauxUtilisation(agregerTrafic(parcObserve()));
  assert.equal(taux, 60, '12 Go consommés sur 20 Go plafonnés = 60 %');
  assert.ok(taux <= 100, `taux impossible : ${taux}`);
});

test('la consommation hors quota ne disparaît pas du total', () => {
  // Fermer la fuite du taux ne doit pas escamoter du trafic réel.
  const a = agregerTrafic(parcObserve());
  assert.equal(a.consumedBytes, GO * BigInt(31 * 12 + 278 * 9));
  assert.equal(a.meteredConsumedBytes, GO * BigInt(31 * 12));
  assert.equal(a.meteredClients, 31);
});

test('une fiche sans plafond n’entre ni au numérateur ni au dénominateur', () => {
  const a = agregerTrafic([
    { quotaTotal: GO * BigInt(10), quotaUsed: GO * BigInt(5) },
    { quotaTotal: null, quotaUsed: GO * BigInt(500) },
  ]);
  assert.equal(tauxUtilisation(a), 50, 'les 500 Go sans plafond ne doivent pas gonfler le taux');
  assert.equal(enGo(a.consumedBytes), 505, 'ils restent néanmoins comptés dans le total');
});

test('un quota nul vaut « sans plafond », pas « plafond à zéro »', () => {
  // Sans ce garde, une fiche à quotaTotal = 0 provoquerait une division par
  // zéro ou un taux infini selon la branche.
  const a = agregerTrafic([{ quotaTotal: BigInt(0), quotaUsed: GO * BigInt(7) }]);
  assert.equal(a.meteredClients, 0);
  assert.equal(tauxUtilisation(a), 0);
  assert.equal(enGo(a.consumedBytes), 7);
});

test('un parc vide ne divise pas par zéro', () => {
  const a = agregerTrafic([]);
  assert.equal(tauxUtilisation(a), 0);
  assert.equal(a.consumedBytes, BigInt(0));
});

test('un vrai dépassement de quota reste visible', () => {
  // Le correctif ne doit pas plafonner artificiellement : un client qui dépasse
  // son forfait est une information commerciale utile.
  const a = agregerTrafic([{ quotaTotal: GO * BigInt(10), quotaUsed: GO * BigInt(13) }]);
  assert.equal(tauxUtilisation(a), 130);
});

test('la règle n’existe qu’en un exemplaire dans la route', () => {
  // Le défaut était présent DEUX fois — branche base de données et branche de
  // repli — parce que le calcul y était dupliqué.
  const racine = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = readFileSync(join(racine, 'server', 'routes', 'analytics.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(
    (source.match(/utilizationPercentage:\s*tauxUtilisation\(agrege\)/g) || []).length,
    2,
    'les deux branches doivent appeler le même point unique',
  );
  assert.ok(
    !/utilizationPercentage:\s*totalQuotaGb\s*>/.test(source),
    'le calcul en ligne a été réintroduit dans la route',
  );
});

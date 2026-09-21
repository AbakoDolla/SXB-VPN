/**
 * Provisionné et consommé doivent décrire la MÊME population.
 *
 * LE DÉFAUT MESURÉ EN PRODUCTION
 * ──────────────────────────────
 * `/api/dashboard/stats` annonçait :
 *
 *     consumedTraffic 1479,48 Gio   provisionedTraffic 280 Gio   remaining 0
 *
 * Le facteur a été relevé quatre fois : 13,4 puis 5,3 puis 7,4 puis 5,28. Une
 * erreur d'unité (Mo/Go, octets/Ko) donne un facteur CONSTANT ; un facteur
 * mobile désigne deux populations comptées différemment. Le tableau croisé des
 * 309 fiches de production l'a confirmé :
 *
 *   porte un quotaTotal ET un forfait :   4 fiches | 115 Gio |   0,6 Gio consommés
 *   porte un quotaTotal, sans forfait :  27 fiches | 165 Gio |   0   Gio consommés
 *   SANS quotaTotal, avec forfait     :  80 fiches |   0     | 760,14 Gio consommés
 *   SANS quotaTotal, sans forfait     : 198 fiches |   0     | 718,74 Gio consommés
 *
 * 100,0 % du numérateur venait de fiches dont `quotaTotal` vaut zéro, et les 31
 * fiches du dénominateur ne consommaient que 0,6 Gio à elles toutes. Le rapport
 * n'était pas faux d'un facteur : il n'avait aucune valeur définie.
 *
 * CE QUE CE BANC INTERDIT
 * ───────────────────────
 * Il ne constate pas le symptôme — un chiffre trop grand — car un chiffre
 * plausible peut cacher la même incohérence. Il interdit la CAUSE : que les
 * deux grandeurs cessent de porter sur les mêmes fiches.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  agregerQuotaClients,
  ficheTraficEffective,
  provenanceQuota,
  tauxUtilisation,
  SEUIL_FORFAIT_HORS_NORME,
} = await import('../../server/services/trafic-agrege.ts');

const GO = BigInt(1024 * 1024 * 1024);
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ─────────────────────────── L'invariant central ────────────────────────────

test("l'invariant : consommé et plafond sortent de la même source", () => {
  // Un client porteur des DEUX est le cas qui décide. S'il apportait son
  // quotaTotal au dénominateur et le quotaUsed de son forfait au numérateur,
  // les deux grandeurs recommenceraient à décrire des choses différentes.
  const fiche = ficheTraficEffective({
    status: 'active',
    quotaTotal: GO * BigInt(50),
    quotaUsed: GO * BigInt(900),
    subscriptions: [{ quotaBytes: GO * BigInt(10), quotaUsed: GO * BigInt(4), status: 'active' }],
  });

  assert.equal(fiche.quotaTotal, GO * BigInt(10), 'le forfait prime sur le quota de la fiche');
  assert.equal(fiche.quotaUsed, GO * BigInt(4), 'le consommé doit venir de la MÊME source');
  assert.notEqual(fiche.quotaUsed, GO * BigInt(900), 'le quotaUsed de la fiche a été mélangé au forfait');
});

test('aucune fiche ne peut être comptée deux fois', () => {
  const avecLesDeux = {
    status: 'active',
    quotaTotal: GO * BigInt(50),
    quotaUsed: GO * BigInt(7),
    subscriptions: [{ quotaBytes: GO * BigInt(10), quotaUsed: GO * BigInt(3), status: 'active' }],
  };
  const a = agregerQuotaClients([avecLesDeux]);

  assert.equal(a.provisionedBytes, GO * BigInt(10), '50 + 10 = double comptage');
  assert.equal(a.consumedBytes, GO * BigInt(3), '7 + 3 = double comptage');
  assert.equal(a.meteredClients, 1, 'une fiche, pas deux');
});

test('tout octet du numérateur provient d’une fiche présente au dénominateur', () => {
  // C'est la formulation générale de l'invariant : une fiche sans plafond ne
  // doit RIEN apporter au numérateur comparable. C'était exactement la faute.
  const parc = [
    { status: 'active', quotaTotal: GO * BigInt(20), quotaUsed: GO * BigInt(5) },
    { status: 'active', quotaTotal: null, quotaUsed: GO * BigInt(400) },
    { status: 'active', quotaTotal: BigInt(0), quotaUsed: GO * BigInt(300) },
  ];
  const a = agregerQuotaClients(parc);

  assert.equal(a.meteredConsumedBytes, GO * BigInt(5), 'les 700 Gio sans plafond ont fui au numérateur');
  assert.equal(a.provisionedBytes, GO * BigInt(20));
  assert.equal(tauxUtilisation(a), 25);
  // …mais rien n'est escamoté : le total reste exact.
  assert.equal(a.consumedBytes, GO * BigInt(705), 'la consommation réelle ne doit pas disparaître');
});

// ─────────────────────── La forme réelle du parc mesuré ─────────────────────

/** Reproduit le tableau croisé relevé en production. */
function parcProduction() {
  const parc = [];
  for (let i = 0; i < 4; i++)
    parc.push({
      status: 'active',
      quotaTotal: GO * BigInt(28),
      quotaUsed: BigInt(0),
      subscriptions: [{ quotaBytes: GO * BigInt(28), quotaUsed: GO / BigInt(7), status: 'active' }],
    });
  for (let i = 0; i < 27; i++)
    parc.push({ status: 'active', quotaTotal: GO * BigInt(6), quotaUsed: BigInt(0) });
  for (let i = 0; i < 80; i++)
    parc.push({
      status: 'active',
      quotaTotal: BigInt(0),
      quotaUsed: BigInt(0),
      subscriptions: [{ quotaBytes: GO * BigInt(50), quotaUsed: GO * BigInt(9), status: 'active' }],
    });
  for (let i = 0; i < 198; i++)
    parc.push({ status: 'active', quotaTotal: BigInt(0), quotaUsed: GO * BigInt(3) });
  return parc;
}

test('le parc réel : le quota vendu par forfait cesse d’être invisible', () => {
  const a = agregerQuotaClients(parcProduction());

  // Avant : 80 fiches porteuses de 4 000 Gio de forfaits comptaient pour zéro.
  assert.equal(a.provisionedBytes, GO * BigInt(4 * 28 + 27 * 6 + 80 * 50));
  assert.ok(a.provisionedBytes > GO * BigInt(280), 'le provisionné doit dépasser les 280 Gio du défaut');
  assert.equal(a.meteredClients, 111, '4 + 27 + 80 fiches plafonnées');
});

test('le parc réel ne produit plus de rapport hors échelle', () => {
  const taux = tauxUtilisation(agregerQuotaClients(parcProduction()));
  assert.ok(taux > 0, 'un taux nul signalerait un dénominateur toujours vide');
  assert.ok(taux <= 100, `taux hors échelle : ${taux}`);
});

test('la consommation des fiches sans plafond reste comptée au total', () => {
  const a = agregerQuotaClients(parcProduction());
  // 198 fiches x 3 Gio n'ont aucun plafond à saturer, mais le trafic est réel.
  assert.ok(a.consumedBytes > a.meteredConsumedBytes, 'le total doit rester supérieur au comparable');
  assert.equal(a.consumedBytes - a.meteredConsumedBytes, GO * BigInt(198 * 3));
});

// ───────────────────── Règles de bord, mesurées une à une ───────────────────

test('un forfait révoqué ne provisionne plus, mais son volume écoulé reste compté', () => {
  const fiche = ficheTraficEffective({
    status: 'active',
    subscriptions: [
      { quotaBytes: GO * BigInt(10), quotaUsed: GO * BigInt(6), status: 'revoked' },
      { quotaBytes: GO * BigInt(20), quotaUsed: GO * BigInt(5), status: 'active' },
    ],
  });
  assert.equal(fiche.quotaTotal, GO * BigInt(20), 'le forfait révoqué ne provisionne plus rien');
  assert.equal(fiche.quotaUsed, GO * BigInt(11), 'le volume écoulé a bien été consommé : l’oublier le minorerait');
});

test('un forfait échu ne provisionne plus', () => {
  const hier = new Date(Date.now() - 86_400_000).toISOString();
  const fiche = ficheTraficEffective({
    status: 'active',
    subscriptions: [{ quotaBytes: GO * BigInt(10), quotaUsed: GO, status: 'active', expireAt: hier }],
  });
  assert.equal(fiche.quotaTotal, BigInt(0));
  assert.equal(fiche.quotaUsed, GO);
});

test('un client suspendu ne provisionne plus', () => {
  const fiche = ficheTraficEffective({
    status: 'suspended',
    quotaTotal: GO * BigInt(30),
    quotaUsed: GO * BigInt(2),
  });
  assert.equal(fiche.quotaTotal, BigInt(0), 'un compte suspendu ne réserve plus de volume');
  assert.equal(fiche.quotaUsed, GO * BigInt(2));
});

test('un plafond illimité ne RETRANCHE pas du volume', () => {
  // La convention du dépôt est « négatif = illimité ». L'additionner tel quel
  // ferait baisser le total, et pourrait le rendre négatif.
  const a = agregerQuotaClients([
    { status: 'active', subscriptions: [{ quotaBytes: BigInt(-1), quotaUsed: GO * BigInt(4), status: 'active' }] },
    { status: 'active', quotaTotal: GO * BigInt(10), quotaUsed: GO * BigInt(2) },
  ]);
  assert.equal(a.provisionedBytes, GO * BigInt(10), 'le plafond illimité a été additionné');
  assert.ok(a.provisionedBytes > BigInt(0));
  assert.equal(a.consumedBytes, GO * BigInt(6), 'sa consommation reste néanmoins réelle');
});

test('un parc vide ne divise pas par zéro', () => {
  const a = agregerQuotaClients([]);
  assert.equal(a.provisionedBytes, BigInt(0));
  assert.equal(tauxUtilisation(a), 0);
});

test('un dépassement réel reste visible et n’est pas plafonné', () => {
  const a = agregerQuotaClients([
    { status: 'active', subscriptions: [{ quotaBytes: GO * BigInt(10), quotaUsed: GO * BigInt(13), status: 'active' }] },
  ]);
  assert.equal(tauxUtilisation(a), 130, 'un dépassement est une information commerciale, pas une anomalie à masquer');
});

// ───────────────── Provenance : rendre une dérive future visible ────────────

test('la provenance distingue les deux sources', () => {
  const p = provenanceQuota([
    { status: 'active', subscriptions: [{ quotaBytes: GO, quotaUsed: BigInt(0), status: 'active' }] },
    { status: 'active', quotaTotal: GO, quotaUsed: BigInt(0) },
    { status: 'active', quotaTotal: BigInt(0), quotaUsed: GO },
  ]);
  assert.equal(p.fromSubscriptions, 1);
  assert.equal(p.fromClientRecord, 2);
});

test('les forfaits hors norme sont retranchés du total ET dénombrés à part', () => {
  // NON-RÉGRESSION — ce test échoue sur 6a9446c, et c'est voulu.
  //
  // La version précédente de ce test verrouillait la décision inverse : « le
  // hors norme doit RESTER dans le total ». Déployée le 21/09 à 08:42, elle a
  // produit onze minutes plus tard `remainingTraffic = 2 015 158,96 Gio` —
  // 2 pétaoctets présentés comme restants à un exploitant dont le parc réel
  // en provisionne 4 251. Le raisonnement qui la fondait (« retrancher
  // remplacerait un chiffre absurde par un chiffre flatteur ») était inversé :
  // c'est l'inclusion qui flatte, parce qu'elle efface l'épuisement du quota.
  const vip = SEUIL_FORFAIT_HORS_NORME * BigInt(100);
  const ordinaire = GO * BigInt(5);
  const parc = [
    { status: 'active', subscriptions: [{ quotaBytes: vip, quotaUsed: GO, status: 'active' }] },
    { status: 'active', quotaTotal: ordinaire, quotaUsed: GO * BigInt(2) },
  ];
  const p = provenanceQuota(parc);
  const a = agregerQuotaClients(parc);

  // L'anomalie reste VISIBLE.
  assert.equal(p.outsizedPlans, 1);
  assert.equal(p.outsizedBytes, vip);
  assert.equal(a.outsizedPlans, 1, "l'agrégat dénombre lui aussi la part écartée");
  assert.equal(a.outsizedBytes, vip);
  assert.equal(a.provisionedBytesBrut, vip + ordinaire, 'le total brut reste consultable');

  // Elle cesse d'être SOMMÉE.
  assert.equal(a.provisionedBytes, ordinaire, 'le hors norme ne doit plus gonfler le total');

  // Un plafond hors norme ne plafonne rien : il sort du numérateur comme du
  // dénominateur, au même titre qu'un quota absent.
  assert.equal(a.meteredClients, 1, 'la fiche hors norme n’est pas une fiche plafonnée');
  assert.equal(a.meteredConsumedBytes, GO * BigInt(2), 'son usage sort du numérateur');

  // Mais sa consommation n'est jamais perdue du total consommé.
  assert.equal(a.consumedBytes, GO * BigInt(3), 'rien ne disparaît de la consommation');
});

test('le reste affiché ne peut plus dépasser la réalité du parc', () => {
  // Reproduction à l'échelle des chiffres de production : 40 forfaits à ~49 Tio
  // contre une part ordinaire modeste. C'est le calcul exact qui produisait le
  // « 2 Po restants » du tableau de bord.
  const horsNorme = SEUIL_FORFAIT_HORS_NORME * BigInt(49);
  const parc = [];
  for (let i = 0; i < 40; i++) {
    parc.push({
      status: 'active',
      subscriptions: [{ quotaBytes: horsNorme, quotaUsed: BigInt(0), status: 'active' }],
    });
  }
  parc.push({ status: 'active', quotaTotal: GO * BigInt(100), quotaUsed: GO * BigInt(80) });

  const a = agregerQuotaClients(parc);
  const resteGo = Number(a.provisionedBytes - a.meteredConsumedBytes) / Number(GO);

  assert.equal(a.outsizedPlans, 40);
  assert.equal(a.provisionedBytes, GO * BigInt(100), 'seule la part ordinaire fait le plafond');
  assert.equal(resteGo, 20, 'le reste est celui du parc réel, pas un pétaoctet');
  assert.ok(resteGo < 1000, `reste aberrant : ${resteGo} Gio`);
});

test('un dépassement de quota redevient détectable', () => {
  // Tant que les 2 Po hors norme entraient dans la comparaison, aucun
  // dépassement ne pouvait se déclencher : le signal était mort sans être
  // absent — une panne silencieuse, pas une valeur fausse.
  const parc = [
    {
      status: 'active',
      subscriptions: [
        { quotaBytes: SEUIL_FORFAIT_HORS_NORME * BigInt(50), quotaUsed: BigInt(0), status: 'active' },
      ],
    },
    { status: 'active', quotaTotal: GO * BigInt(10), quotaUsed: GO * BigInt(12) },
  ];
  const a = agregerQuotaClients(parc);

  assert.ok(
    a.meteredConsumedBytes > a.provisionedBytes,
    'la consommation dépasse le plafond ordinaire : le dépassement doit se voir',
  );
});

// ──────────────── La règle ne doit exister qu'en un exemplaire ──────────────

test('la route ne réimplémente pas la règle de quota', () => {
  // Le premier défaut a vécu parce que la règle existait en deux exemplaires.
  // La route doit déléguer, jamais recalculer.
  const source = readFileSync(join(RACINE, 'server', 'routes', 'dashboard.ts'), 'utf8').replace(/\r\n/g, '\n');

  assert.match(source, /from ["']\.\.\/services\/trafic-agrege["']/, 'la route doit utiliser le point unique');
  assert.equal(
    (source.match(/agregerQuotaClients\(/g) || []).length,
    2,
    'les deux branches — base de données et repli mémoire — doivent appeler la même fonction',
  );

  // Le cumul peut se réécrire dans les DEUX sens : `quotaTotal … reduce(` mais
  // aussi `reduce( … quotaTotal`. Un motif directionnel laissait passer le
  // second — défaut trouvé en rendant ce banc rouge volontairement.
  const cumulAvant = /quota(?:Total|Used)[\s\S]{0,120}?(?:reduce\(|\+=)/;
  const cumulApres = /(?:reduce\(|\+=)[\s\S]{0,120}?quota(?:Total|Used)/;
  // Le `select` Prisma cite légitimement `quotaTotal: true` : on ne lit que le
  // code, pas la description des colonnes.
  const sansSelect = source.replace(/quota(?:Total|Used|Bytes):\s*true,?/g, '');

  assert.ok(!cumulAvant.test(sansSelect), 'un cumul de quota a été réintroduit dans la route');
  assert.ok(!cumulApres.test(sansSelect), 'un cumul de quota a été réintroduit dans la route (ordre inverse)');
});

test('la route lit bien les forfaits, sans quoi le quota vendu redevient invisible', () => {
  const source = readFileSync(join(RACINE, 'server', 'routes', 'dashboard.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /subscriptions:\s*\{/, 'le select doit charger les forfaits');
  assert.match(source, /quotaBytes:\s*true/, 'sans quotaBytes, le provisionné retombe à 280 Gio');
});

test('la borne à zéro du reste n’est plus muette', () => {
  // Garder Math.max(0, …) est juste : un reste négatif n'a pas de sens à
  // l'affichage. Mais son silence est ce qui a permis au défaut de vivre.
  const source = readFileSync(join(RACINE, 'server', 'routes', 'dashboard.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /remainingTraffic:[\s\S]{0,200}Math\.max\(\s*0/, 'la borne doit rester');
  assert.match(source, /trafficOverage:/, 'le dépassement doit être publié à côté de la borne');
  assert.match(source, /trafficOverageBytes:/, 'et son volume exact');
});

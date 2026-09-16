/**
 * Une publication périmée ne doit plus être annoncée.
 *
 * LE DÉFAUT OBSERVÉ EN PRODUCTION
 * ───────────────────────────────
 * L'URL publiée est un pointeur MOBILE (`/download/sxbvpn-latest.apk`). Chaque
 * construction remplace le fichier derrière elle, tandis que la publication
 * garde le condensat saisi le jour où elle a été faite.
 *
 * Constat le 16/09 : la publication annonçait le build 211576163 avec le
 * condensat `694730658…`, alors que cette URL servait le build 211687045 dont
 * le condensat est `58e4ca34…`. Chaque appareil qui touchait « Télécharger »
 * récupérait 62 Mo, calculait l'empreinte, constatait l'écart, SUPPRIMAIT
 * l'archive et affichait une erreur d'intégrité. La mise à jour était
 * impossible à installer depuis l'application — pour tout le monde.
 *
 * Ce contrôle exerce la vraie fonction du serveur avec un vrai manifeste sur
 * disque : aucune approximation, aucun double de la règle.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dossier = mkdtempSync(path.join(os.tmpdir(), 'sxb-build-manifest-'));
const manifeste = path.join(dossier, 'latest-build.json');
process.env.MOBILE_APP_BUILD_MANIFEST = manifeste;

const URL_MOBILE = 'https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk';
const SERVI = {
  versionCode: 211697659,
  versionName: '1.2.1',
  apkUrl: URL_MOBILE,
  apkSha256: 'e12467c18cd228263a52dcf65a283f10aac08e14d4518bf644073ed88ff9d3ae',
  sizeBytes: 62215517,
  releaseTag: 'apk-87',
  builtAt: '2026-09-16T05:00:22Z',
};

function ecrireManifeste(valeurs = SERVI) {
  writeFileSync(manifeste, JSON.stringify(valeurs), 'utf8');
}

/** Publication telle que la stocke le tableau de bord. */
function publication(surcharges = {}) {
  return {
    id: 'pub-1',
    versionCode: SERVI.versionCode,
    versionName: SERVI.versionName,
    apkUrl: URL_MOBILE,
    apkSha256: SERVI.apkSha256,
    notes: '',
    minSupportedCode: 0,
    forceUpdate: false,
    active: true,
    targetRoles: ['OWNER'],
    targetDeviceIds: [],
    publishedAt: SERVI.builtAt,
    updatedAt: SERVI.builtAt,
    ...surcharges,
  };
}

ecrireManifeste();
const { publicationDecritLeFichierServi, installedVersionCodeFromHeaders } =
  await import('../../server/services/app-update.ts');

test.after(() => rmSync(dossier, { recursive: true, force: true }));

test('une publication alignée sur le fichier servi reste annoncée', () => {
  ecrireManifeste();
  assert.equal(publicationDecritLeFichierServi(publication()), true);
});

test('le cas de production : condensat périmé derrière une URL mobile', () => {
  ecrireManifeste();
  // Exactement ce qui était publié : un ancien build, une ancienne empreinte,
  // la même URL — donc un téléchargement voué à l'échec d'intégrité.
  const perimee = publication({
    versionCode: 211576163,
    apkSha256: '694730658093846758f7366fcfdf1d261e9c1e2e945abe80469d4e4be6db0256',
  });
  assert.equal(publicationDecritLeFichierServi(perimee), false);
});

test('un versionCode périmé suffit, même sans condensat publié', () => {
  ecrireManifeste();
  // Sans condensat, l'application n'a rien à vérifier — mais Android refusera
  // l'archive comme un retour en arrière si elle est plus ancienne, et ne la
  // reproposera jamais si elle est plus récente que le fichier réel.
  const decalee = publication({ versionCode: 211576163, apkSha256: '' });
  assert.equal(publicationDecritLeFichierServi(decalee), false);
});

test('une URL propre à une version n’est jamais invalidée par une autre build', () => {
  ecrireManifeste();
  // Une publication qui pointe une archive figée (release GitHub horodatée)
  // ne bouge pas quand la build « latest » change : rien ne doit la suspendre.
  const figee = publication({
    apkUrl: 'https://github.com/AbakoDolla/SXB-VPN/releases/download/apk-80/sxb-vpn.apk',
    versionCode: 211000000,
    apkSha256: 'a'.repeat(64),
  });
  assert.equal(publicationDecritLeFichierServi(figee), true);
});

test('sans manifeste lisible, on ne suspend rien', () => {
  // Poste de développement, déploiement ancien, fichier corrompu : on ne peut
  // rien affirmer, et couper la distribution sur une absence de preuve serait
  // une panne inventée.
  writeFileSync(manifeste, '{ ceci n’est pas du json', 'utf8');
  assert.equal(publicationDecritLeFichierServi(publication({ versionCode: 1 })), true);
  ecrireManifeste();
});

test('la version installée est lue depuis l’en-tête, sans jamais inventer', () => {
  assert.equal(installedVersionCodeFromHeaders({ 'x-sxb-app-version-code': '211697659' }), 211697659);
  // Absente, illisible ou absurde : zéro, c'est-à-dire « inconnue ».
  for (const brut of [undefined, '', 'abc', '-3', '0', '1.5']) {
    assert.equal(installedVersionCodeFromHeaders({ 'x-sxb-app-version-code': brut }), 0, `valeur acceptée à tort : ${brut}`);
  }
  // Un en-tête répété ne doit pas produire NaN.
  assert.equal(installedVersionCodeFromHeaders({ 'x-sxb-app-version-code': ['211697659', '1'] }), 211697659);
});

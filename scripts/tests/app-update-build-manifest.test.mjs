/**
 * Le manifeste de build proposé à la publication mobile.
 *
 * POURQUOI CE TEST EXISTE
 * ───────────────────────
 * Publier une mise à jour mobile demande trois valeurs exactes : versionCode,
 * URL et condensat SHA-256. Elles étaient ressaisies à la main depuis le
 * journal d'intégration continue, et les deux fautes possibles ne se voient
 * qu'APRÈS coup, sur les appareils :
 *
 *  • condensat faux → chaque appareil télécharge 62 Mo, calcule l'empreinte,
 *    constate l'écart et refuse d'installer. La publication, elle, a l'air
 *    réussie ;
 *  • versionCode faux → trop bas, Android refuse comme un retour en arrière ;
 *    trop haut, l'APK réelle ne sera plus jamais proposée.
 *
 * La chaîne de construction dépose donc un manifeste, et ce lecteur le
 * transmet au tableau de bord. Sa règle cardinale : ne JAMAIS proposer une
 * valeur douteuse. Mieux vaut un formulaire vide, rempli à la main en
 * connaissance de cause, qu'une valeur fausse présentée comme sûre.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'backend', 'package.json'));
const { build } = require('esbuild');

const dir = mkdtempSync(path.join(tmpdir(), 'sxb-build-manifest-'));
const manifestPath = path.join(dir, 'latest-build.json');
process.env.MOBILE_APP_BUILD_MANIFEST = manifestPath;

// Empaqueté comme le fait le déploiement, plutôt qu'importé pièce par pièce :
// c'est bien le module de production qui est éprouvé, avec ses imports réels.
const bundlePath = path.join(dir, 'manifest.cjs');
await build({
  stdin: { contents: 'export * from "./server/services/app-build-manifest";', resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: bundlePath, logLevel: 'silent',
});
const { readLatestBuildManifest } = require(bundlePath);

const DIGEST = '9d52cab3f29043c8b9e7b743b7b8035dad098fbe9381fd7aa78844dd3209afd0';
const valid = {
  versionCode: 211382770,
  versionName: '1.2.2',
  apkUrl: 'https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk',
  apkSha256: DIGEST,
  sizeBytes: 62047581,
  releaseTag: 'apk-64',
  releaseUrl: 'https://github.com/AbakoDolla/SXB-VPN/releases/download/apk-64/sxb-vpn.apk',
  commit: 'f83e56b',
  builtAt: '2026-09-12T13:34:58Z',
};

function write(value) {
  writeFileSync(manifestPath, typeof value === 'string' ? value : JSON.stringify(value));
}

test('lit un manifeste complet sans rien inventer', () => {
  write(valid);
  const build = readLatestBuildManifest();
  assert.ok(build);
  assert.equal(build.versionCode, 211382770);
  assert.equal(build.versionName, '1.2.2');
  assert.equal(build.apkSha256, DIGEST);
  assert.equal(build.sizeBytes, 62047581);
  assert.equal(build.apkUrl, valid.apkUrl);
});

test('accepte un condensat recopié depuis un terminal, en le normalisant', () => {
  // `sha256sum` et les journaux CI produisent couramment ces formes. Les
  // refuser obligerait à un nettoyage manuel, c'est-à-dire au risque de frappe
  // que ce manifeste existe pour supprimer.
  write({ ...valid, apkSha256: `SHA256:${DIGEST.toUpperCase()}` });
  assert.equal(readLatestBuildManifest().apkSha256, DIGEST);
});

test('ne propose RIEN plutôt qu’une valeur douteuse', () => {
  // Condensat inexploitable : proposer l'APK sans empreinte vérifiable ne vaut
  // pas mieux qu'une saisie manuelle, et laisse croire à une garantie absente.
  write({ ...valid, apkSha256: 'abc' });
  assert.equal(readLatestBuildManifest(), null);

  // URL non chiffrée : la publication l'exige déjà en HTTPS. La refuser ici
  // évite de proposer une valeur que le formulaire rejettera ensuite.
  write({ ...valid, apkUrl: 'http://vpnsxb.afrihall.com/download/sxbvpn-latest.apk' });
  assert.equal(readLatestBuildManifest(), null);

  // Un versionCode nul ou négatif ne peut désigner aucune APK installable.
  write({ ...valid, versionCode: 0 });
  assert.equal(readLatestBuildManifest(), null);
  write({ ...valid, versionCode: -3 });
  assert.equal(readLatestBuildManifest(), null);

  // Nom de version vide : l'écran l'affiche à l'exploitant pour qu'il
  // reconnaisse la build ; sans lui, il publierait à l'aveugle.
  write({ ...valid, versionName: '   ' });
  assert.equal(readLatestBuildManifest(), null);
});

test('un manifeste illisible ou absent laisse la saisie manuelle intacte', () => {
  // Un poste de développement n'a pas de manifeste, et un fichier tronqué par
  // un déploiement interrompu ne doit pas faire tomber l'écran de publication.
  write('{ ceci n’est pas du JSON');
  assert.equal(readLatestBuildManifest(), null);
  rmSync(manifestPath, { force: true });
  assert.equal(readLatestBuildManifest(), null);
});

test('la taille reste facultative : elle informe, elle n’autorise rien', () => {
  write({ ...valid, sizeBytes: 'inconnue' });
  const build = readLatestBuildManifest();
  assert.ok(build, 'une taille illisible ne doit pas invalider une build par ailleurs saine');
  assert.equal(build.sizeBytes, 0);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

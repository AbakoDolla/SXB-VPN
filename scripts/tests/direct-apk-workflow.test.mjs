import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(new URL('../../app-mobile/package.json', import.meta.url));
const YAML = require('yaml');
const source = readFileSync(new URL('../../.github/workflows/build-android.yml', import.meta.url), 'utf8');
const workflow = YAML.parse(source);
const job = workflow.jobs['build-android'];

test('direct branch builds produce an artifact without touching public distribution', () => {
  assert.match(job.if, /inputs\.distribution != 'play'/);
  const publishing = job.steps.filter(step =>
    /softprops\/action-gh-release|appleboy\/(?:scp|ssh)-action/.test(step.uses || '') ||
    /gh release (?:create|upload|delete)/.test(step.run || ''));
  assert.equal(publishing.length, 4);
  for (const step of publishing) {
    assert.match(step.if, /github\.ref == 'refs\/heads\/main'/, step.name);
  }
  const artifact = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(artifact);
  assert.equal(artifact.if, undefined);
  assert.match(artifact.with.path, /app-mobile\/build\/sxb-vpn\.apk/);
  assert.match(artifact.with.path, /app-mobile\/build\/report\//);
});

test('APK candidates compare the existing identity and inspect native binaries before publishing', () => {
  const allocation = job.steps.findIndex(step => /Allocate shared Android version/.test(step.name));
  const baseline = job.steps.findIndex(step => /Read the published APK identity/.test(step.name));
  const toolchain = job.steps.findIndex(step => /Prepare pinned Android release tools/.test(step.name));
  const validation = job.steps.findIndex(step => /Valider APK/.test(step.name));
  const artifact = job.steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(baseline >= 0 && baseline < allocation);
  assert.ok(toolchain >= 0 && toolchain < baseline);
  assert.match(job.steps[toolchain].run, /"build-tools;36\.0\.0"/);
  assert.ok(validation > allocation && validation < artifact);
  assert.match(job.steps[baseline].run, /verify --verbose --print-certs/);
  assert.match(job.steps[baseline].run, /node scripts\/read-direct-baseline\.cjs/);
  assert.match(job.steps[baseline].run, /build-tools\/36\.0\.0\/apksigner/);
  assert.equal(job.steps[allocation].env.SXB_PUBLISHED_VERSION_CODE, undefined);
  const script = job.steps[validation].run;
  assert.match(script, /identity\.certificateSha256, baseline\.certificateSha256/);
  assert.match(script, /identity\.versionCode > baseline\.versionCode/);
  assert.match(script, /inspectNativeArchive\('build\/sxb-vpn\.apk', 'lib', \['libbox\.so', 'libdnstt\.so'\]\)/);
  assert.match(script, /status: 'validated-artifact'/);
  assert.match(script, /build-tools\/36\.0\.0\/apksigner/);
  assert.doesNotMatch(script, /status: 'published'/);
});

test('the deployed APK offers itself to the dashboard, hashed from the file devices will download', () => {
  // Publier une mise à jour exigeait de recopier à la main le versionCode,
  // l'URL et 64 caractères de condensat depuis le journal CI. Une faute sur le
  // condensat ne se voit qu'après que CHAQUE appareil a téléchargé 62 Mo puis
  // refusé l'installation ; une faute sur le versionCode rend la mise à jour
  // soit invisible, soit refusée par Android comme un retour en arrière.
  const install = job.steps.find(step => /Installer APK dans dossier distribution VPS/.test(step.name));
  assert.ok(install, 'étape de déploiement introuvable');
  const script = install.with.script;

  // Le manifeste vit hors du chemin public et survit au nettoyage des archives.
  assert.match(script, /\/var\/www\/apk\/latest-build\.json/);
  assert.doesNotMatch(script, /\/var\/www\/sxb-vpn\/dist\/download\/latest-build\.json/);

  // Cœur de la garantie : condensat et taille sont relus SUR LE FICHIER DÉPLOYÉ.
  // Les recopier depuis la machine de build laisserait passer une corruption
  // survenue pendant le transfert, et c'est précisément ce que le condensat
  // est censé détecter.
  const manifest = script.slice(script.indexOf('<<MANIFEST_EOF'), script.lastIndexOf('MANIFEST_EOF'));
  assert.match(manifest, /sha256sum "\$APK_PATH"/);
  assert.match(manifest, /stat -c%s "\$APK_PATH"/);
  assert.ok(!/apkSha256":\s*"\$\{\{/.test(manifest), 'le condensat ne doit pas venir de la machine de build');

  // Le versionCode annoncé est celui que la validation a vérifié dans l'APK.
  assert.match(script, /"versionCode": \$\{\{ env\.SXB_ANDROID_VERSION_CODE \}\}/);
  assert.match(script, /"versionName": "\$\{\{ env\.SXB_APK_VERSION_NAME \}\}"/);

  // Ce nom de version n'existe nulle part ailleurs : parseBaseline ne rend que
  // le versionCode. Il doit donc être extrait du manifeste APK et exporté.
  const validation = job.steps.find(step => /Valider APK/.test(step.name));
  assert.match(validation.run, /versionName='\(\[\^'\]\+\)'/);
  assert.match(validation.run, /SXB_APK_VERSION_NAME=\$\{versionName\}/);

  // L'URL annoncée est le chemin public réellement servi, pas l'archive de
  // diagnostic /var/www/apk — qui rendait jadis la page HTML du tableau de bord.
  assert.match(script, /"apkUrl": "https:\/\/vpnsxb\.afrihall\.com\/download\/sxbvpn-latest\.apk"/);
});

test('both Android channels run the same production Kotlin policy harnesses before signing', () => {
  const nativeGate = job.steps.find(step => step.run?.includes('run-android-policy-gates.sh'));
  assert.ok(nativeGate);
  const script = readFileSync(new URL('../run-android-policy-gates.sh', import.meta.url), 'utf8');
  execFileSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.match(script, /node tests\/run-play-encryption\.cjs/);
  assert.match(script, /node tests\/run-access-policy\.cjs/);
  assert.doesNotMatch(script, /KEYSTORE|KEY_PASSWORD|android\.jar/);
});

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

test('both Android channels run the same production Kotlin policy harnesses before signing', () => {
  const nativeGate = job.steps.find(step => step.run?.includes('run-android-policy-gates.sh'));
  assert.ok(nativeGate);
  const script = readFileSync(new URL('../run-android-policy-gates.sh', import.meta.url), 'utf8');
  execFileSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.match(script, /node tests\/run-play-encryption\.cjs/);
  assert.match(script, /node tests\/run-access-policy\.cjs/);
  assert.doesNotMatch(script, /KEYSTORE|KEY_PASSWORD|android\.jar/);
});

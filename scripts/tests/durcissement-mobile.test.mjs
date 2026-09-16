/**
 * Durcissement mobile — ce qui remonte, et ce que le client ne décide pas.
 *
 * CE QUI EST VÉRIFIÉ ICI
 * ──────────────────────
 * Le vrai moteur de risque du serveur, pas une réécriture : c'est la fonction
 * que la route appelle. On l'exerce signal par signal, puis on vérifie que la
 * chaîne autour tient ses promesses — attribution, mutisme de la réponse,
 * absence de secret.
 *
 * Les invariants tenus :
 *  • la décision appartient au serveur, jamais au client ;
 *  • un signal isolé et ambigu ne coupe l'accès de personne ;
 *  • un remballage ou un leurre touché coupe, seul ;
 *  • chaque alerte porte l'adresse source et le nom enregistré du client ;
 *  • la réponse ne renvoie ni score ni seuil, qui serviraient de banc d'essai ;
 *  • une sonde qui échoue ne prive jamais l'utilisateur de son VPN.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.JWT_SECRET ||= 'secret-de-test-pour-le-durcissement-0123456789';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(racine, 'backend', 'package.json'));
const lireSource = (relatif) => readFileSync(path.join(racine, relatif), 'utf8');

const sortie = path.join(racine, 'backend', '.sxb-risque-test.cjs');
const { build } = require('esbuild');
await build({
  entryPoints: [path.join(racine, 'server', 'services', 'mobile-risk.ts')],
  outfile: sortie,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent',
});
const risque = require(sortie);
process.on('exit', () => { if (existsSync(sortie)) rmSync(sortie, { force: true }); });

test('un remballage coupe l’accès à lui seul', () => {
  // Une signature d'APK qui ne correspond pas n'a aucune cause légitime : elle
  // prouve que le binaire installé n'est pas celui qui a été publié.
  const verdict = risque.evaluerRisque(['signatureInvalid']);
  assert.equal(verdict.action, 'block');
  assert.equal(verdict.severity, 'critical');
});

test('un leurre touché coupe l’accès à lui seul', () => {
  // Une valeur appât n'est jamais lue par une application intacte.
  const verdict = risque.evaluerRisque(['decoyTouched']);
  assert.equal(verdict.action, 'block');
});

test('une instrumentation active coupe l’accès', () => {
  for (const signal of ['hooked', 'frida']) {
    assert.equal(risque.evaluerRisque([signal]).action, 'block', `${signal} doit couper`);
  }
});

test('un appareil rooté n’est pas un coupable', () => {
  // Beaucoup d'utilisateurs honnêtes rootent leur téléphone. Le signal pèse,
  // il n'accuse pas : couper là-dessus reviendrait à punir une préférence.
  const verdict = risque.evaluerRisque(['rooted']);
  assert.equal(verdict.action, 'watch');
  assert.notEqual(verdict.action, 'block');
});

test('un émulateur seul ne déclenche rien de plus qu’une trace', () => {
  const verdict = risque.evaluerRisque(['emulator']);
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.severity, 'info');
});

test('les signaux faibles finissent par se cumuler', () => {
  // Rooté + émulateur + débogueur : aucun ne prouve rien seul, les trois
  // ensemble décrivent un banc d'analyse.
  const verdict = risque.evaluerRisque(['rooted', 'emulator', 'debugger']);
  assert.equal(verdict.action, 'block');
});

test('un appareil sain ne remplit pas le flux d’alertes', () => {
  const verdict = risque.evaluerRisque([]);
  assert.equal(risque.meriteUneTrace(verdict), false);
  assert.equal(verdict.score, 0);
});

test('un signal inventé par le client est ignoré', () => {
  // Le client ne choisit pas le vocabulaire : un champ inconnu ne doit ni
  // peser, ni faire tomber l'évaluation.
  const retenus = risque.normaliserSignaux({ frida: true, superPouvoir: true, rooted: false });
  assert.deepEqual(retenus, ['frida']);
  assert.equal(risque.evaluerRisque(retenus).score, risque.evaluerRisque(['frida']).score);
});

test('le score ne dépasse jamais cent', () => {
  const tout = risque.SIGNAUX_MOBILES.slice();
  assert.equal(risque.evaluerRisque(tout).score, 100);
});

test('le client n’envoie aucun verdict, et n’en reçoit aucun', () => {
  const route = lireSource('server/routes/mobile-security.ts');
  // Le corps accepté ne contient que des observations booléennes.
  assert.match(route, /signals: z\.record\(z\.string\(\), z\.boolean\(\)\)/);
  assert.match(route, /\.strict\(\)/);
  // La réponse est muette : renvoyer le score offrirait un banc d'essai où il
  // suffirait d'itérer jusqu'à passer sous le seuil.
  const reponses = [...route.matchAll(/res\.status\(202\)\.json\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(reponses.length >= 2, 'la route doit répondre 202 sans détail');
  for (const corps of reponses) {
    assert.doesNotMatch(corps, /score|severity|signal|action/i, `la réponse divulgue le verdict : ${corps}`);
  }
});

test('chaque alerte porte l’adresse source et le nom du client', () => {
  const route = lireSource('server/routes/mobile-security.ts');
  // Sans attribution, l'exploitant lit un incident sur lequel il ne peut pas agir.
  assert.match(route, /ip: adresseSource\(req\)/);
  assert.match(route, /clientName: fiche\?\.user\?\.name \|\| fiche\?\.user\?\.email \|\| null/);
  // Et ces champs doivent être autorisés à l'écriture, sinon ils sont
  // silencieusement jetés par l'allowlist.
  const evenements = lireSource('server/services/security-events.ts');
  for (const cle of ['ip', 'clientName', 'signals', 'riskScore', 'action']) {
    assert.ok(evenements.includes(`'${cle}'`), `le champ ${cle} doit être autorisé dans metadata`);
  }
});

test('aucun jeton de client n’entre dans une alerte', () => {
  // L'attribution nomme la personne ; elle ne recopie pas ses identifiants.
  const route = lireSource('server/routes/mobile-security.ts');
  assert.doesNotMatch(route, /token: /);
  const evenements = lireSource('server/services/security-events.ts');
  assert.ok(!evenements.includes("'clientToken'"), 'un jeton n’a rien à faire dans un journal');
});

test('la coupure est réversible et tracée', () => {
  const route = lireSource('server/routes/mobile-security.ts');
  // Suspension, jamais suppression : un faux positif doit se réparer.
  assert.match(route, /status: 'suspended'/);
  assert.doesNotMatch(route, /vpnClient\.delete/);
  // L'observation et la sanction sont deux entrées distinctes : on doit lire ce
  // qui a été vu même si la coupure échoue.
  assert.match(route, /DEVICE_AUTO_BLOCKED/);
  assert.match(route, /SUSPEND_FAILED/);
});

test('les nouveaux types d’alerte existent et se lisent dans les deux langues', () => {
  const service = lireSource('server/services/security-events.ts');
  const types = ['DEVICE_INTEGRITY_ALERT', 'DEVICE_AUTO_BLOCKED', 'DEVICE_DECOY_TOUCHED', 'DEVICE_ATTESTATION_FAILED'];
  for (const type of types) {
    assert.ok(service.includes(`'${type}'`), `${type} doit être un type reconnu`);
  }
  for (const langue of ['fr', 'en']) {
    const secu = JSON.parse(lireSource(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`)).security;
    for (const type of types) {
      assert.ok(secu.eventLabels?.[type], `${langue}: libellé manquant pour ${type}`);
      assert.ok(secu.eventExplain?.[type]?.length > 30, `${langue}: explication trop courte pour ${type}`);
    }
    for (const signal of risque.SIGNAUX_MOBILES) {
      assert.ok(secu.signalLabels?.[signal], `${langue}: signal ${signal} sans libellé`);
    }
    for (const cle of ['ip', 'clientName', 'signals', 'riskScore', 'action']) {
      assert.ok(secu.metaLabels?.[cle], `${langue}: champ ${cle} sans libellé`);
    }
  }
});

test('la remontée mobile ne peut jamais casser l’application', () => {
  const service = lireSource('app-mobile/services/securityReport.ts');
  // Tout est avalé : une sonde qui échoue ne doit pas priver l'utilisateur de
  // son VPN ni faire remonter d'exception à l'écran.
  assert.match(service, /catch \{/);
  assert.match(service, /export async function remonterIntegrite/);
  // Rien n'est envoyé quand il n'y a rien à dire.
  assert.match(service, /if \(noms\.length === 0\)/);
  // Une signature non configurée n'accuse personne.
  assert.match(service, /rapport\.signatureStatus === 'INVALID'/);
  assert.doesNotMatch(service, /signatureStatus !== 'VALID'/);
});

test('seule une session mobile peut déclarer un incident', () => {
  const route = lireSource('server/routes/mobile-security.ts');
  // Un compte d'exploitation qui posterait ici fabriquerait des alertes contre
  // un appareil qui n'est pas le sien.
  assert.match(route, /req\.user\?\.role !== 'CLIENT'/);
  assert.match(route, /MOBILE_CLIENT_ONLY/);
  // L'appareil est identifié par une en-tête au format contraint.
  assert.match(route, /\^SXB\[A-Z0-9\]\{6,80\}\$/);
});

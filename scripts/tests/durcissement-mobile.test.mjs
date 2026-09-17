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

test('les sondes d’intégrité ne sont jamais sur le chemin d’une interaction', () => {
  // Les sondes natives sont coûteuses — deux connexions de socket, la lecture
  // de `/proc/self/maps` — et s'exécutent sur le thread des modules natifs, où
  // CHAQUE autre appel du pont fait la queue derrière. Payées au démarrage,
  // elles rendaient toute l'interface poussive.
  const service = lireSource('app-mobile/services/securityReport.ts');
  assert.match(service, /InteractionManager\.runAfterInteractions/);
  assert.match(service, /const DELAI_REPOS_MS/);

  // Le rythme est noté AVANT les sondes : sinon une remontée qui échoue laisse
  // le compteur à zéro et fait relancer les sondes à chaque déclenchement,
  // transformant une panne réseau en ralentissement général.
  const corps = service.slice(service.indexOf('export async function remonterIntegrite'));
  const marque = corps.indexOf('dernierEnvoi = maintenant;');
  const sonde = corps.indexOf('await module.checkSecurity()');
  assert.ok(marque > -1 && sonde > marque, 'le rythme doit être noté avant la sonde');
  assert.equal(
    (corps.match(/dernierEnvoi = maintenant/g) || []).length,
    1,
    'le rythme ne se note qu’une fois, quel que soit le chemin',
  );
});

test('l’audit du pont ne lance pas de processus et mémorise l’immuable', () => {
  const natif = lireSource('app-mobile/modules/android-native/SecurityModule.kt');
  // `deep` lance `getprop`, donc un PROCESSUS, à chaque appel. Le pont ne doit
  // jamais l'emprunter.
  assert.match(natif, /fun auditPourPont\(ctx: Context\): SecurityReport/);
  const module = lireSource('app-mobile/modules/android-native/SxbVpnModule.kt');
  assert.match(module, /SecurityModule\.auditPourPont\(reactApplicationContext\)/);
  assert.doesNotMatch(module, /audit\(reactApplicationContext, deep = true\)/);

  // Ce qui ne peut pas changer pendant la vie du processus est calculé une
  // fois : la signature de l'APK et la nature de l'appareil.
  assert.match(natif, /signatureCache\?\.let \{ return it \}/);
  assert.match(natif, /emulatorCache \?: isEmulator\(\)\.also/);
  // Ce qui traduit une attaque EN COURS reste mesuré à chaque appel.
  const pont = natif.slice(natif.indexOf('fun auditPourPont'), natif.indexOf('@Volatile private var signatureCache'));
  assert.match(pont, /hasFrida = hasFrida\(\)/);
  assert.match(pont, /isHooked = isHooked\(\)/);
});

test('aucune animation de lancement ne survit à l’écran', () => {
  const lancement = lireSource('app-mobile/app/index.tsx');
  // Une boucle infinie continue de faire travailler le moteur d'animation
  // après le démontage si son arrêt est manqué une seule fois — et
  // l'application devient poussive sans que rien ne le montre à l'écran.
  const boucles = [...lancement.matchAll(/Animated\.loop\(/g)];
  const iterations = [...lancement.matchAll(/\{ iterations: /g)];
  assert.equal(boucles.length, iterations.length, 'chaque boucle doit être bornée');
  assert.ok(boucles.length >= 2, 'les boucles doivent être relues depuis la source');
});

test('le réarmement du chien de garde n’est pas un effet de bord de rendu', () => {
  // Écrire une référence pendant le rendu fabrique une fermeture neuve à
  // chaque dessin de l'arbre — sur un écran redessiné à chaque relevé de
  // trafic, cela s'additionne.
  const contexte = lireSource('app-mobile/contexts/VpnContext.tsx');
  assert.match(contexte, /useEffect\(\(\) => \{\s*\n\s*rearmerWatchdogRef\.current = \(etape: string\) => \{/);
});

test('un relevé de trafic identique ne redessine rien', () => {
  // Le relevé tombe toutes les deux secondes. Reconstruire l'objet à chaque
  // fois changeait sa référence, donc celle du contexte, donc TOUS les écrans
  // abonnés se redessinaient — y compris quand aucun compteur n'avait bougé,
  // et précisément pendant que l'utilisateur essaie d'appuyer sur quelque
  // chose.
  const contexte = lireSource('app-mobile/contexts/VpnContext.tsx');
  assert.match(contexte, /setTrafficStats\(precedent => \{/);
  assert.match(contexte, /return identique \? precedent : suivant;/);
  // La comparaison porte sur TOUS les champs exposés : en oublier un ferait
  // disparaître une mise à jour réelle.
  for (const champ of [
    'uploadBytes', 'downloadBytes', 'uploadSpeed', 'downloadSpeed',
    'tunAttached', 'connectedSeconds', 'lifetimeUploadBytes', 'lifetimeDownloadBytes',
  ]) {
    assert.match(
      contexte,
      new RegExp(`precedent\\.${champ} === suivant\\.${champ}`),
      `le champ ${champ} doit entrer dans la comparaison`,
    );
  }
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

test('une attestation non configurée n’accuse personne', async () => {
  // C'est l'invariant le plus important de ce module. Le jour du déploiement,
  // aucun appareil du parc n'a encore été attesté : si « pas d'attestation »
  // valait « attestation refusée », tout le parc serait coupé d'un coup.
  const sortieAttestation = path.join(racine, 'backend', '.sxb-attestation-test.cjs');
  await build({
    entryPoints: [path.join(racine, 'server', 'services', 'play-integrity.ts')],
    outfile: sortieAttestation,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    logLevel: 'silent',
  });
  const attestation = require(sortieAttestation);
  try {
    delete process.env.PLAY_INTEGRITY_PACKAGE;
    delete process.env.PLAY_INTEGRITY_API_KEY;
    assert.equal(attestation.attestationConfiguree(), false);
    const resultat = await attestation.verifierAttestation('un-jeton-quelconque-assez-long');
    assert.equal(resultat.statut, 'not_configured');
    assert.equal(attestation.signalDepuisAttestation(resultat), false);
    // Une panne de Google ne vaut pas davantage un refus.
    assert.equal(attestation.signalDepuisAttestation({ statut: 'unavailable', raison: 'timeout' }), false);
    assert.equal(attestation.signalDepuisAttestation({ statut: 'valid', verdicts: {} }), false);
    assert.equal(attestation.signalDepuisAttestation({ statut: 'refused', raison: 'app_unrecognized' }), true);
  } finally {
    if (existsSync(sortieAttestation)) rmSync(sortieAttestation, { force: true });
  }
});

test('un jeton d’attestation ne devient jamais une alerte à lui seul', () => {
  const route = lireSource('server/routes/mobile-security.ts');
  // Le jeton est soumis à Google, dont le verdict seul compte : le serveur ne
  // fabrique pas de jugement local sur un jeton qu'il ne sait pas déchiffrer.
  assert.match(route, /verifierAttestation\(analyse\.data\.integrityToken\)/);
  assert.match(route, /signalDepuisAttestation\(resultat\)/);
  const service = lireSource('server/services/play-integrity.ts');
  // Une panne réseau rend « indisponible », jamais « refusé » : confondre les
  // deux ferait d'une coupure chez Google une vague de blocages chez nous.
  assert.match(service, /statut: 'unavailable', raison: erreur\?\.name === 'TimeoutError' \? 'timeout' : 'network'/);
  assert.match(service, /statut: 'unavailable', raison: `http_\$\{reponse\.status\}`/);
  // Le verdict doit concerner NOTRE paquet : un jeton valide émis pour une
  // autre application resterait cryptographiquement correct.
  assert.match(service, /package_mismatch/);
  // Aucune clé d'API ne doit être journalisée.
  assert.doesNotMatch(service, /console\.(log|warn|error)/);
});

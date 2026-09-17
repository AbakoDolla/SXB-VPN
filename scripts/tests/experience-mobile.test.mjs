/**
 * Expérience mobile — vitesse, journal sans secret, design partagé.
 *
 * CE QUI EST VÉRIFIÉ ICI
 * ──────────────────────
 * Le code source réel des écrans et du contexte. Ces invariants protègent des
 * régressions qu'aucun typage ne verrait : une attente réintroduite avant le
 * tunnel, une donnée sensible rendue dans le journal, un écran qui repart en
 * valeurs brutes.
 *
 * Les invariants tenus :
 *  • la vérification des droits ne barre plus la route au tunnel ;
 *  • le journal ne peut afficher que des clés de traduction ;
 *  • aucun hôte, aucune configuration, aucun secret ne peut y entrer ;
 *  • un basculement de profil se voit dès l'appui ;
 *  • connexion et tutoriel partagent le socle visuel de l'accueil.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lireSource = (relatif) => readFileSync(path.join(racine, relatif), 'utf8');

test('la vérification des droits ne barre plus la route au tunnel', () => {
  const contexte = lireSource('app-mobile/contexts/VpnContext.tsx');
  // Ces deux appels réseau étaient attendus avant la moindre étape, avec un
  // délai de garde de quatre secondes — sur un lien lent, plusieurs secondes
  // de rien avant que le tunnel ne commence.
  assert.match(contexte, /const verificationDroits = \(async \(\) => \{/);
  assert.match(contexte, /void verificationDroits;/);

  // L'invariant réel : les deux appels existent toujours — ils protègent — mais
  // à l'INTÉRIEUR de la fonction lancée en parallèle, jamais sur le chemin
  // direct de `connect()`. On le vérifie par les positions plutôt que par une
  // forme de texte, qui dépendrait des fins de ligne de la plateforme.
  const debutParallele = contexte.indexOf('const verificationDroits = (async () => {');
  const finParallele = contexte.indexOf('void verificationDroits;');
  const rafraichir = contexte.indexOf('await refreshAccessState(false, undefined, 4000)');
  const reconcilier = contexte.indexOf('await reconcileAccess()');
  assert.ok(debutParallele > -1 && finParallele > debutParallele, 'la vérification doit être lancée en parallèle');
  assert.ok(
    rafraichir > debutParallele && rafraichir < finParallele,
    'le rafraîchissement des droits doit rester dans la fonction parallèle',
  );
  assert.ok(
    reconcilier > debutParallele && reconcilier < finParallele,
    'la réconciliation doit rester dans la fonction parallèle',
  );
  // Et il n'en existe qu'une occurrence : aucune copie n'est restée sur le
  // chemin direct.
  assert.equal((contexte.match(/await refreshAccessState\(false, undefined, 4000\)/g) || []).length, 1);
});

test('les lectures locales de la connexion sont menées ensemble', () => {
  const contexte = lireSource('app-mobile/contexts/VpnContext.tsx');
  // Quota et expiration sont indépendants : les enchaîner ajoutait un
  // aller-retour de stockage juste avant l'ouverture du tunnel.
  assert.match(contexte, /const \[exhausted, expired\] = await Promise\.all\(\[isQuotaExhausted\(\), isConfigExpired\(\)\]\)/);
});

test('le journal ne peut afficher que des clés de traduction', () => {
  const journal = lireSource('app-mobile/app/journal.tsx');
  // Il ne lit QUE `stepLogs`, dont chaque entrée est une clé choisie dans le
  // code. Une fuite exigerait qu'on invente une clé contenant un secret, ce
  // qu'aucune donnée extérieure ne peut faire.
  assert.match(journal, /const \{ stepLogs \} = useVpnContext\(\)/);
  assert.match(journal, /t\(item\.translationKey as any\)/);

  // Aucune source de données brutes n'est lue par cet écran.
  for (const interdit of ['vpnConfig', 'activeConnection', 'logs', 'apiClient', 'configStore', 'host', 'dataToken']) {
    assert.ok(
      !new RegExp(`\\b${interdit}\\b`).test(journal),
      `le journal ne doit pas toucher à « ${interdit} »`,
    );
  }
});

test('un détail de journal qui n’est pas un code n’est jamais rendu', () => {
  const journal = lireSource('app-mobile/app/journal.tsx');
  // `detail` peut porter un code de diagnostic. Un texte libre y serait ignoré
  // plutôt qu'affiché : c'est la seule voie par laquelle une chaîne non
  // maîtrisée pourrait atteindre l'écran.
  assert.match(journal, /const CODE_SUR = \/\^\[A-Z\]\[A-Z0-9_\]\{2,31\}\$\//);
  assert.match(journal, /return CODE_SUR\.test\(detail\) \? detail : null/);
});

test('le journal annonce lui-même ce qu’il ne contient pas', () => {
  // L'utilisateur doit pouvoir le lire sans craindre d'y exposer ses serveurs.
  for (const langue of ['fr', 'en']) {
    const textes = lireSource(`app-mobile/localization/${langue}.ts`);
    assert.ok(textes.includes('journal_privacy_note:'), `${langue}: la note de confidentialité manque`);
    assert.ok(textes.includes('journal_title:'), `${langue}: le titre manque`);
    assert.ok(textes.includes('journal_empty_title:'), `${langue}: l’état vide manque`);
  }
});

test('le journal est atteignable depuis les paramètres', () => {
  const reglages = lireSource('app-mobile/app/settings.tsx');
  assert.match(reglages, /router\.push\('\/journal' as any\)/);
  // Le binding mort des anciens journaux bruts ne doit pas revenir.
  assert.doesNotMatch(reglages, /\n\s*logs, isConnected,/);
});

test('le journal est atteignable depuis le bouton de connexion', () => {
  // C'est là qu'on le cherche quand une connexion ne part pas : sous le bouton
  // qu'on vient d'appuyer, pas au fond des réglages.
  const accueil = lireSource('app-mobile/app/(tabs)/index.tsx');
  assert.match(accueil, /router\.push\('\/journal' as any\)/);
  assert.match(accueil, /accessibilityLabel=\{t\('journal_open'\)\}/);
  // Le bouton reste sous le bouton de connexion, jamais au-dessus : l'action
  // principale doit garder la première place.
  const appel = accueil.indexOf("router.push('/journal' as any)");
  const principal = accueil.indexOf('<PowerButton');
  assert.ok(principal > -1 && appel > principal, 'le journal doit venir après le bouton de connexion');
  // Et il respecte la cible tactile minimale.
  assert.match(accueil, /logsButton: \{[\s\S]{0,260}minHeight: 44/);
});

test('l’écran de lancement raconte quelque chose, et se termine', () => {
  const lancement = lireSource('app-mobile/app/index.tsx');
  // Les quatre temps de la séquence.
  assert.match(lancement, /const ondeUne = useRef/);
  assert.match(lancement, /const rotationArc = useRef/);
  assert.match(lancement, /const eclat = useRef/);
  assert.match(lancement, /const progression = useRef/);
  // Elle se TERMINE : les ondes sont bornées, la barre va au bout. Une boucle
  // infinie donnerait un écran qui attend au lieu de préparer.
  assert.match(lancement, /\{ iterations: 2 \}/);
  assert.match(lancement, /const DUREE_TOTALE_MS = 2100/);
  // La redirection est calée sur la séquence : elle n'est jamais coupée.
  assert.match(lancement, /setTimeout\(\(\) => router\.replace\(destination as any\), DUREE_TOTALE_MS\)/);
});

test('l’animation de lancement ne dépend pas du fil JavaScript', () => {
  const lancement = lireSource('app-mobile/app/index.tsx');
  // Une animation de lancement qui saccade donne le ton de toute
  // l'application, et c'est précisément l'instant où le fil JavaScript est le
  // plus occupé : polices, authentification, stockage.
  const pilotes = lancement.match(/useNativeDriver: (true|false)/g) || [];
  assert.ok(pilotes.length >= 8, 'chaque animation doit déclarer son pilote');
  assert.deepEqual(
    [...new Set(pilotes)],
    ['useNativeDriver: true'],
    'aucune animation ne doit repasser par le fil JavaScript',
  );
  // La barre s'anime en `scaleX`, jamais en `width` : la largeur animée n'est
  // pas confiable au pilote natif.
  assert.match(lancement, /scaleX: progression/);
  assert.doesNotMatch(lancement, /Animated\.timing\(\s*largeur/);
});

test('un basculement de profil se voit dès l’appui', () => {
  const contexte = lireSource('app-mobile/contexts/VpnContext.tsx');
  // La sélection ne changeait à l'écran qu'une fois toute la chaîne finie,
  // provisionnement réseau compris : l'utilisateur croyait son appui perdu.
  assert.match(contexte, /setSwitchingToId\(configId\);/);
  assert.match(contexte, /setIsSwitchingConfig\(false\); setSwitchingToId\(null\);/);
  // Mais on ne ment pas : la portée réelle ne bouge qu'une fois la
  // configuration prête.
  const corps = contexte.slice(contexte.indexOf('const switchConfig'), contexte.indexOf('const selectProtocol'));
  assert.ok(
    corps.indexOf('setSwitchingToId(configId)') < corps.indexOf('setActiveConfigId(configId)'),
    'la cible doit être annoncée avant que la portée réelle ne change',
  );

  const accueil = lireSource('app-mobile/app/(tabs)/index.tsx');
  assert.match(accueil, /const pendingConfig = switchingToId/);
  assert.match(accueil, /\{pendingConfig\?\.name \|\| activeConfig\?\.name/);
});

test('connexion et journal partagent le socle visuel de l’accueil', () => {
  // L'écran de connexion mêlait des rayons de 11, 12, 14, 15, 18, 24 et 28 px
  // là où l'accueil passe par l'échelle : les coins ne correspondaient pas
  // d'un écran à l'autre.
  const connexion = lireSource('app-mobile/app/activate.tsx');
  assert.match(connexion, /from "@\/constants\/theme"/);
  assert.match(connexion, /radius\.(sm|md|lg|xl|full)/);
  assert.match(connexion, /spacing\./);
  assert.match(connexion, /elevation\.md/);
  assert.doesNotMatch(connexion, /borderRadius: \d+/, 'aucun rayon brut ne doit subsister');

  const journal = lireSource('app-mobile/app/journal.tsx');
  assert.doesNotMatch(journal, /borderRadius: \d+/);
  assert.doesNotMatch(journal, /fontSize: \d+/);
});

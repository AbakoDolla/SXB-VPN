/**
 * Essai répétable, connexion qui n'attend plus pour rien.
 *
 * CE QUI EST VÉRIFIÉ ICI
 * ──────────────────────
 * Deux changements de règle demandés par le propriétaire, et les garde-fous
 * qui doivent survivre autour.
 *
 *  1. L'essai gratuit n'est plus « une seule fois par appareil ». Ce qui borne
 *     une campagne est le plafond du jeton d'invitation, qu'il maîtrise. Mais
 *     « répétable » ne doit pas devenir « incontrôlable » : chaque ligne dit
 *     combien de fois l'appareil a déjà été servi.
 *
 *  2. Le chien de garde de connexion ne mesure plus la durée TOTALE d'une
 *     tentative mais le SILENCE du moteur. C'est ce qui permet d'abandonner
 *     vite une connexion figée sans jamais couper une connexion lente qui
 *     progresse.
 */
import './register-hooks.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lireSource = (relatif) => readFileSync(path.join(racine, relatif), 'utf8');

test('l’essai gratuit est répétable', () => {
  const service = lireSource('server/services/free-trial.ts');
  const bloc = service.slice(
    service.indexOf('export function deciderInscriptionParEmpreinte'),
    service.indexOf('function horodatage'),
  );
  assert.ok(bloc.length > 0, 'la décision doit exister');
  // Plus aucun refus fondé sur un essai passé : c'était la règle « une seule
  // fois par appareil », que le propriétaire a retirée.
  assert.doesNotMatch(bloc, /refusEssaiDejaConsomme/);
  assert.match(bloc, /return \{ type: "autorise", essaisPrecedents \}/);
});

test('une demande en attente est toujours reprise, jamais dupliquée', () => {
  // Sans cela, un appui répété fabriquerait une file de demandes identiques
  // que l'exploitant devrait trier à la main.
  const service = lireSource('server/services/free-trial.ts');
  const bloc = service.slice(
    service.indexOf('export function deciderInscriptionParEmpreinte'),
    service.indexOf('function horodatage'),
  );
  assert.match(bloc, /if \(enAttente\.length\) return \{ type: "reprise", demande: enAttente\[0\] \}/);
  // La reprise est évaluée AVANT le décompte : une demande en cours ne doit
  // jamais se transformer en seconde demande.
  assert.ok(
    bloc.indexOf('type: "reprise"') < bloc.indexOf('essaisPrecedents ='),
    'la reprise doit primer sur le décompte',
  );
});

test('chaque ligne dit combien de fois l’appareil a été servi', () => {
  const routes = lireSource('server/routes/free-trial.ts');
  // Un agrégat unique pour toute la page : compter ligne par ligne produirait
  // autant de requêtes que de demandes affichées.
  assert.match(routes, /groupBy\(\{\s*\n\s*by: \['deviceFingerprint'\]/);
  assert.match(routes, /deviceTrialCount: essaisParEmpreinte\.get/);
  // L'empreinte elle-même ne sort jamais.
  assert.doesNotMatch(routes, /deviceFingerprint: demande\.deviceFingerprint/);

  const vue = lireSource('artifacts/sxb-dashboard/src/components/FreeTrialView.tsx');
  assert.match(vue, /demande\.deviceTrialCount \?\? 0\) > 1/);
  for (const langue of ['fr', 'en']) {
    const essai = JSON.parse(lireSource(`artifacts/sxb-dashboard/src/locales/${langue}/operations.json`)).freeTrial;
    assert.ok(essai.deviceTrialCount, `${langue}: libellé manquant`);
  }
});

test('la liste des comptes en essai est repliée par défaut', () => {
  const vue = lireSource('artifacts/sxb-dashboard/src/components/FreeTrialView.tsx');
  // Sur un téléphone, une liste de dizaines de comptes obligeait à faire
  // défiler tout l'écran avant d'atteindre quoi que ce soit d'autre.
  assert.match(vue, /const \[comptesDeplies, setComptesDeplies\] = useState\(false\)/);
  assert.match(vue, /aria-expanded=\{comptesDeplies\}/);
  // Le contenu ne se rend pas tant qu'il est replié.
  assert.match(vue, /\{comptesDeplies && !comptesEssaiEnCours/);
});

test('le chien de garde mesure le silence du moteur, pas la durée totale', () => {
  const contexte = lireSource('app-mobile/contexts/VpnContext.tsx');
  assert.match(contexte, /const DELAI_SANS_SIGNE_MS = 45_000/);
  // Il est réarmé sur un progrès : c'est ce qui rend un délai court sûr.
  assert.match(contexte, /rearmerWatchdogRef\.current\?\.\('HANDSHAKE'\)/);
  assert.match(contexte, /const rearmerWatchdogRef = useRef/);
  // Un réarmement ne doit jamais ressusciter un chien de garde déjà désarmé.
  assert.match(contexte, /if \(!watchdogRef\.current\) return;/);
  // L'ancienne valeur, armée une seule fois pour toute la connexion, ne doit
  // pas revenir.
  assert.doesNotMatch(contexte, /}, 90_000\);/);
});

test('les préparatifs de connexion sont menés ensemble', () => {
  const contexte = lireSource('app-mobile/contexts/VpnContext.tsx');
  // Relevé des compteurs, préparation de l'accès et relecture du profil sont
  // indépendants : les enchaîner retardait l'ouverture du tunnel pour rien.
  assert.match(contexte, /const \[stats, currentProfile\] = await Promise\.all\(\[/);
  assert.match(contexte, /SxbVpnNative\.getTrafficStats\(\)\.catch\(\(\) => null\)/);
  // Le relevé de compteurs ne doit pas pouvoir faire échouer une connexion.
  assert.match(contexte, /sessionBaselineRef\.current = \{ up: stats\?\.uploadBytes \|\| 0/);
});

test('les écrans partagent l’échelle du système de design', () => {
  // L'application mêlait des rayons de 8 à 32 px et des espacements libres
  // selon l'écran : les coins et le rythme vertical ne correspondaient pas
  // d'un écran à l'autre. Chaque écran refait ici doit passer par l'échelle.
  const ecrans = [
    'app-mobile/app/settings.tsx',
    'app-mobile/app/free-trial.tsx',
    'app-mobile/app/support.tsx',
    'app-mobile/app/plan.tsx',
    'app-mobile/app/access-blocked.tsx',
    'app-mobile/components/UpdatePrompt.tsx',
    'app-mobile/components/AppLockGate.tsx',
    'app-mobile/components/AnnouncementModal.tsx',
    'app-mobile/components/HistoryCard.tsx',
    'app-mobile/components/PrivacyDisclosure.tsx',
    'app-mobile/components/ErrorFallback.tsx',
    'app-mobile/components/AccessNotices.tsx',
  ];
  for (const ecran of ecrans) {
    const source = lireSource(ecran);
    assert.match(source, /from ["']@\/constants\/theme["']/, `${ecran} doit lire les jetons`);
    assert.match(source, /radius\.|spacing\./, `${ecran} doit utiliser l'échelle`);
    // Aucun rayon brut de carte ou de bouton. Le seuil bas exclut les rayons
    // décoratifs — un point de 8 px, une barre de progression — dont la forme
    // ne relève pas de l'échelle ; le seuil haut exclut les cercles, dont le
    // rayon vaut la moitié du côté.
    const bruts = [...source.matchAll(/borderRadius: (\d+)\b/g)]
      .map((m) => Number(m[1]))
      .filter((valeur) => valeur >= 8 && valeur < 40);
    assert.deepEqual(bruts, [], `${ecran} garde des rayons bruts : ${bruts.join(', ')}`);
  }
});

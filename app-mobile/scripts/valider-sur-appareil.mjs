#!/usr/bin/env node
/**
 * valider-sur-appareil — harnais de validation §17.5 sur téléphone réel.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CE HARNAIS RÉSOUT, ET CE QU'IL NE RÉSOUT PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * Aucun tunnel réel n'a jamais été établi pour ce moteur : ni appareil, ni SDK,
 * ni serveur de test n'étaient disponibles. La suite de tests passe, et ce vert
 * ne prouve rien du comportement sur un téléphone. §17.4 le dit, et ce fichier
 * ne le contredit pas : il ne remplace pas la validation, il la REND PLUS
 * RAPIDE et surtout MESURABLE.
 *
 * Ce qu'il apporte, concrètement : la procédure §17.5 demandait à un opérateur
 * de regarder un écran et de juger. Un œil humain qui « voit Connecté » ne peut
 * pas dire si l'application avait le droit de l'afficher. Le harnais confronte
 * donc DEUX sources :
 *
 *   1. la trace réelle du service natif, capturée par `adb logcat` ;
 *   2. ce que l'opérateur a RÉELLEMENT vu à l'écran, qu'il déclare.
 *
 * C'est le désaccord entre les deux qui est intéressant. Une application qui
 * affiche « Connecté » alors que le service n'a jamais émis de preuve
 * d'acheminement, c'est exactement le défaut que cette mission corrigeait. Sans
 * confrontation, ce défaut est invisible : l'écran est convaincant, et c'est
 * précisément le problème.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE LE JOURNAL PEUT PROUVER, ET CE QU'IL NE PEUT PAS
 * ═══════════════════════════════════════════════════════════════════════════
 * Le journal prouve qu'un MÉCANISME a été appliqué. Il ne prouve jamais son
 * EFFET sur le réseau. « Kill Switch actif — trafic bloqué » établit que
 * l'interface trou noir a été posée ; il n'établit pas qu'aucun octet ne sort.
 * Seule une mesure hors journal le fait.
 *
 * Ces critères-là sont donc marqués `À MESURER HORS JOURNAL` et exigent une
 * déclaration explicite de l'opérateur. Ils ne passent JAMAIS au vert tout
 * seuls. Un harnais qui conclurait « Kill Switch vérifié » sur la seule foi
 * d'une ligne de journal rejouerait, en plus discret, la faute qu'il est censé
 * détecter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TROIS VERDICTS, ET « NON OBSERVÉ » N'EST PAS UNE RÉUSSITE
 * ═══════════════════════════════════════════════════════════════════════════
 *   ÉTABLI      — la preuve attendue est présente dans la capture.
 *   CONTREDIT   — la capture dit le contraire de ce qui est attendu.
 *   NON OBSERVÉ — la preuve est absente. Ce n'est PAS un succès : c'est
 *                 l'aveu qu'on ne sait pas. Le code de sortie le reflète.
 *
 * Usage :
 *   node scripts/valider-sur-appareil.mjs preparer [--apk <chemin>]
 *   node scripts/valider-sur-appareil.mjs capturer --sortie <fichier>
 *   node scripts/valider-sur-appareil.mjs analyser --capture <f> --point <n> [déclarations]
 *   node scripts/valider-sur-appareil.mjs grille
 *
 * Points et déclarations attendues :
 *   4   « Tunnel établi » apparaît        --tunnel-affiche <oui|non>
 *   5   pas de connected sans preuve      --affiche-connecte <oui|non>
 *   5b  identifiants faux → échec         --affiche-connecte <oui|non>
 *   6   réseau coupé → TUNNEL_STALLED     --etat-quitte <oui|non>
 *   7   Kill Switch actif → rien ne sort  --trafic-passe <oui|non>
 *   8   Kill Switch levé → internet revenu --internet-revenu <oui|non>
 *   9   journal partagé sans fuite        --relecture-ok <oui|non>
 */

import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = resolve(ICI, '..');

/** Étiquettes logcat réellement émises par le service. Rien d'inventé ici. */
export const ETIQUETTES = ['SXB-VPN', 'SXB', 'SXB-TrafficStats', 'SXB-HostKey'];

// ── Marqueurs réels, relevés dans SxbVpnService.kt ──────────────────────────
//
// Chaque motif ci-dessous correspond à une ligne que le service émet vraiment.
// Aucun n'est supposé : ils ont été lus dans le code natif, et la référence
// est donnée pour que le prochain lecteur puisse la recouper sans me croire.

const M = {
  // trace("TUN_CREATED", …) — l'interface VPN est ouverte.
  tunCree: /\[SXB_TRACE\][^\n]*\bstage=TUN_CREATED\b/,
  // trace("TUNNEL_TRAFFIC_CONFIRMED", "proof=… bytes=…") — émis par
  // promoteToConnected(), juste avant le seul setCurrentState("connected")
  // du service. C'est LA preuve d'acheminement.
  preuveTrafic: /\[SXB_TRACE\][^\n]*\bstage=TUNNEL_TRAFFIC_CONFIRMED\b[^\n]*/,
  preuveType: /\bproof=([A-Z_]+)\b/,
  preuveOctets: /\bbytes=(\d+)\b/,
  // trace("VPN_FAILED", "code=… state=…")
  echec: /\[SXB_TRACE\][^\n]*\bstage=VPN_FAILED\b[^\n]*/,
  echecStalled: /\[SXB_TRACE\][^\n]*\bstage=VPN_FAILED\b[^\n]*\bcode=TUNNEL_STALLED\b/,
  // broadcastLog("[SXB] Kill Switch : activé|désactivé")
  ksRegle: /\[SXB\] Kill Switch : (activé|désactivé)/,
  // broadcastLog("[SXB] ⛔ Kill Switch actif — trafic bloqué (…)")
  ksPose: /\[SXB\][^\n]*Kill Switch actif[^\n]*trafic bloqué/,
  // Log.w(TAG, "[SXB_DEBUG] KILL_SWITCH_BLACKHOLE_FAILED reason=…")
  ksEchoue: /KILL_SWITCH_BLACKHOLE_FAILED/,
  // Log.i(TAG, "[SXB_DEBUG] KILL_SWITCH_BLACKHOLE_RELEASED")
  ksLeve: /KILL_SWITCH_BLACKHOLE_RELEASED/,
};

/** Preuves d'acheminement qui valent vraiment un octet observé. */
const PREUVES_MESUREES = ['TUN_RX', 'SSH_RELAY_RX'];

/**
 * Formes qu'un journal partagé ne doit JAMAIS porter (§17.5 point 9).
 *
 * On cherche des FORMES, pas des valeurs connues : exiger de l'opérateur qu'il
 * saisisse l'adresse de son serveur pour la chercher reviendrait à l'écrire
 * dans un historique de commandes. Une forme suffit, et elle attrape aussi ce
 * qu'on n'avait pas prévu.
 */
const FUITES = {
  'adresse IPv4': /\b(?!0\.0\.0\.0\b)(?!127\.0\.0\.1\b)(?!10\.63\.63\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/,
  'nom d’hôte': /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|dev|xyz|me|co|fr|info|top|site|online|app|cloud|vpn)\b/i,
  'identifiant dans une URL': /\b\w+:\/\/[^\s/@]+:[^\s/@]+@/,
  'clé privée': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  'jeton long': /\b[A-Za-z0-9_-]{40,}\b/,
};

const ETABLI = 'ÉTABLI';
const CONTREDIT = 'CONTREDIT';
const NON_OBSERVE = 'NON OBSERVÉ';
const HORS_JOURNAL = 'À MESURER HORS JOURNAL';

const critere = (id, libelle, verdict, preuve = '') => ({ id, libelle, verdict, preuve });

/** Première ligne de la capture qui satisfait un motif — la preuve citée. */
const trouver = (lignes, motif) => lignes.find((l) => motif.test(l)) ?? '';

/**
 * Confronte une déclaration de l'opérateur à ce que dit la capture.
 *
 * `attendu` vaut 'oui' ou 'non'. Une déclaration absente ne vaut jamais
 * réussite : elle rend `NON OBSERVÉ`, parce que personne n'a regardé.
 */
function declaration(id, libelle, valeur, attendu) {
  if (valeur === undefined || valeur === null || valeur === '') {
    return critere(id, libelle, NON_OBSERVE, 'aucune déclaration de l’opérateur');
  }
  const v = String(valeur).toLowerCase();
  if (v !== 'oui' && v !== 'non') {
    return critere(id, libelle, NON_OBSERVE, `déclaration illisible : « ${valeur} »`);
  }
  return v === attendu
    ? critere(id, libelle, ETABLI, `déclaré : ${v}`)
    : critere(id, libelle, CONTREDIT, `déclaré : ${v}, attendu : ${attendu}`);
}

/**
 * Cœur du harnais — analyse une capture réelle pour un point de §17.5.
 *
 * Fonction pure : elle ne lit ni fichier ni appareil. C'est ce qui permet de
 * prouver, par des tests, qu'elle sait ÉCHOUER — un contrôle qu'on n'a jamais
 * vu refuser ne garantit rien.
 */
export function analyserCapture(texte, point, declare = {}) {
  const lignes = String(texte).split(/\r?\n/).filter((l) => l.trim() !== '');
  const criteres = [];

  if (lignes.length === 0) {
    return {
      point,
      criteres: [critere('capture', 'La capture contient des traces', NON_OBSERVE, 'capture vide')],
      verdict: NON_OBSERVE,
    };
  }

  const aTrace = lignes.some((l) => /\[SXB_TRACE\]|\[SXB\]|\[SXB_DEBUG\]/.test(l));

  // Le point 9 n'analyse pas une capture logcat mais le TEXTE PARTAGÉ depuis
  // l'application. Il est donc traité avant le garde ci-dessous, qui exige des
  // lignes de service.
  if (String(point) === '9') {
    const fuites = [];
    for (const l of lignes) {
      for (const [quoi, motif] of Object.entries(FUITES)) {
        const m = l.match(motif);
        if (m) fuites.push(`${quoi} : « ${m[0].slice(0, 80)} »`);
      }
    }
    criteres.push(fuites.length === 0
      ? critere('fuite', 'Le texte partagé ne porte ni adresse ni identifiant', ETABLI,
        `${lignes.length} lignes inspectées, aucune forme sensible`)
      : critere('fuite', 'Le texte partagé ne porte ni adresse ni identifiant', CONTREDIT,
        fuites.slice(0, 5).join(' | ')));
    criteres.push(declaration('relecture',
      'L’opérateur a relu le texte partagé et n’y voit ni serveur ni identifiant',
      declare.relectureOk, 'oui'));
    const v9 = criteres.some((c) => c.verdict === CONTREDIT) ? CONTREDIT
      : criteres.every((c) => c.verdict === ETABLI) ? ETABLI : NON_OBSERVE;
    return { point, criteres, verdict: v9 };
  }

  if (!aTrace) {
    return {
      point,
      criteres: [
        critere('capture', 'La capture contient des traces du service', CONTREDIT,
          'aucune ligne SXB : mauvaise étiquette logcat, ou service jamais démarré'),
      ],
      verdict: CONTREDIT,
    };
  }

  const ligneTun = trouver(lignes, M.tunCree);
  const lignePreuve = trouver(lignes, M.preuveTrafic);
  const ligneEchec = trouver(lignes, M.echec);

  switch (String(point)) {
    // ── 4. « Tunnel établi » apparaît — c'est la trace qui était muette ────
    case '4':
      criteres.push(ligneTun
        ? critere('tun', 'L’interface TUN est ouverte (stage=TUN_CREATED)', ETABLI, ligneTun)
        : critere('tun', 'L’interface TUN est ouverte (stage=TUN_CREATED)', NON_OBSERVE));
      criteres.push(declaration('ecran', 'Le journal de l’app affiche « Tunnel établi »',
        declare.tunnelAffiche, 'oui'));
      break;

    // ── 5. Aucun « connected » annoncé avant un octet reçu ────────────────
    case '5': {
      const vuConnecte = String(declare.afficheConnecte ?? '').toLowerCase();
      if (lignePreuve) {
        const type = lignePreuve.match(M.preuveType)?.[1] ?? '?';
        const octets = Number(lignePreuve.match(M.preuveOctets)?.[1] ?? '0');
        if (PREUVES_MESUREES.includes(type) && octets > 0) {
          criteres.push(critere('preuve',
            `Preuve d’acheminement mesurée (${type}, ${octets} o)`, ETABLI, lignePreuve));
        } else if (type === 'PRESUMED_UNMEASURABLE') {
          // Voie prévue par le service quand les compteurs noyau sont
          // illisibles. Elle n'est pas une fraude, mais elle n'est pas une
          // mesure : la distinguer est tout l'objet de cette mission.
          criteres.push(critere('preuve',
            'Preuve PRÉSUMÉE — compteurs illisibles, aucun octet mesuré', HORS_JOURNAL,
            `${lignePreuve}  → exige une confirmation de navigation réelle`));
        } else {
          criteres.push(critere('preuve',
            `Preuve d’acheminement faible (${type}, ${octets} o)`, CONTREDIT, lignePreuve));
        }
      } else {
        criteres.push(critere('preuve', 'Preuve d’acheminement émise par le service',
          NON_OBSERVE, 'aucun stage=TUNNEL_TRAFFIC_CONFIRMED'));
      }

      // LA confrontation. Un « Connecté » à l'écran sans preuve au journal
      // est le défaut que cette mission corrigeait, revenu.
      if (vuConnecte === 'oui' && !lignePreuve) {
        criteres.push(critere('confrontation',
          'L’écran n’annonce « Connecté » qu’après une preuve', CONTREDIT,
          'l’app a affiché « Connecté » alors que le service n’a émis AUCUNE preuve — régression du faux connected'));
      } else if (vuConnecte === 'non' && lignePreuve) {
        criteres.push(critere('confrontation',
          'L’écran reflète l’état du service', CONTREDIT,
          'le service a prouvé l’acheminement mais l’écran ne l’a pas montré'));
      } else if (vuConnecte === 'oui' || vuConnecte === 'non') {
        criteres.push(critere('confrontation',
          'L’écran et le journal concordent', ETABLI, `écran : ${vuConnecte}`));
      } else {
        criteres.push(critere('confrontation', 'L’écran et le journal concordent',
          NON_OBSERVE, 'aucune déclaration de l’opérateur'));
      }
      break;
    }

    // ── 5b. Serveur joignable, identifiants faux → échec, jamais réussite ──
    case '5b':
      criteres.push(ligneEchec
        ? critere('echec', 'Le service signale un échec (stage=VPN_FAILED)', ETABLI, ligneEchec)
        : critere('echec', 'Le service signale un échec (stage=VPN_FAILED)', NON_OBSERVE));
      criteres.push(lignePreuve
        ? critere('pas_de_preuve', 'Aucune preuve d’acheminement n’est émise', CONTREDIT, lignePreuve)
        : critere('pas_de_preuve', 'Aucune preuve d’acheminement n’est émise', ETABLI,
          'aucun stage=TUNNEL_TRAFFIC_CONFIRMED, conforme'));
      criteres.push(declaration('ecran', 'L’écran signale un échec, jamais une réussite',
        declare.afficheConnecte, 'non'));
      break;

    // ── 6. Réseau coupé en session → TUNNEL_STALLED, pas un état figé ─────
    case '6': {
      const stalled = trouver(lignes, M.echecStalled);
      criteres.push(stalled
        ? critere('stalled', 'Le tunnel muet est détecté (code=TUNNEL_STALLED)', ETABLI, stalled)
        : critere('stalled', 'Le tunnel muet est détecté (code=TUNNEL_STALLED)', NON_OBSERVE,
          ligneEchec ? `échec d’un autre code : ${ligneEchec}` : 'aucun VPN_FAILED'));
      criteres.push(declaration('ecran', 'L’écran quitte l’état « connecté »',
        declare.etatQuitte, 'oui'));
      break;
    }

    // ── 7. Kill Switch activé en session, VPN coupé → aucun trafic ────────
    case '7':
      criteres.push(trouver(lignes, M.ksRegle)
        ? critere('reglage', 'Le réglage atteint le service vivant', ETABLI, trouver(lignes, M.ksRegle))
        : critere('reglage', 'Le réglage atteint le service vivant', NON_OBSERVE,
          'aucun « [SXB] Kill Switch : … » — le réglage n’a pas été transmis'));

      if (trouver(lignes, M.ksEchoue)) {
        criteres.push(critere('pose', 'L’interface de blocage est posée', CONTREDIT,
          `${trouver(lignes, M.ksEchoue)}  → l’app promet un blocage qu’elle n’applique pas`));
      } else {
        criteres.push(trouver(lignes, M.ksPose)
          ? critere('pose', 'L’interface de blocage est posée', ETABLI, trouver(lignes, M.ksPose))
          : critere('pose', 'L’interface de blocage est posée', NON_OBSERVE));
      }

      // L'effet réseau ne se lit pas dans un journal. Jamais.
      criteres.push(declaration('effet',
        'AUCUN trafic ne sort (mesuré hors app : navigateur, ping)',
        declare.traficPasse, 'non'));
      break;

    // ── 8. Kill Switch désactivé en session bloquée → internet revient ────
    case '8':
      criteres.push(trouver(lignes, M.ksLeve)
        ? critere('levee', 'L’interface de blocage est retirée', ETABLI, trouver(lignes, M.ksLeve))
        : critere('levee', 'L’interface de blocage est retirée', NON_OBSERVE,
          'aucun KILL_SWITCH_BLACKHOLE_RELEASED'));
      criteres.push(declaration('effet',
        'L’internet revient (mesuré hors app : navigateur, ping)',
        declare.internetRevenu, 'oui'));
      break;

    default:
      return {
        point,
        criteres: [critere('point', 'Point de §17.5 connu', CONTREDIT,
          `« ${point} » n’est pas un point traité — attendus : 4, 5, 5b, 6, 7, 8, 9`)],
        verdict: CONTREDIT,
      };
  }

  // Un seul critère non établi suffit à refuser la conclusion. Le pire
  // verdict l'emporte : on ne moyenne pas des preuves.
  const verdict = criteres.some((c) => c.verdict === CONTREDIT) ? CONTREDIT
    : criteres.every((c) => c.verdict === ETABLI) ? ETABLI
      : NON_OBSERVE;

  return { point, criteres, verdict };
}

// ═══════════════════════════════════════════════════════════════════════════
// Interface en ligne de commande
// ═══════════════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const opt = (nom, defaut = undefined) => {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : defaut;
};

function adb(...a) {
  return spawnSync('adb', a, { encoding: 'utf8' });
}

function exigerUnAppareil() {
  const r = adb('devices');
  if (r.error) {
    console.error('✖ `adb` est introuvable. Installez les outils de plateforme Android.');
    process.exit(2);
  }
  const appareils = (r.stdout || '').split('\n').slice(1)
    .map((l) => l.trim()).filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0]);
  if (appareils.length === 0) {
    console.error('✖ Aucun appareil autorisé. Branchez le téléphone et acceptez le débogage USB.');
    process.exit(2);
  }
  if (appareils.length > 1) {
    console.error(`✖ ${appareils.length} appareils connectés. Laissez-en un seul : ${appareils.join(', ')}`);
    process.exit(2);
  }
  return appareils[0];
}

function preparer() {
  const appareil = exigerUnAppareil();
  const apk = resolve(RACINE, opt('apk', 'build/sxb-vpn.apk'));
  if (!existsSync(apk)) {
    console.error(`✖ APK introuvable : ${apk}`);
    console.error('  Construisez-la d’abord, ou indiquez son chemin avec --apk.');
    process.exit(2);
  }
  console.log(`Appareil : ${appareil}`);
  console.log(`APK      : ${apk}`);

  const pose = adb('install', '-r', apk);
  if ((pose.stdout || '').includes('Success')) {
    console.log('✔ APK posée.');
  } else {
    console.error('✖ Pose refusée :');
    console.error((pose.stderr || pose.stdout || '').trim());
    process.exit(1);
  }

  adb('logcat', '-c');
  console.log('✔ Journal de l’appareil vidé.');
  console.log('\nÉtape suivante :');
  console.log('  node scripts/valider-sur-appareil.mjs capturer --sortie point4.log');
}

function capturer() {
  const appareil = exigerUnAppareil();
  const sortie = opt('sortie');
  if (!sortie) {
    console.error('✖ Indiquez le fichier de sortie : --sortie point4.log');
    process.exit(2);
  }
  adb('logcat', '-c');
  console.log(`Appareil : ${appareil}`);
  console.log(`Capture  : ${resolve(process.cwd(), sortie)}`);
  console.log('\nMenez le scénario sur le téléphone. Ctrl-C pour arrêter la capture.\n');

  const flux = createWriteStream(resolve(process.cwd(), sortie));
  const p = spawn('adb', ['logcat', '-v', 'time', ...ETIQUETTES.map((e) => `${e}:V`), '*:S']);
  p.stdout.pipe(flux);
  p.stdout.pipe(process.stdout);
  const arreter = () => { p.kill(); flux.end(); console.log('\n✔ Capture close.'); process.exit(0); };
  process.on('SIGINT', arreter);
}

function analyser() {
  const chemin = opt('capture');
  const point = opt('point');
  if (!chemin || !point) {
    console.error('✖ Usage : analyser --capture <fichier> --point <4|5|5b|6|7|8|9> [déclarations]');
    process.exit(2);
  }
  const abs = resolve(process.cwd(), chemin);
  if (!existsSync(abs)) {
    console.error(`✖ Capture introuvable : ${abs}`);
    process.exit(2);
  }

  const r = analyserCapture(readFileSync(abs, 'utf8'), point, {
    tunnelAffiche: opt('tunnel-affiche'),
    afficheConnecte: opt('affiche-connecte'),
    etatQuitte: opt('etat-quitte'),
    traficPasse: opt('trafic-passe'),
    internetRevenu: opt('internet-revenu'),
    relectureOk: opt('relecture-ok'),
  });

  const icone = { [ETABLI]: '✔', [CONTREDIT]: '✖', [NON_OBSERVE]: '?', [HORS_JOURNAL]: '⚠' };
  console.log(`\n§17.5 — point ${r.point}   (capture : ${abs})\n`);
  for (const c of r.criteres) {
    console.log(`  ${icone[c.verdict] ?? '?'} ${c.verdict.padEnd(22)} ${c.libelle}`);
    if (c.preuve) console.log(`      ${c.preuve.slice(0, 200)}`);
  }
  console.log(`\n  VERDICT : ${r.verdict}`);
  if (r.verdict !== ETABLI) {
    console.log('  « NON OBSERVÉ » n’est pas une réussite : la preuve manque, on ne conclut pas.');
  }
  process.exit(r.verdict === ETABLI ? 0 : 1);
}

function grille() {
  console.log(readFileSync(resolve(RACINE, '..', 'docs', 'validation-appareil.md'), 'utf8'));
}

const commande = args[0];
// Le bloc ci-dessous ne doit s'exécuter QUE si ce fichier est lancé
// directement. Sans ce garde, l'importer depuis un test déclencherait son
// interface en ligne de commande — et `process.exit()` couperait la suite.
const lanceDirectement = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (lanceDirectement) {
  if (commande === 'preparer') preparer();
  else if (commande === 'capturer') capturer();
  else if (commande === 'analyser') analyser();
  else if (commande === 'grille') grille();
  else if (commande) { console.error(`✖ Commande inconnue : ${commande}`); process.exit(2); }
  else {
    // Le fichier est en CRLF : on normalise avant de découper, sinon le `\r`
    // résiduel empêche les ancres `$` de retirer les marqueurs de commentaire.
    const lignes = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n').split('\n');
    const fin = lignes.findIndex((l) => l.trim() === '*/');
    console.log(lignes.slice(1, fin === -1 ? 58 : fin)
      .map((l) => l.replace(/^\s*\/\*\*$/, '').replace(/^ \* ?/, '')).join('\n'));
  }
}

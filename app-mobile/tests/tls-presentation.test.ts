/**
 * L'échelle de présentation TLS — « ça marche dans HTTP Custom, pas chez nous ».
 *
 * LE CAS RÉEL, tel qu'il est arrivé :
 *
 *   Un client ne parvient pas à monter le tunnel avec une configuration qui
 *   fonctionne chez l'exploitant et chez d'autres clients. Sur SON téléphone,
 *   la MÊME configuration fonctionne dans une autre application. Le JSON
 *   extrait de cette application est instructif par ce qu'il NE contient PAS :
 *   aucune empreinte TLS, aucune liste ALPN. Notre moteur, lui, imposait les
 *   deux — un ClientHello qui se présente comme Chrome tout en annonçant une
 *   liste ALPN que Chrome n'envoie jamais.
 *
 *   La configuration n'était donc pas en cause : la POIGNÉE DE MAIN l'était.
 *   Et comme l'application n'avait qu'une seule façon de se présenter, un
 *   réseau qui la refusait la refusait pour toujours.
 *
 * Ces contrôles lisent le VRAI module et le VRAI code natif.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ALPN_DEDUIT,
  DERNIER_ESSAI,
  ECHECS_DE_PRESENTATION,
  ECHELLE_TLS,
  EMPREINTE_AUCUNE,
  appliquerPresentationTls,
  echelleApplicable,
  essaiSuivant,
  presentationPourEssai,
  refusDePresentation,
} from '../services/tlsPresentation';
import { parseVlessUri } from '../services/vlessUri';

const mobile = path.resolve(__dirname, '..');
const lire = (relative: string) => readFileSync(path.join(mobile, relative), 'utf8');

/** La configuration exacte fournie par l'exploitant, telle qu'elle est importée. */
const PROFIL = parseVlessUri(
  'vless://ae446a7b-9988-4353-80c7-050a915e1a1e@crashlyticsreports-pa.googleapis.com:443'
  + '?path=%2F%40stuff006&security=tls&encryption=none'
  + '&host=stuffm-cloud-run-proxy-1023926914988.europe-west1.run.app&fp=chrome&type=ws'
  + '&sni=crashlyticsreports-pa.googleapis.com#websocket-coldplay',
).config;

describe('échelle de présentation TLS', () => {
  it('laisse le premier essai STRICTEMENT identique au profil', () => {
    // Garantie de non-régression : qui se connecte aujourd'hui se connecte
    // toujours, avec exactement la même poignée de main.
    const presente = appliquerPresentationTls(PROFIL, 0);
    assert.deepEqual(presente, PROFIL);
    assert.equal(presentationPourEssai(0).cle, 'profil');
  });

  it('retire d’abord l’ALPN que nous avons déduit, et lui seul', () => {
    assert.equal(PROFIL.alpn, ALPN_DEDUIT, 'le profil reçoit bien notre ALPN déduit');
    const presente = appliquerPresentationTls(PROFIL, 1);
    assert.equal('alpn' in presente, false, 'l’ALPN déduit disparaît');
    // Tout le reste est intact : ni l’adresse, ni le nom présenté, ni
    // l’en-tête Host, ni l’empreinte ne bougent à cet échelon.
    assert.equal(presente.host, PROFIL.host);
    assert.equal(presente.sni, PROFIL.sni);
    assert.equal(presente.wsHost, PROFIL.wsHost);
    assert.equal(presente.fingerprint, 'chrome');
    assert.equal(presentationPourEssai(1).cle, 'sans_alpn');
  });

  it('cesse ensuite d’usurper une empreinte — la présentation d’un client ordinaire', () => {
    const presente = appliquerPresentationTls(PROFIL, 2);
    assert.equal('alpn' in presente, false);
    assert.equal(presente.fingerprint, EMPREINTE_AUCUNE);
    assert.equal('fragment' in presente, false, 'pas encore fragmenté à cet échelon');
    assert.equal(presentationPourEssai(2).cle, 'sans_empreinte');
  });

  it('fragmente l’enregistrement TLS quand même l’empreinte ordinaire est refusée', () => {
    // Avant-dernier recours : le ClientHello reste celui d'un client ordinaire,
    // mais on le découpe pour dérouter les sondes qui matchent sur sa forme
    // brute — le mécanisme que HTTP Injector expose sous « Fragments de
    // paquets ».
    const presente = appliquerPresentationTls(PROFIL, 3);
    assert.equal('alpn' in presente, false);
    assert.equal(presente.fingerprint, EMPREINTE_AUCUNE);
    assert.equal(presente.fragment, true);
    assert.equal('fragmentComplet' in presente, false, 'pas encore renforcé à cet échelon');
    assert.equal(presentationPourEssai(3).cle, 'avec_fragment');
  });

  it('renforce enfin la fragmentation quand `record_fragment` seul ne suffit toujours pas', () => {
    // Dernier recours : en plus de `record_fragment`, on segmente aussi le
    // ClientHello au niveau TCP (`fragment` côté moteur) — exactement l'ordre
    // que la documentation officielle de sing-box recommande.
    const presente = appliquerPresentationTls(PROFIL, 4);
    assert.equal('alpn' in presente, false);
    assert.equal(presente.fingerprint, EMPREINTE_AUCUNE);
    assert.equal(presente.fragment, true);
    assert.equal(presente.fragmentComplet, true);
    assert.equal(presentationPourEssai(4).cle, 'avec_fragment_fort');
    assert.equal(DERNIER_ESSAI, 4);
  });

  it('ne pose `fragment` qu’aux deux derniers échelons, et `fragmentComplet` qu’au tout dernier', () => {
    for (let essai = 0; essai < DERNIER_ESSAI - 1; essai++) {
      assert.equal('fragment' in appliquerPresentationTls(PROFIL, essai), false, `essai ${essai}`);
    }
    for (let essai = 0; essai < DERNIER_ESSAI; essai++) {
      assert.equal('fragmentComplet' in appliquerPresentationTls(PROFIL, essai), false, `essai ${essai}`);
    }
  });

  it('boucle depuis n’importe quel rang, mais n’essaie chaque présentation qu’une fois', () => {
    // La présentation retenue la fois précédente peut être élevée : si
    // l'échelle ne savait que descendre, cette mémoire deviendrait une impasse
    // le jour où le téléphone change de réseau.
    assert.equal(essaiSuivant(PROFIL, 0, 0), 1);
    assert.equal(essaiSuivant(PROFIL, 1, 1), 2);
    assert.equal(essaiSuivant(PROFIL, 2, 2), 3);
    assert.equal(essaiSuivant(PROFIL, 3, 3), 4);
    assert.equal(essaiSuivant(PROFIL, 4, 0), 0, 'depuis le dernier rang, on revient au profil');
    assert.equal(essaiSuivant(PROFIL, 1, 0), 2);

    // Et le budget borne le cycle : cinq présentations au plus, jamais de
    // ronde sans fin sur un réseau qui refuse tout.
    assert.equal(essaiSuivant(PROFIL, 0, DERNIER_ESSAI), null);
    assert.equal(essaiSuivant(PROFIL, 2, 99), null);

    // Un cycle complet parcourt bien les cinq présentations, sans répétition.
    let rang = 4;
    const vus = new Set<number>([rang]);
    for (let tentes = 0; ; tentes++) {
      const suivant = essaiSuivant(PROFIL, rang, tentes);
      if (suivant === null) break;
      rang = suivant;
      vus.add(rang);
    }
    assert.equal(vus.size, ECHELLE_TLS.length, 'chaque présentation est essayée exactement une fois');
  });

  it('ne touche JAMAIS un ALPN choisi par l’exploitant', () => {
    const impose = { ...PROFIL, alpn: 'h2' };
    for (let essai = 0; essai <= DERNIER_ESSAI; essai++) {
      assert.equal(appliquerPresentationTls(impose, essai).alpn, 'h2');
    }
    // Une liste explicite, même contenant http/1.1, reste un choix : elle survit.
    const liste = { ...PROFIL, alpn: 'h2,http/1.1' };
    assert.equal(appliquerPresentationTls(liste, DERNIER_ESSAI).alpn, 'h2,http/1.1');
  });

  it('ne désactive JAMAIS la vérification du certificat', () => {
    // D'autres clients posent `allowInsecure: true` par défaut. Le copier
    // rendrait le tunnel lisible par l'opérateur — celui-là même dont on se
    // protège. Aucun échelon ne doit y toucher.
    for (let essai = 0; essai <= DERNIER_ESSAI; essai++) {
      const presente = appliquerPresentationTls({ ...PROFIL, insecure: false }, essai);
      assert.equal(presente.insecure, false);
    }
    // Le garde porte sur le CODE, pas sur la prose qui l'explique : on retire
    // d'abord les commentaires, sans quoi la phrase qui décrit le piège
    // ressemblerait au piège lui-même.
    const source = lire('services/tlsPresentation.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(source, /insecure\s*[:=]\s*true/i);
  });

  it('ne s’applique ni à Reality, ni hors TLS, ni hors transport à Upgrade', () => {
    // Reality : l'empreinte uTLS fait partie du protocole. La retirer ne
    // produirait pas une autre présentation, mais un profil cassé.
    const reality = { ...PROFIL, publicKey: 'ABC123' };
    assert.equal(echelleApplicable(reality), false);
    assert.deepEqual(appliquerPresentationTls(reality, 2), reality);
    assert.equal(essaiSuivant(reality, 0, 0), null);

    // Sans TLS il n'y a ni ALPN ni empreinte : rien à présenter autrement.
    assert.equal(echelleApplicable({ ...PROFIL, tls: false }), false);

    // gRPC exige h2 et n'est pas un transport à Upgrade : hors sujet.
    assert.equal(echelleApplicable({ ...PROFIL, network: 'grpc' }), false);
    assert.equal(echelleApplicable({ ...PROFIL, network: 'tcp' }), false);
    assert.equal(echelleApplicable(null), false);

    // httpupgrade négocie bien par un Upgrade HTTP/1.1 : il est concerné.
    assert.equal(echelleApplicable({ ...PROFIL, network: 'httpupgrade' }), true);
  });

  it('ne modifie jamais l’objet d’origine et borne les rangs absurdes', () => {
    const avant = JSON.stringify(PROFIL);
    appliquerPresentationTls(PROFIL, 2);
    assert.equal(JSON.stringify(PROFIL), avant, 'le profil reste la référence');

    assert.equal(presentationPourEssai(-5).cle, 'profil');
    assert.equal(presentationPourEssai(99).cle, 'avec_fragment_fort');
    assert.equal(presentationPourEssai(Number.NaN).cle, 'profil');
    assert.equal(essaiSuivant(PROFIL, 99, 0), 0);
    assert.equal(essaiSuivant(PROFIL, -3, 0), 1);
  });

  it('n’expose jamais une valeur technique dans le journal', () => {
    // Le journal de l'application ne lit que des clés de traduction : un
    // échelon ne doit pas être l'occasion d'y faire entrer un nom d'hôte.
    for (const presentation of ECHELLE_TLS) {
      assert.match(presentation.libelle, /^log_presentation_[a-z_]+$/);
    }
    const fr = lire('localization/fr.ts');
    const en = lire('localization/en.ts');
    for (const presentation of ECHELLE_TLS) {
      assert.ok(fr.includes(`${presentation.libelle}:`), `libellé FR manquant : ${presentation.libelle}`);
      assert.ok(en.includes(`${presentation.libelle}:`), `libellé EN manquant : ${presentation.libelle}`);
    }
  });
});

describe('le moteur natif honore le refus d’empreinte', () => {
  const natif = lire('modules/android-native/SxbVpnService.kt');

  it('reconnaît « none » et n’écrit alors aucun uTLS', () => {
    // Sans ce chemin, « none » serait transmis tel quel comme empreinte uTLS :
    // le moteur refuserait la configuration, et l'échelon le plus important —
    // celui qui reproduit un client ordinaire — serait inopérant.
    assert.match(natif, /val refuseEmpreinte = fingerprint\.equals\("none", ignoreCase = true\)/);
    assert.match(natif, /refuseEmpreinte && realityPublicKey\.isBlank\(\) -> ""/);
    assert.match(natif, /fingerprint\.isNotBlank\(\) && !refuseEmpreinte -> fingerprint/);
    // L'empreinte n'est écrite que lorsqu'elle existe réellement.
    assert.match(natif, /if \(effectiveFingerprint\.isNotBlank\(\)\) \{/);
  });

  it('garde uTLS pour Reality même si l’échelle passait par là', () => {
    // Reality est exclu en amont, mais le natif ne doit pas dépendre de cette
    // seule garantie : un profil Reality reçoit « chrome » quoi qu'il arrive.
    const ordre = natif.indexOf('refuseEmpreinte && realityPublicKey.isBlank()');
    const reality = natif.indexOf('realityPublicKey.isNotBlank() -> "chrome"');
    assert.ok(ordre > 0 && reality > ordre, 'le refus est évalué avant le repli Reality');
  });

  it('lit le champ `fragment` posé par l’échelle et fragmente l’enregistrement TLS', () => {
    // Sans ce fil, le dernier échelon ne changerait STRICTEMENT rien côté
    // moteur : l'application croirait avoir tout tenté alors que le
    // ClientHello resterait identique au troisième essai.
    assert.match(natif, /val fragment\s*=\s*cfg\.optBoolean\("fragment", false\)/);
    assert.match(natif, /val fragment: Boolean = false,/);
    assert.match(natif, /if \(fragment && enabled\) put\("record_fragment", true\)/);
  });

  it('lit le champ `fragmentComplet` et segmente aussi le ClientHello au niveau TCP', () => {
    // Sans ce fil, le tout dernier échelon serait un doublon exact du
    // précédent : l'application aurait épuisé son budget d'exploration sans
    // avoir réellement tenté le mécanisme le plus robuste que propose le moteur.
    assert.match(natif, /val fragmentComplet = cfg\.optBoolean\("fragmentComplet", false\)/);
    assert.match(natif, /val fragmentComplet: Boolean = false,/);
    assert.match(natif, /if \(fragmentComplet && enabled\) put\("fragment", true\)/);
  });
});

describe('le séquencement de l’échelle, dans le contexte VPN', () => {
  const contexte = lire('contexts/VpnContext.tsx');

  it('n’explore que tant que le moteur n’a donné AUCUNE preuve de flux', () => {
    // Piège corrigé : le moteur annonce « handshaking » dès que l'interface TUN
    // existe — même quand le réseau a refusé la connexion sortante. Le prendre
    // pour une réussite désarmait l'échelle avant qu'elle ait pu servir.
    const surHandshaking = contexte.slice(
      contexte.indexOf("if (s === 'handshaking') {"),
      contexte.indexOf("} else if (s === 'connected') {"),
    );
    assert.ok(surHandshaking.length > 0, 'les deux branches existent');
    assert.ok(
      !surHandshaking.includes('noterProgresMoteur()'),
      '« handshaking » ne prouve rien : il ne doit pas désarmer l’échelle',
    );
    // Seul « connected » l'atteste, et le natif ne l'émet que sur preuve d'un
    // flux réel par l'outbound proxy.
    const surConnected = contexte.slice(contexte.indexOf("} else if (s === 'connected') {"));
    assert.ok(surConnected.includes('noterProgresMoteur();'));
    assert.match(contexte, /progresMoteurRef\.current = true;\s*\n\s*stopEchelon\(\);/);
    assert.match(contexte, /if \(progresMoteurRef\.current\) return false;/);
  });

  it('apprend le refus par l’erreur du moteur, pas seulement par le silence', () => {
    // Un refus réseau revient en moins d'une seconde : attendre le délai
    // complet ajouterait une minute d'attente pour rien.
    assert.ok(contexte.includes('if (avancerEchelon(connectionAttemptRef.current, e?.errorCode)) return;'));
    assert.match(contexte, /const DELAI_PRESENTATION_MS = 20_000;/);
  });

  it('n’avale JAMAIS un échec que la présentation n’explique pas', () => {
    // Relancer, c'est remplacer le message d'échec. Sur un mot de passe refusé
    // ou un accès révoqué, cela priverait l'utilisateur de la seule
    // information qui lui permette d'agir.
    assert.match(contexte, /if \(codeErreur !== undefined && !refusDePresentation\(codeErreur\)\) return false;/);
    for (const permanent of [
      'AUTH_FAILED', 'CONFIG_INVALID', 'CONFIG_UNSUPPORTED', 'ACCESS_START_BLOCKED',
      'PLAY_ENCRYPTION_REQUIRED', 'PRIVACY_CONSENT_REQUIRED', 'USAGE_CHECKPOINT_UNAVAILABLE',
      'CAPTIVE_PORTAL', 'DNS_FAILED', 'SSH_MODE_UNKNOWN', 'VPN_TUN_FAILED',
    ]) {
      assert.equal(refusDePresentation(permanent), false, `${permanent} ne doit pas relancer l’échelle`);
    }
    // Et les échecs qui relèvent bien de la poignée de main la relancent.
    for (const reseau of ['', 'VPN_FAILED', 'TCP_TIMEOUT', 'SERVER_UNREACHABLE', 'TLS_FAILED', 'TRANSPORT_ERROR', 'HTTP_UNEXPECTED', 'TUNNEL_REFUSED']) {
      assert.equal(refusDePresentation(reseau), true, `${reseau || '(sans code)'} doit relancer l’échelle`);
    }
    assert.equal(refusDePresentation(null), true, 'un échec sans code est générique');
    assert.equal(refusDePresentation('tcp_timeout'), true, 'la casse ne doit pas décider');
    // Chaque code de la liste blanche existe VRAIMENT dans le moteur natif :
    // une liste qui dérive silencieusement ne protège plus de rien.
    const natif = lire('modules/android-native/SxbVpnService.kt');
    for (const code of ECHECS_DE_PRESENTATION) {
      if (code === '') continue;
      assert.ok(natif.includes(`"${code}"`), `code absent du moteur natif : ${code}`);
    }
  });

  it('retient la présentation qui a fini par aboutir, et l’oublie quand elle ne convient plus', () => {
    assert.match(contexte, /const CLE_PRESENTATION = '@sxb_presentation_tls:';/);
    assert.match(contexte, /AsyncStorage\.setItem\(\s*`\$\{CLE_PRESENTATION\}\$\{runningProfileRef\.current\.configId\}`/);
    assert.match(contexte, /AsyncStorage\.getItem\(`\$\{CLE_PRESENTATION\}\$\{selectedId\}`\)/);
    // Sans cet oubli, un rang retenu sur un réseau disparu resterait le point
    // de départ à jamais, y compris quand il ne passe plus.
    assert.match(contexte, /AsyncStorage\.removeItem\(`\$\{CLE_PRESENTATION\}\$\{runningProfileRef\.current\.configId\}`\)/);
    // Le budget d'exploration se rouvre à chaque départ voulu par l'utilisateur.
    assert.match(contexte, /echelonsTentesRef\.current = 0;/);
    assert.match(contexte, /echelonsTentesRef\.current \+= 1;/);
  });

  it('ignore l’écho de son propre arrêt pendant une bascule', () => {
    // L'arrêt demandé par l'échelle fait remonter un « disconnected ». Le
    // laisser passer éteindrait l'interface au moment où la tentative suivante
    // démarre — l'utilisateur verrait la connexion retomber.
    assert.match(
      contexte,
      /if \(basculeEnCoursRef\.current && \(s === 'disconnected' \|\| s === 'error'\)\) return;/,
    );
    // Et ce marqueur se lève toujours, même si la relance échoue en route.
    assert.match(contexte, /setTimeout\(\(\) => \{ basculeEnCoursRef\.current = false; \}, 5_000\);/);
  });

  it('remet l’exploration à zéro sur une déconnexion voulue', () => {
    const disconnect = contexte.slice(contexte.indexOf('const disconnect = useCallback'));
    assert.ok(disconnect.includes('stopEchelon();'));
    assert.ok(disconnect.includes('basculeEnCoursRef.current = false;'));
  });

  it('remet au moteur la configuration PRÉSENTÉE, pas le profil brut', () => {
    assert.match(
      contexte,
      /const configPresentee = appliquerPresentationTls\(configToUse, presentationEssaiRef\.current\);/,
    );
    assert.match(contexte, /sanitizeEngineConfig\(\{\s*\n\s*\.\.\.configPresentee,/);
  });
});

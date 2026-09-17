/**
 * Compatibilité des profils VLESS partagés, et tenue du tunnel en arrière-plan.
 *
 * LES DEUX DEMANDES DU PROPRIÉTAIRE, DANS UN SEUL FICHIER :
 *
 *  1. « je veux une très bonne compatibilité avec cette config et tout autre
 *     comme ceci » — une URI VLESS/WebSocket/TLS où l'ADRESSE JOINTE, le NOM
 *     PRÉSENTÉ EN TLS et l'EN-TÊTE HOST sont trois valeurs différentes. C'est
 *     la forme que prennent les profils qui passent par une façade : on se
 *     connecte à un domaine banal, on présente son nom en TLS, et seul
 *     l'en-tête Host désigne le vrai service. Confondre ces trois valeurs
 *     produit un profil « importé » qui ne monte jamais.
 *
 *  2. « une bonne gestion en arrière-plan » — sur la plupart des surcouches
 *     Android, l'optimisation de batterie est active par défaut et finit par
 *     suspendre l'application pendant la veille. L'état était déjà LU pour les
 *     diagnostics mais n'était montré nulle part.
 *
 * Ces contrôles lisent le VRAI analyseur et le VRAI code natif : ils échouent
 * si un champ cesse d'être transmis au moteur.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseVlessUri } from '../services/vlessUri';

const mobile = path.resolve(__dirname, '..');
const lire = (relative: string) => readFileSync(path.join(mobile, relative), 'utf8');

/** La configuration exacte fournie par le propriétaire. */
const URI = 'vless://ae446a7b-9988-4353-80c7-050a915e1a1e@crashlyticsreports-pa.googleapis.com:443'
  + '?path=%2F%40stuff006&security=tls&encryption=none&insecure=0'
  + '&host=stuffm-cloud-run-proxy-1023926914988.europe-west1.run.app&fp=chrome&type=ws'
  + '&allowInsecure=0&sni=crashlyticsreports-pa.googleapis.com#websocket-coldplay';

describe('profils VLESS partagés — compatibilité', () => {
  it('garde les trois adresses distinctes et le chemin encodé de la config fournie', () => {
    const { config, name } = parseVlessUri(URI);

    assert.equal(name, 'websocket-coldplay');
    assert.equal(config.protocol, 'vless');
    assert.equal(config.uuid, 'ae446a7b-9988-4353-80c7-050a915e1a1e');
    // 1. Adresse réellement jointe en TCP.
    assert.equal(config.host, 'crashlyticsreports-pa.googleapis.com');
    assert.equal(config.port, 443);
    // 2. Nom présenté pendant la négociation TLS.
    assert.equal(config.sni, 'crashlyticsreports-pa.googleapis.com');
    // 3. En-tête Host du WebSocket : le seul qui désigne le vrai service.
    assert.equal(config.wsHost, 'stuffm-cloud-run-proxy-1023926914988.europe-west1.run.app');
    // `%2F%40` doit redevenir « /@ » : un chemin encodé deux fois renvoie 404,
    // et le tunnel « se connecte » alors sans jamais rien transporter.
    assert.equal(config.path, '/@stuff006');
    assert.equal(config.network, 'ws');
    assert.equal(config.tls, true);
    assert.equal(config.fingerprint, 'chrome');
    assert.equal(config.encryption, 'none');
    // `insecure=0` NE DOIT PAS désactiver la vérification du certificat.
    assert.equal(config.insecure, false);
    // uTLS « chrome » annonce h2 en premier ; le WebSocket de sing-box parle
    // HTTP/1.1 Upgrade. Sans cet ALPN, le TLS aboutit et rien ne passe.
    assert.equal(config.alpn, 'http/1.1');
  });

  it('accepte les mêmes profils sous leurs autres formes d’écriture', () => {
    const variantes: [string, (config: Record<string, any>) => void][] = [
      // Ordre des paramètres différent, `type` avant `security`, nom absent.
      ['vless://ae446a7b-9988-4353-80c7-050a915e1a1e@front.example.com:8443'
        + '?type=ws&host=service.example.run.app&path=%2Fws&security=tls&fp=chrome',
      config => {
        assert.equal(config.port, 8443);
        assert.equal(config.wsHost, 'service.example.run.app');
        assert.equal(config.path, '/ws');
        // Sans `sni` explicite, c'est l'ADRESSE JOINTE qui est présentée — la
        // règle du moteur de référence, et la seule qui préserve une façade.
        // Présenter l'en-tête Host écrirait le vrai service en clair dans le
        // premier paquet, ce qui revient à ne plus avoir de façade du tout.
        assert.equal(config.sni, 'front.example.com');
      }],
      // Adresse littérale : aucune IP ne peut être présentée en SNI, un serveur
      // strict refuse la poignée de main. L'en-tête Host redevient alors le
      // seul nom disponible.
      ['vless://ae446a7b-9988-4353-80c7-050a915e1a1e@203.0.113.7:443'
        + '?type=ws&host=service.example.run.app&path=%2Fws&security=tls',
      config => {
        assert.equal(config.host, '203.0.113.7');
        assert.equal(config.sni, 'service.example.run.app');
      }],
      // `network=` au lieu de `type=`, majuscules, et chemin avec paramètres.
      ['vless://ae446a7b-9988-4353-80c7-050a915e1a1e@front.example.com:443'
        + '?network=WS&security=TLS&path=%2Fapi%3Fed%3D2048&host=svc.example.com#Profil%20partag%C3%A9',
      config => {
        assert.equal(config.network, 'ws');
        assert.equal(config.tls, true);
        assert.equal(config.path, '/api?ed=2048');
      }],
      // Une façade qui exige explicitement h2 : son choix n'est jamais écrasé.
      [URI.replace('&fp=chrome', '&fp=chrome&alpn=h2'),
        config => assert.equal(config.alpn, 'h2')],
      // Certificat auto-signé assumé par l'exploitant.
      [URI.replace('insecure=0', 'insecure=1').replace('allowInsecure=0', 'allowInsecure=1'),
        config => assert.equal(config.insecure, true)],
    ];
    for (const [uri, verifier] of variantes) {
      const { config } = parseVlessUri(uri);
      assert.equal(config.protocol, 'vless');
      verifier(config);
    }
    // Le nom du profil est décodé, jamais laissé en pourcentages.
    assert.equal(parseVlessUri(
      'vless://ae446a7b-9988-4353-80c7-050a915e1a1e@front.example.com:443?type=ws&security=tls#Profil%20partag%C3%A9',
    ).name, 'Profil partagé');
  });

  it('transmet ces trois adresses au moteur sans jamais les confondre', () => {
    // La preuve porte sur le code natif : c'est lui qui écrit la configuration
    // du moteur. Un champ perdu ici ne se voit pas à l'import — seulement par
    // un tunnel qui ne transporte rien.
    const natif = lire('modules/android-native/SxbVpnService.kt');

    // L'adresse TCP vient de l'autorité, le SNI du profil, l'en-tête Host de
    // `wsHost` — et `wsHost` ne retombe sur le SNI que s'il est absent.
    assert.match(natif, /val sni\s+= cfg\.optStringOrNull\("sni", host\)/);
    assert.match(natif, /val wsHost\s+= cfg\.optStringOrNull\("wsHost", sni\)/);
    // L'en-tête Host du WebSocket est bien un en-tête, pas un nom de serveur.
    assert.match(natif, /put\("headers", JSONObject\(\)\.put\("Host", host\)\)/);
    assert.match(natif, /put\("path", path\.ifEmpty \{ "\/" \}\)/);
    // Le SNI est le nom TLS, et le certificat reste vérifié par défaut.
    assert.match(natif, /if \(sni\.isNotEmpty\(\)\) put\("server_name", sni\)/);
    assert.match(natif, /val insecure = cfg\.optBoolean\("insecure", cfg\.optBoolean\("allowInsecure", false\)\)/);
    // uTLS et ALPN sont transmis : sans eux, le ClientHello redevient celui de
    // Go et la façade choisit h2, que le WebSocket ne sait pas porter.
    assert.match(natif, /put\("utls", JSONObject\(\)\.apply \{[\s\S]{0,120}put\("fingerprint", effectiveFingerprint\)/);
    assert.match(natif, /csvToJsonArray\(alpn\)\?\.let \{ put\("alpn", it\) \}/);
    // Le domaine du serveur est résolu HORS tunnel : le résoudre dedans exige
    // le tunnel, qui exige la résolution.
    assert.match(natif, /applyDnsLoopGuard\([\s\S]{0,160}listOf\(host\)/);
  });
});

describe('tenue du tunnel en arrière-plan', () => {
  // L'interdiction porte sur le CODE : le commentaire d'en-tête explique
  // précisément pourquoi cette permission n'est pas employée, et cette phrase
  // déclenchait l'assertion censée l'interdire.
  const service = lire('services/backgroundReliability.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('ne réclame jamais l’exemption, il ouvre l’écran système', () => {
    // La boîte de dialogue `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` est réservée
    // par Google à une poignée de cas d'usage : l'employer est un motif de
    // refus de publication. On ouvre la LISTE, l'utilisateur décide.
    assert.doesNotMatch(service, /REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/);
    assert.match(service, /android\.settings\.IGNORE_BATTERY_OPTIMIZATION_SETTINGS/);
    // Un appareil sans cet écran ne doit pas rester sans rien : repli sur la
    // fiche de l'application, et un échec est RENDU, jamais avalé.
    assert.match(service, /Linking\.openSettings\(\)/);
    assert.match(service, /return false/);
  });

  it('distingue « inconnu » de « sans restriction »', () => {
    // Affirmer « sans restriction » quand la lecture échoue serait une
    // promesse que personne ne tient : l'état inconnu existe donc en propre.
    assert.match(service, /if \(!SxbVpnNative\?\.getBatteryOptimizationState\) return 'unknown'/);
    assert.match(service, /state === 'optimized' \|\| state === 'unrestricted' \? state : 'unknown'/);
  });

  it('montre l’état dans les réglages, avec l’action quand il est restreint', () => {
    const reglages = lire('app/settings.tsx');
    assert.match(reglages, /t\('background_section_uc'\)/);
    assert.match(reglages, /onPress=\{backgroundMode === 'optimized' \? handleBackgroundSettings : undefined\}/);
    // Relu au retour au premier plan : sinon l'écran continuerait d'annoncer
    // une restriction que l'utilisateur vient de lever.
    assert.match(reglages, /AppState\.addEventListener\('change', etat => \{ if \(etat === 'active'\) lire\(\); \}\)/);
    // Chaque état porte son explication, y compris « inconnu ».
    for (const cle of ['background_hint_optimized', 'background_hint_unrestricted', 'background_hint_unknown']) {
      assert.match(reglages, new RegExp(`t\\('${cle}'\\)`), `explication manquante : ${cle}`);
    }
    for (const langue of ['fr', 'en']) {
      const textes = lire(`localization/${langue}.ts`);
      for (const cle of [
        'background_section_uc', 'background_row', 'background_state_unrestricted',
        'background_state_optimized', 'background_state_unknown', 'background_hint_optimized',
        'background_hint_unrestricted', 'background_hint_unknown', 'background_settings_error',
      ]) {
        assert.match(textes, new RegExp(`\\b${cle}:`), `${langue} : traduction manquante ${cle}`);
      }
    }
  });

  it('ne laisse plus l’écran des réglages en français en dur, ni le protocole visible', () => {
    const reglages = lire('app/settings.tsx');
    // Le protocole décrit la technique de transport vendue par l'exploitant :
    // il ne doit apparaître sur AUCUN écran.
    assert.doesNotMatch(reglages, /active_protocol_row|Protocole actif|selectedProtocol \|\| "AUTO"/);
    // Les libellés passent tous par les traductions : la version anglaise
    // affichait « SÉCURITÉ », « Données stockées » ou « Langue » en français.
    const titres = reglages.match(/<Section title="[^"]+"/g) || [];
    assert.deepEqual(titres, [], `sections non traduites : ${titres.join(', ')}`);
    const libelles = reglages.match(/label="[^"]*[A-Za-zÀ-ÿ][^"]*"/g) || [];
    assert.deepEqual(libelles, [], `libellés non traduits : ${libelles.join(', ')}`);
  });
});

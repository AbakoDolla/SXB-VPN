/**
 * journal-technique.test.ts — Le journal en dit plus, sans jamais en dire trop.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CES CONTRÔLES PROTÈGENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Le journal devient technique : « HTTP/1.1 200 », « TLS 1.3 », « tunnel
 * établi ». C'est ce détail qui permet de dire où une connexion casse.
 *
 * Mais ces mêmes traces du moteur portent aussi le nom d'hôte, l'identifiant
 * du compte et le chemin WebSocket — précisément ce que l'exploitant vend.
 * Chaque contrôle ci-dessous attaque donc le module avec une trace RÉELLE et
 * vérifie non seulement qu'il lit ce qu'il faut, mais qu'il laisse tomber
 * tout le reste.
 *
 * Les lignes de trace sont copiées de SxbVpnService.kt, pas inventées : un
 * contrôle écrit contre une forme imaginaire ne prouverait rien.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { analyserTrace, formaterFait } from '../services/journalTechnique';

/** Tout ce qui ne doit JAMAIS ressortir, quelle que soit la trace. */
const SECRETS = [
  'crashlyticsreports-pa.googleapis.com',
  'stuffm-cloud-run-proxy-1023926914988.europe-west1.run.app',
  'ae446a7b-9988-4353-80c7-050a915e1a1e',
  '@stuff006',
  'bugsleuth',
  '5.75.179.98',
];

function neDivulgueRien(rendu: string, origine: string) {
  for (const secret of SECRETS) {
    assert.ok(
      !rendu.includes(secret),
      `« ${secret} » a fui depuis : ${origine}`,
    );
  }
}

describe('faits techniques — ce que le journal doit enfin montrer', () => {
  it('lit le code de réponse HTTP, que l’utilisateur réclamait', () => {
    const f = analyserTrace('[SXB_TRACE] stage=HTTP_RESPONSE status=HTTP/1.1 200 OK header_count=6 body_bytes=unknown');
    assert.ok(f, 'la trace doit être reconnue');
    assert.deepEqual(f.valeurs, ['HTTP/1.1 200']);
    assert.equal(f.niveau, 'ok');
  });

  it('ne garde du statut HTTP que la version et le code', () => {
    // Un hôte glissé dans la ligne de statut ne doit pas ressortir.
    const f = analyserTrace('[SXB_TRACE] stage=HTTP_RESPONSE status=HTTP/1.1 302 Moved to crashlyticsreports-pa.googleapis.com');
    assert.deepEqual(f?.valeurs, ['HTTP/1.1 302']);
    neDivulgueRien(f.valeurs.join(' '), 'statut HTTP avec redirection');
  });

  it('lit la version TLS négociée et sa durée', () => {
    const f = analyserTrace('[SXB_TRACE] stage=TLS_HANDSHAKE_SUCCESS elapsed_ms=847 protocol=TLSv1.3');
    assert.ok(f);
    assert.ok(f.valeurs.includes('TLSv1.3'), 'la version TLS doit apparaître');
    assert.ok(f.valeurs.includes('847 ms'), 'la durée doit apparaître');
  });

  it('lit le transport retenu ET la raison, qui explique le comportement du tunnel', () => {
    const f = analyserTrace('[SXB_TRACE] stage=TRANSPORT_SELECTED mode=WEBSOCKET_RFC6455 reason=http_101_upgrade');
    assert.deepEqual(f?.valeurs, ['WEBSOCKET_RFC6455', 'HTTP_101_UPGRADE']);
  });

  it('distingue un 101 cosmétique d’un vrai WebSocket', () => {
    // Deux tunnels « 101 » qui se comportent différemment : sans la raison,
    // l'exploitant ne peut pas les distinguer dans le journal.
    const vrai = analyserTrace('[SXB_TRACE] stage=TRANSPORT_SELECTED mode=WEBSOCKET_RFC6455 reason=http_101_upgrade');
    const faux = analyserTrace('[SXB_TRACE] stage=TRANSPORT_SELECTED mode=SSH_RAW reason=101_then_ssh_banner');
    assert.notDeepEqual(vrai?.valeurs, faux?.valeurs);
    assert.ok(faux?.valeurs.includes('101_THEN_SSH_BANNER'.toUpperCase()));
  });

  it('met les durées et les volumes en unités lisibles', () => {
    assert.deepEqual(analyserTrace('[SXB_TRACE] stage=TCP_CONNECTED elapsed_ms=412')?.valeurs, ['412 ms']);
    assert.deepEqual(analyserTrace('[SXB_TRACE] stage=TCP_CONNECTED elapsed_ms=47300')?.valeurs, ['47.3 s']);
    assert.deepEqual(analyserTrace('[SXB_TRACE] stage=PAYLOAD_SENT bytes=345 flush=true')?.valeurs, ['345 o']);
    assert.deepEqual(analyserTrace('[SXB_TRACE] stage=PAYLOAD_SENT bytes=4096 flush=true')?.valeurs, ['4.0 Ko']);
  });
});

describe('confidentialité — les traces qui portent des secrets', () => {
  it('écarte entièrement l’étape qui porte le nom d’hôte', () => {
    // ENDPOINT_RESOLVED n'est pas cité dans la table : il disparaît sans qu'on
    // ait eu à le reconnaître comme dangereux.
    const ligne = '[SXB_TRACE] stage=ENDPOINT_RESOLVED remote=crashlyticsreports-pa.googleapis.com id=ae446a7b-9988-4353-80c7-050a915e1a1e';
    assert.equal(analyserTrace(ligne), null, 'cette étape ne doit jamais être lue');
  });

  it('écarte les en-têtes HTTP, choisis par l’exploitant', () => {
    assert.equal(
      analyserTrace('[SXB_TRACE] stage=HTTP_HEADERS names=Host,Upgrade raw_bytes=210 terminator=true'),
      null,
    );
  });

  it('écarte ce que l’utilisateur visite', () => {
    assert.equal(
      analyserTrace('[SXB_TRACE] stage=SOCKS5_TARGET_RESOLVED port=443 host_present=true'),
      null,
    );
  });

  it('refuse une valeur libre même sur une clé admise', () => {
    // `protocol` est admis pour TLS, mais seule une version connue passe.
    const f = analyserTrace('[SXB_TRACE] stage=TLS_HANDSHAKE_SUCCESS protocol=crashlyticsreports-pa.googleapis.com');
    assert.deepEqual(f?.valeurs, [], 'une valeur hors liste doit être écartée');
    neDivulgueRien(JSON.stringify(f), 'protocole falsifié');
  });

  it('refuse un mode de transport inventé', () => {
    const f = analyserTrace('[SXB_TRACE] stage=TRANSPORT_SELECTED mode=bugsleuth@5.75.179.98');
    assert.deepEqual(f?.valeurs, []);
    neDivulgueRien(JSON.stringify(f), 'mode falsifié');
  });

  it('ne laisse passer aucun secret, sur aucune trace réelle', () => {
    const tracesReelles = [
      '[SXB_TRACE] stage=SOCKET_CREATED timeout_ms=15000 tls=true sni_present=true',
      '[SXB_TRACE] stage=DNS_RESOLVE success=true elapsed_ms=120',
      '[SXB_TRACE] stage=TCP_CONNECTED elapsed_ms=412 local_bound=true',
      '[SXB_TRACE] stage=TLS_HANDSHAKE_SUCCESS protocol=TLSv1.3 cipher_present=true',
      '[SXB_TRACE] stage=PAYLOAD_SENT bytes=345 flush=true',
      '[SXB_TRACE] stage=HTTP_RESPONSE status=HTTP/1.1 101 Switching Protocols header_count=6',
      '[SXB_TRACE] stage=TRANSPORT_SELECTED mode=SSH_RAW reason=SSH_BANNER',
      '[SXB_TRACE] stage=SSH_BANNER_WAIT timeout_ms=28000',
      '[SXB_TRACE] stage=LIBBOX_STARTED label=vless service_ready=true',
      '[SXB_TRACE] stage=SOCKS5_RELAY_CLOSED upload_bytes=8192 download_bytes=1048576',
      // Et les mêmes, salies avec des secrets glissés partout.
      '[SXB_TRACE] stage=TCP_CONNECTED elapsed_ms=412 host=crashlyticsreports-pa.googleapis.com',
      '[SXB_TRACE] stage=LIBBOX_STARTED label=bugsleuth uuid=ae446a7b-9988-4353-80c7-050a915e1a1e',
      '[SXB_TRACE] stage=PAYLOAD_SENT bytes=345 path=/@stuff006',
    ];
    for (const ligne of tracesReelles) {
      const f = analyserTrace(ligne);
      if (f) neDivulgueRien(JSON.stringify(f), ligne);
    }
  });
});

describe('étapes nouvellement exposées — les formats RÉELS du moteur', () => {
  // Chaque ligne ci-dessous est copiée de SxbVpnService.kt. Une ligne
  // inventée ne prouverait rien : c'est le format réellement émis qui compte.

  it('lit les étapes émises via l’aide « trace() », préfixées de seq et elapsed_ms', () => {
    // Régression : le motif exigeait « stage= » collé au marqueur. Toutes les
    // étapes passant par `trace()` étaient donc muettes — dont « Tunnel
    // établi », l'étape la plus attendue du journal.
    const f = analyserTrace('[SXB_TRACE] seq=18 elapsed_ms=84213 stage=LIBBOX_STARTED label=vless service_ready=true');
    assert.ok(f, 'une étape émise par trace() doit être lue');
    assert.equal(f.etape, 'LIBBOX_STARTED');
  });

  it('ne confond pas le elapsed_ms du préfixe avec celui de l’étape', () => {
    // Le préfixe porte la durée d'allumage de l'appareil : l'afficher comme
    // durée d'étape serait un chiffre faux — donc une fausse donnée.
    const f = analyserTrace('[SXB_TRACE] seq=4 elapsed_ms=9999999 stage=TCP_CONNECTED elapsed_ms=412 local_bound=true');
    assert.deepEqual(f?.valeurs, ['412 ms'], 'la durée lue doit être celle de l’étape');
  });

  it('rend la preuve d’acheminement, le fait que l’utilisateur attend', () => {
    const f = analyserTrace('[SXB_TRACE] seq=41 elapsed_ms=90210 stage=TUNNEL_TRAFFIC_CONFIRMED proof=TUN_RX bytes=4096');
    assert.ok(f, 'la preuve de trafic doit être lisible');
    assert.deepEqual(f.valeurs, ['TUN_RX', '4.0 Ko']);
    assert.equal(f.niveau, 'ok');
  });

  it('signale un tunnel monté qui n’achemine rien, en échec', () => {
    const f = analyserTrace('[SXB_TRACE] seq=42 elapsed_ms=90210 stage=TUNNEL_NO_TRAFFIC_PROOF measurable=true timeout_ms=60000');
    assert.equal(f?.niveau, 'echec', 'un tunnel sans trafic est un échec, pas un détail');
    assert.deepEqual(f?.valeurs, ['mesure possible', '60.0 s']);
  });

  it('annonce l’état présumé comme une réserve, jamais comme un succès', () => {
    const f = analyserTrace('[SXB_TRACE] seq=43 elapsed_ms=90210 stage=TUNNEL_PROOF_UNMEASURABLE timeout_ms=60000');
    assert.equal(f?.niveau, 'attention', 'un état présumé ne doit pas passer pour « ok »');
  });

  it('lit la classification du mode malgré la clé « connect200 » qui porte un chiffre', () => {
    // Le champ qui précède une clé contenant un chiffre débordait sur elle et
    // se faisait rejeter. C'est le cas exact émis par le moteur.
    const f = analyserTrace(
      '[SXB_TRACE] stage=MODE_CLASSIFIED status=HTTP/1.1 200 OK ws=true connect200=false ssh_banner=false empty=false connect_payload=false',
    );
    assert.ok(f?.valeurs.includes('WebSocket'), `« ws=true » doit être lu ; obtenu : ${JSON.stringify(f?.valeurs)}`);
  });

  it('n’expose jamais la ligne de statut brute de MODE_CLASSIFIED', () => {
    const f = analyserTrace(
      '[SXB_TRACE] stage=MODE_CLASSIFIED status=HTTP/1.1 302 crashlyticsreports-pa.googleapis.com ws=false connect200=true ssh_banner=false',
    );
    neDivulgueRien(JSON.stringify(f), 'statut de MODE_CLASSIFIED');
    assert.ok(!JSON.stringify(f).includes('302'), 'le statut n’est pas admis sur cette étape');
  });

  it('écarte le canal SSH, qui se rouvre à chaque destination visitée', () => {
    // Une ligne par site visité : le journal deviendrait illisible, et le
    // rythme des lignes trahirait l'activité de l'utilisateur.
    assert.equal(analyserTrace('[SXB_TRACE] stage=SSH_DIRECT_TCPIP_CONNECTED port=443'), null);
  });

  it('lit le type d’erreur du relais, jamais son message', () => {
    const f = analyserTrace('[SXB_TRACE] stage=SOCKS5_ERROR type=SocketTimeoutException');
    assert.deepEqual(f?.valeurs, ['SocketTimeoutException']);
    const sale = analyserTrace('[SXB_TRACE] stage=SOCKS5_ERROR type=Connection refused to 5.75.179.98');
    assert.deepEqual(sale?.valeurs, [], 'un message libre ne doit pas passer pour un type');
    neDivulgueRien(JSON.stringify(sale), 'message d’erreur du relais');
  });

  it('lit le code d’échec et l’état où il s’est produit', () => {
    const f = analyserTrace('[SXB_TRACE] seq=9 elapsed_ms=45000 stage=VPN_FAILED code=TUNNEL_STALLED state=handshaking');
    assert.deepEqual(f?.valeurs, ['TUNNEL_STALLED', 'HANDSHAKING']);
    assert.equal(f?.niveau, 'echec');
  });

  it('lit les étapes SSH réellement émises, dans leurs deux variantes', () => {
    const attempt = analyserTrace('[SXB_TRACE] seq=3 elapsed_ms=1200 stage=SSH_ATTEMPT_START n=1 transport=tls_ws tls=true');
    assert.deepEqual(attempt?.valeurs, ['1', 'TLS'], 'le transport est écarté, n et tls sont lus');

    const avecN = analyserTrace('[SXB_TRACE] seq=4 elapsed_ms=1201 stage=SSH_HANDSHAKE_START n=1 transport=tls_ws timeout_ms=12000');
    assert.deepEqual(avecN?.valeurs, ['1', '12.0 s']);

    const sansN = analyserTrace('[SXB_TRACE] seq=4 elapsed_ms=1201 stage=SSH_HANDSHAKE_START payload=false tls=true timeout_ms=30000');
    assert.deepEqual(sansN?.valeurs, ['30.0 s'], 'la variante sans « n » reste lisible');

    const ok = analyserTrace('[SXB_TRACE] seq=5 elapsed_ms=3400 stage=SSH_HANDSHAKE_SUCCESS session_connected=true');
    assert.deepEqual(ok?.valeurs, ['session ouverte']);
  });

  it('lit les étapes du TUN sans nommer l’interface', () => {
    const debut = analyserTrace('[SXB_TRACE] seq=7 elapsed_ms=8000 stage=TUN_CREATE_START mtu=1500 auto_route=true strict_route=false');
    assert.deepEqual(debut?.valeurs, ['1500', 'routage auto']);

    const cree = analyserTrace('[SXB_TRACE] seq=8 elapsed_ms=8100 stage=TUN_CREATED fd_ready=true interface_name=tun0 tun_counters=true');
    assert.deepEqual(cree?.valeurs, ['interface prête', 'compteurs lisibles']);
    assert.ok(!JSON.stringify(cree).includes('tun0'), 'le nom d’interface n’est pas admis');
  });

  it('accepte les quatre vocabulaires de mode réellement émis', () => {
    for (const mode of ['tls_raw', 'tls_ws', 'ws', 'raw']) {
      const f = analyserTrace(`[SXB_TRACE] seq=6 elapsed_ms=3401 stage=TRANSPORT_SELECTED mode=${mode} reason=ssh_banner`);
      assert.deepEqual(
        f?.valeurs,
        [mode.toUpperCase(), 'SSH_BANNER'],
        `le mode « ${mode} » est réellement émis par le moteur et doit être lu`,
      );
    }
  });
});

describe('robustesse — rien ne doit faire tomber le journal', () => {
  it('ignore ce qui n’est pas une trace', () => {
    for (const bruit of ['', 'texte libre', '[SXB] Tunnel prêt', '[SXB_TRACE] sans stage', null, undefined, 42]) {
      assert.equal(analyserTrace(bruit as any), null, `entrée : ${String(bruit)}`);
    }
  });

  it('met en forme avec et sans valeurs', () => {
    const avec = { cle: 'x', valeurs: ['HTTP/1.1 200'], niveau: 'ok' as const, etape: 'HTTP_RESPONSE' };
    const sans = { cle: 'x', valeurs: [], niveau: 'ok' as const, etape: 'LIBBOX_STARTED' };
    assert.equal(formaterFait(avec, 'Réponse du serveur'), 'Réponse du serveur · HTTP/1.1 200');
    assert.equal(formaterFait(sans, 'Moteur démarré'), 'Moteur démarré');
  });
});

describe('câblage — le champ technique n’a qu’une seule source', () => {
  const CONTEXTE = readFileSync(
    path.join(path.resolve(__dirname, '..'), 'contexts/VpnContext.tsx'),
    'utf8',
  );

  it('le journal du moteur passe par l’analyseur, jamais en direct', () => {
    assert.match(CONTEXTE, /const fait = analyserTrace\(ligne\);/);
    assert.match(CONTEXTE, /if \(!fait\) return;/);
    // La valeur inscrite vient du fait analysé, pas de la ligne brute.
    assert.match(CONTEXTE, /technique: fait\.valeurs,/);
  });

  it('aucune ligne brute du moteur ne devient une étape', () => {
    // `inscrireFaitMoteur` est le SEUL chemin entre onVpnLog et stepLogs.
    assert.match(CONTEXTE, /inscrireFaitMoteur\(e\.message\);/);
    assert.ok(
      !/translationKey: e\.message/.test(CONTEXTE),
      'le message du moteur ne doit jamais servir de libellé',
    );
    assert.ok(
      !/technique: \[e\.message\]/.test(CONTEXTE),
      'le message du moteur ne doit jamais être inscrit tel quel',
    );
  });

  it('une même étape ne s’empile pas à chaque tentative', () => {
    assert.match(CONTEXTE, /if \(prev\.some\(s => s\.key === cle\)\) return prev;/);
  });
});

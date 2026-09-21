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

  it('lit le transport retenu, qui explique le comportement du tunnel', () => {
    const f = analyserTrace('[SXB_TRACE] stage=TRANSPORT_SELECTED mode=WEBSOCKET_RFC6455 reason=http_101_upgrade');
    assert.deepEqual(f?.valeurs, ['WEBSOCKET_RFC6455']);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PARITÉ — ce que le moteur ÉMET contre ce que le journal sait LIRE
 * ═══════════════════════════════════════════════════════════════════════════
 * Les contrôles précédents vérifient que les bonnes traces sont reconnues.
 * Aucun ne vérifiait que la forme testée était celle que le moteur produit —
 * et c'est exactement par là que le défaut est passé.
 *
 * `SxbVpnService.kt` émet ses traces de DEUX façons :
 *
 *     onEvent/broadcastLog("[SXB_TRACE] stage=TCP_CONNECTED …")
 *     trace("TUN_CREATED", "…")   ->   "[SXB_TRACE] seq=7 elapsed_ms=3400 stage=TUN_CREATED …"
 *
 * Le jeu d'essai ne portait que la première. `LIBBOX_STARTED` y figurait
 * sous une forme que le moteur n'écrit jamais : le contrôle restait vert
 * pendant que l'étape était jetée en production.
 *
 * Ces contrôles lisent donc le MOTEUR, pas une ligne recopiée à la main.
 */
describe('parité — le journal lit la forme que le moteur écrit vraiment', () => {
  const MOTEUR = readFileSync(
    path.join(path.resolve(__dirname, '..'), 'modules/android-native/SxbVpnService.kt'),
    'utf8',
  );

  /** Étapes émises littéralement : `[SXB_TRACE] stage=NOM`. */
  const emisesDirectement = new Set(
    [...MOTEUR.matchAll(/\[SXB_TRACE\] stage=([A-Z0-9_]+)/g)].map(m => m[1]),
  );

  /** Étapes émises par le raccourci `trace("NOM", …)`, qui préfixe la ligne. */
  const emisesParRaccourci = new Set(
    [...MOTEUR.matchAll(/(?<![A-Za-z])trace\(\s*"([A-Z0-9_]+)"/g)].map(m => m[1]),
  );

  it('le moteur utilise bien les deux formes — sans quoi ces contrôles ne prouvent rien', () => {
    assert.ok(emisesDirectement.size > 0, 'aucune trace littérale trouvée : le motif de lecture est faux');
    assert.ok(emisesParRaccourci.size > 0, 'aucun trace(…) trouvé : le motif de lecture est faux');
  });

  it('reconnaît la forme préfixée du raccourci, jetée jusqu’ici', () => {
    // Ligne reconstituée depuis trace() : seq et elapsed_ms précèdent stage.
    const f = analyserTrace('[SXB_TRACE] seq=7 elapsed_ms=3400 stage=LIBBOX_STARTED label=vless service_ready=true');
    assert.ok(f, 'la forme préfixée doit être reconnue');
    assert.equal(f.etape, 'LIBBOX_STARTED');
  });

  it('ne lit jamais l’horloge du préfixe comme une durée d’étape', () => {
    // elapsed_ms du préfixe est le temps depuis le démarrage de l'appareil.
    // Le confondre avec la durée de l'étape afficherait un chiffre faux.
    const f = analyserTrace('[SXB_TRACE] seq=9 elapsed_ms=3400000 stage=TCP_CONNECTED elapsed_ms=412');
    assert.deepEqual(f?.valeurs, ['412 ms'], 'seule la durée de l’étape doit être lue');
  });

  it('chaque étape de la liste blanche est réellement émise par le moteur', () => {
    // Une entrée que le moteur n'écrit jamais est du code mort qui donne
    // l'illusion d'une couverture. C'était le cas de LIBBOX_STARTED.
    for (const etape of ETAPES_ATTENDUES) {
      assert.ok(
        emisesDirectement.has(etape) || emisesParRaccourci.has(etape),
        `« ${etape} » est en liste blanche mais le moteur ne l’émet nulle part`,
      );
    }
  });

  it('toute étape émise par le raccourci et admise est effectivement lisible', () => {
    for (const etape of emisesParRaccourci) {
      if (!ETAPES_ATTENDUES.includes(etape)) continue;
      const ligne = `[SXB_TRACE] seq=1 elapsed_ms=1000 stage=${etape}`;
      assert.ok(
        analyserTrace(ligne),
        `« ${etape} » est admise mais sa forme réelle n’est pas reconnue`,
      );
    }
  });
});

/**
 * Les étapes que le journal déclare savoir lire.
 *
 * Tenue à la main volontairement : `ETAPES` n'est pas exporté, et l'exporter
 * pour un contrôle ouvrirait la table à un usage extérieur. Une divergence
 * fait tomber le contrôle de parité ci-dessus, qui la nomme.
 */
const ETAPES_ATTENDUES = [
  'SOCKET_CREATED', 'DNS_RESOLVE', 'TCP_CONNECTED', 'TLS_HANDSHAKE_SUCCESS',
  'PAYLOAD_SENT', 'HTTP_RESPONSE', 'TRANSPORT_SELECTED', 'SSH_BANNER_WAIT',
  'LIBBOX_STARTED', 'SOCKS5_RELAY_CLOSED',
  'SSH_TUNNEL_START', 'SSH_ATTEMPT_START', 'SSH_HANDSHAKE_START',
  'SSH_OVER_TLS_START', 'SSH_HANDSHAKE_SUCCESS', 'SOCKS5_READY',
  'TUN_CREATE_START', 'TUN_CREATED', 'VPN_FAILED',
  'CLEANUP_START', 'CLEANUP_COMPLETE',
  'SOCKS5_ERROR', 'WS_FRAME_TIMEOUT', 'WS_CLOSE', 'SOCKET_PROTECT',
];

describe('cycle de vie — les étapes qui disent OÙ la connexion s’arrête', () => {
  it('lit la tentative et son transport', () => {
    const f = analyserTrace('[SXB_TRACE] seq=3 elapsed_ms=900 stage=SSH_ATTEMPT_START n=2 transport=tls_ws tls=true');
    assert.deepEqual(f?.valeurs, ['2', 'TLS_WS']);
  });

  it('refuse un transport inventé', () => {
    const f = analyserTrace('[SXB_TRACE] seq=3 elapsed_ms=900 stage=SSH_ATTEMPT_START n=2 transport=crashlyticsreports-pa.googleapis.com');
    assert.deepEqual(f?.valeurs, ['2']);
    neDivulgueRien(JSON.stringify(f), 'transport falsifié');
  });

  it('nomme le code d’échec, jamais autre chose', () => {
    const ok = analyserTrace('[SXB_TRACE] seq=8 elapsed_ms=5000 stage=VPN_FAILED code=SSH_TIMEOUT state=connecting');
    assert.deepEqual(ok?.valeurs, ['SSH_TIMEOUT']);
    assert.equal(ok?.niveau, 'echec');

    const sale = analyserTrace('[SXB_TRACE] seq=8 elapsed_ms=5000 stage=VPN_FAILED code=5.75.179.98');
    assert.deepEqual(sale?.valeurs, [], 'une adresse ne peut pas passer pour un code');
    neDivulgueRien(JSON.stringify(sale), 'code d’échec falsifié');
  });

  it('nomme le type d’exception du relais, jamais son message', () => {
    const ok = analyserTrace('[SXB_TRACE] stage=SOCKS5_ERROR type=SocketTimeoutException');
    assert.deepEqual(ok?.valeurs, ['SocketTimeoutException']);

    const sale = analyserTrace('[SXB_TRACE] stage=SOCKS5_ERROR type=connexion vers stuffm-cloud-run-proxy-1023926914988.europe-west1.run.app refusée');
    assert.deepEqual(sale?.valeurs, []);
    neDivulgueRien(JSON.stringify(sale), 'message d’exception');
  });

  it('ne divulgue rien sur les traces réelles du cycle de vie', () => {
    const reelles = [
      '[SXB_TRACE] seq=1 elapsed_ms=120 stage=SSH_TUNNEL_START state=connecting',
      '[SXB_TRACE] seq=2 elapsed_ms=300 stage=SSH_ATTEMPT_START n=1 transport=tls_raw tls=true',
      '[SXB_TRACE] seq=3 elapsed_ms=340 stage=SSH_HANDSHAKE_START n=1 transport=tls_raw timeout_ms=12000',
      '[SXB_TRACE] seq=4 elapsed_ms=380 stage=SSH_OVER_TLS_START sni_set=true',
      '[SXB_TRACE] seq=5 elapsed_ms=900 stage=SSH_HANDSHAKE_SUCCESS session_connected=true',
      '[SXB_TRACE] seq=6 elapsed_ms=950 stage=SOCKS5_READY listen_loopback=true port=1080',
      '[SXB_TRACE] seq=7 elapsed_ms=1000 stage=TUN_CREATE_START mtu=1500 auto_route=true strict_route=false',
      '[SXB_TRACE] seq=8 elapsed_ms=1100 stage=TUN_CREATED fd_ready=true interface_name=tun0 tun_counters=true',
      '[SXB_TRACE] seq=9 elapsed_ms=5000 stage=VPN_FAILED code=SSH_TIMEOUT state=connecting',
      '[SXB_TRACE] seq=10 elapsed_ms=5100 stage=CLEANUP_START stop_service=true keep_running=false state=error',
      '[SXB_TRACE] seq=11 elapsed_ms=5200 stage=CLEANUP_COMPLETE state=disconnected',
      '[SXB_TRACE] stage=WS_CLOSE code=1006 payload_bytes=2',
      '[SXB_TRACE] stage=WS_FRAME_TIMEOUT timeout_propagated=true',
      '[SXB_TRACE] stage=SOCKET_PROTECT result=true fd_ready=true',
      // Les mêmes, salies.
      '[SXB_TRACE] seq=4 elapsed_ms=380 stage=SSH_OVER_TLS_START sni_set=crashlyticsreports-pa.googleapis.com',
      '[SXB_TRACE] seq=8 elapsed_ms=1100 stage=TUN_CREATED fd_ready=true interface_name=@stuff006',
      '[SXB_TRACE] seq=6 elapsed_ms=950 stage=SOCKS5_READY port=1080 host=5.75.179.98',
    ];
    for (const ligne of reelles) {
      const f = analyserTrace(ligne);
      if (f) neDivulgueRien(JSON.stringify(f), ligne);
    }
  });
});

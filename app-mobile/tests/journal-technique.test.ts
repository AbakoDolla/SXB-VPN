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

/**
 * Le harnais de validation sur appareil doit savoir REFUSER.
 *
 * Un contrôle qu'on n'a jamais vu échouer ne garantit rien. Ces tests
 * établissent que l'analyseur :
 *
 *   — refuse de conclure quand la preuve manque (« non observé » n'est pas
 *     une réussite) ;
 *   — rattrape le défaut même que cette mission corrigeait : un écran qui
 *     annonce « Connecté » alors que le service n'a émis aucune preuve ;
 *   — ne cite que des marqueurs que le service natif émet RÉELLEMENT.
 *
 * ⚠️ Les captures ci-dessous sont des ENTRÉES D'ANALYSE fabriquées pour
 * éprouver l'analyseur. Ce ne sont pas des relevés d'appareil, et elles ne
 * prouvent rien du comportement d'un téléphone. Aucun tunnel réel n'a été
 * établi : §17.4 reste entier.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyserCapture, ETIQUETTES } from '../scripts/valider-sur-appareil.mjs';

const ETABLI = 'ÉTABLI';
const CONTREDIT = 'CONTREDIT';
const NON_OBSERVE = 'NON OBSERVÉ';

const trace = (stage: string, detail = '') =>
  `01-01 00:00:00.000 I/SXB-VPN(1): [SXB_TRACE] seq=1 elapsed_ms=100 stage=${stage}${detail ? ' ' + detail : ''}`;

describe('harnais appareil — une capture sans preuve ne conclut pas', () => {
  it('une capture vide rend « non observé », jamais une réussite', () => {
    const r = analyserCapture('', '4');
    assert.equal(r.verdict, NON_OBSERVE);
  });

  it('une capture sans aucune ligne du service est contredite', () => {
    const r = analyserCapture('01-01 00:00:00.000 I/autre(1): sans rapport', '4');
    assert.equal(r.verdict, CONTREDIT);
  });

  it('un point inconnu de §17.5 est refusé', () => {
    const r = analyserCapture(trace('TUN_CREATED'), '99');
    assert.equal(r.verdict, CONTREDIT);
  });
});

describe('§17.5 point 4 — la trace « Tunnel établi »', () => {
  it('établi quand le TUN est ouvert et que l’écran l’a montré', () => {
    const r = analyserCapture(trace('TUN_CREATED', 'fd_ready=true'), '4', { tunnelAffiche: 'oui' });
    assert.equal(r.verdict, ETABLI);
  });

  it('non observé quand la trace manque — c’était le défaut d’origine', () => {
    const r = analyserCapture(trace('LIBBOX_STARTED'), '4', { tunnelAffiche: 'oui' });
    assert.equal(r.verdict, NON_OBSERVE);
  });

  it('non observé quand personne n’a regardé l’écran', () => {
    const r = analyserCapture(trace('TUN_CREATED'), '4');
    assert.equal(r.verdict, NON_OBSERVE);
  });
});

describe('§17.5 point 5 — aucun « connected » avant un octet reçu', () => {
  it('établi sur une preuve mesurée et un écran concordant', () => {
    const r = analyserCapture(
      trace('TUNNEL_TRAFFIC_CONFIRMED', 'proof=TUN_RX bytes=4096'),
      '5', { afficheConnecte: 'oui' },
    );
    assert.equal(r.verdict, ETABLI);
  });

  it('CONTREDIT si l’écran annonce « Connecté » sans aucune preuve', () => {
    // C'est LE cas que cette mission corrigeait. Si ce test cesse d'échouer
    // sur cette entrée, le harnais ne protège plus rien.
    const r = analyserCapture(trace('TUN_CREATED'), '5', { afficheConnecte: 'oui' });
    assert.equal(r.verdict, CONTREDIT);
    const c = r.criteres.find((x: { id: string }) => x.id === 'confrontation');
    assert.ok(c, 'le critère de confrontation doit exister');
    assert.equal(c.verdict, CONTREDIT);
    assert.match(c.preuve, /faux connected/);
  });

  it('CONTREDIT si le service prouve mais que l’écran ne suit pas', () => {
    const r = analyserCapture(
      trace('TUNNEL_TRAFFIC_CONFIRMED', 'proof=SSH_RELAY_RX bytes=8192'),
      '5', { afficheConnecte: 'non' },
    );
    assert.equal(r.verdict, CONTREDIT);
  });

  it('une preuve à 0 octet ne vaut pas preuve', () => {
    const r = analyserCapture(
      trace('TUNNEL_TRAFFIC_CONFIRMED', 'proof=TUN_RX bytes=0'),
      '5', { afficheConnecte: 'oui' },
    );
    assert.equal(r.verdict, CONTREDIT);
  });

  it('une preuve PRÉSUMÉE ne passe jamais au vert toute seule', () => {
    const r = analyserCapture(
      trace('TUNNEL_TRAFFIC_CONFIRMED', 'proof=PRESUMED_UNMEASURABLE bytes=0'),
      '5', { afficheConnecte: 'oui' },
    );
    assert.notEqual(r.verdict, ETABLI);
  });
});

describe('§17.5 point 5b — identifiants faux : échec, jamais réussite', () => {
  it('établi quand le service échoue sans jamais prouver d’acheminement', () => {
    const r = analyserCapture(
      trace('VPN_FAILED', 'code=SSH_AUTH_FAILED state=handshaking'),
      '5b', { afficheConnecte: 'non' },
    );
    assert.equal(r.verdict, ETABLI);
  });

  it('CONTREDIT si une preuve d’acheminement apparaît malgré l’échec', () => {
    const r = analyserCapture(
      [trace('VPN_FAILED', 'code=SSH_AUTH_FAILED state=handshaking'),
        trace('TUNNEL_TRAFFIC_CONFIRMED', 'proof=TUN_RX bytes=10')].join('\n'),
      '5b', { afficheConnecte: 'non' },
    );
    assert.equal(r.verdict, CONTREDIT);
  });

  it('CONTREDIT si l’écran a annoncé une réussite', () => {
    const r = analyserCapture(
      trace('VPN_FAILED', 'code=SSH_AUTH_FAILED state=handshaking'),
      '5b', { afficheConnecte: 'oui' },
    );
    assert.equal(r.verdict, CONTREDIT);
  });
});

describe('§17.5 point 6 — tunnel muet détecté', () => {
  it('établi sur code=TUNNEL_STALLED', () => {
    const r = analyserCapture(
      trace('VPN_FAILED', 'code=TUNNEL_STALLED state=handshaking'),
      '6', { etatQuitte: 'oui' },
    );
    assert.equal(r.verdict, ETABLI);
  });

  it('non observé si l’échec porte un autre code', () => {
    const r = analyserCapture(
      trace('VPN_FAILED', 'code=SSH_AUTH_FAILED state=handshaking'),
      '6', { etatQuitte: 'oui' },
    );
    assert.equal(r.verdict, NON_OBSERVE);
  });
});

describe('§17.5 points 7 et 8 — Kill Switch', () => {
  const pose = [
    '01-01 00:00:00.000 I/SXB-VPN(1): [SXB] Kill Switch : activé',
    '01-01 00:00:01.000 I/SXB-VPN(1): [SXB] ⛔ Kill Switch actif — trafic bloqué (reconnexions épuisées)',
  ].join('\n');

  it('établi quand le réglage atteint le service, que l’interface est posée et qu’aucun trafic ne sort', () => {
    const r = analyserCapture(pose, '7', { traficPasse: 'non' });
    assert.equal(r.verdict, ETABLI);
  });

  it('CONTREDIT quand l’app promet un blocage qu’elle n’applique pas', () => {
    const r = analyserCapture(
      [pose, '01-01 00:00:02.000 W/SXB-VPN(1): [SXB_DEBUG] KILL_SWITCH_BLACKHOLE_FAILED reason=test'].join('\n'),
      '7', { traficPasse: 'non' },
    );
    assert.equal(r.verdict, CONTREDIT);
  });

  it('CONTREDIT quand du trafic sort malgré le blocage annoncé', () => {
    const r = analyserCapture(pose, '7', { traficPasse: 'oui' });
    assert.equal(r.verdict, CONTREDIT);
  });

  it('l’effet réseau ne passe jamais au vert sans déclaration', () => {
    // Le journal ne mesure pas le réseau. Il ne doit donc jamais suffire.
    const r = analyserCapture(pose, '7');
    assert.equal(r.verdict, NON_OBSERVE);
  });

  it('point 8 — établi quand le blocage est retiré et l’internet revenu', () => {
    const r = analyserCapture(
      '01-01 00:00:00.000 I/SXB-VPN(1): [SXB_DEBUG] KILL_SWITCH_BLACKHOLE_RELEASED',
      '8', { internetRevenu: 'oui' },
    );
    assert.equal(r.verdict, ETABLI);
  });

  it('point 8 — CONTREDIT si l’internet ne revient pas', () => {
    const r = analyserCapture(
      '01-01 00:00:00.000 I/SXB-VPN(1): [SXB_DEBUG] KILL_SWITCH_BLACKHOLE_RELEASED',
      '8', { internetRevenu: 'non' },
    );
    assert.equal(r.verdict, CONTREDIT);
  });
});

describe('§17.5 point 9 — le journal partagé ne doit rien laisser fuir', () => {
  it('établi sur un texte partagé sans forme sensible', () => {
    const texte = [
      'SXB VPN — journal technique',
      '12:00:01  Tunnel établi (interface prête, compteurs lisibles)',
      '12:00:02  Données en transit — 4.0 Ko',
    ].join('\n');
    const r = analyserCapture(texte, '9', { relectureOk: 'oui' });
    assert.equal(r.verdict, ETABLI);
  });

  it('CONTREDIT si une adresse IP a fui', () => {
    const r = analyserCapture('12:00:01  connexion vers 203.0.113.45', '9', { relectureOk: 'oui' });
    assert.equal(r.verdict, CONTREDIT);
    assert.match(r.criteres[0].preuve, /adresse IPv4/);
  });

  it('CONTREDIT si un nom d’hôte a fui', () => {
    const r = analyserCapture('12:00:01  vers relais.exemple.com', '9', { relectureOk: 'oui' });
    assert.equal(r.verdict, CONTREDIT);
  });

  it('CONTREDIT si des identifiants figurent dans une URL', () => {
    const r = analyserCapture('12:00:01  ssh://jean:secret@passerelle', '9', { relectureOk: 'oui' });
    assert.equal(r.verdict, CONTREDIT);
  });

  it('CONTREDIT si une clé privée a fui', () => {
    const r = analyserCapture('-----BEGIN OPENSSH PRIVATE KEY-----', '9', { relectureOk: 'oui' });
    assert.equal(r.verdict, CONTREDIT);
  });

  it('CONTREDIT si un jeton long a fui', () => {
    const r = analyserCapture(
      '12:00:01  jeton eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijkl',
      '9', { relectureOk: 'oui' },
    );
    assert.equal(r.verdict, CONTREDIT);
  });

  it('l’adresse interne du Kill Switch n’est pas comptée comme une fuite', () => {
    // 10.63.63.1 est l'adresse de l'interface trou noir, constante du code et
    // sans rapport avec un serveur de l'utilisateur.
    const r = analyserCapture('12:00:01  interface locale 10.63.63.1', '9', { relectureOk: 'oui' });
    assert.equal(r.verdict, ETABLI);
  });

  it('non observé si l’opérateur n’a pas relu', () => {
    const r = analyserCapture('12:00:01  Tunnel établi', '9');
    assert.equal(r.verdict, NON_OBSERVE);
  });
});

describe('le harnais ne cite que des marqueurs réellement émis', () => {
  const service = readFileSync(
    resolve(import.meta.dirname, '..', 'modules', 'android-native', 'SxbVpnService.kt'),
    'utf8',
  );

  // Sans ce contrôle, le harnais pourrait guetter des traces qui n'existent
  // pas : il rendrait « non observé » pour toujours, et cette impuissance
  // passerait pour une absence de défaut.
  for (const stage of ['TUN_CREATED', 'TUNNEL_TRAFFIC_CONFIRMED', 'VPN_FAILED']) {
    it(`le service émet bien trace("${stage}", …)`, () => {
      assert.match(service, new RegExp(`trace\\("${stage}"`));
    });
  }

  it('le service émet bien les lignes du Kill Switch guettées', () => {
    assert.match(service, /Kill Switch : \$\{if \(enabled\) "activé" else "désactivé"\}/);
    assert.match(service, /Kill Switch actif — trafic bloqué/);
    assert.match(service, /KILL_SWITCH_BLACKHOLE_FAILED/);
    assert.match(service, /KILL_SWITCH_BLACKHOLE_RELEASED/);
  });

  it('l’étiquette logcat guettée est celle du service', () => {
    assert.match(service, /const val TAG\s+= "SXB-VPN"/);
    assert.ok(ETIQUETTES.includes('SXB-VPN'));
  });
});

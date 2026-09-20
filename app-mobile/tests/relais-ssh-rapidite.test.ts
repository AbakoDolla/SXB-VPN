/**
 * Rapidité du relais SSH.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI RENDAIT LES CONFIGURATIONS SSH LENTES
 * ═══════════════════════════════════════════════════════════════════════════
 * Le relais SOCKS5 qui porte tout le trafic SSH armait un délai de lecture de
 * 30 secondes pour la négociation SOCKS — ce qui est juste — mais le laissait
 * armé PENDANT LE RELAIS.
 *
 * Or un téléchargement n'envoie presque rien : le client émet sa requête, puis
 * ne fait plus qu'écouter. Le sens MONTANT devient donc inactif, sa lecture
 * expire au bout de 30 s, l'exception est avalée par un `catch` vide, et le
 * canal SSH est ferme. Tout transfert durant plus de 30 secondes etait coupe
 * net, comme toute connexion maintenue ouverte.
 *
 * Ce banc ne peut pas ouvrir un tunnel SSH. Il verrouille donc ce qui est
 * VERIFIABLE dans la source native, et qui suffit a empecher le retour de
 * chacune des trois causes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const natif = path.resolve(__dirname, '..', 'modules', 'android-native');
const service = readFileSync(path.join(natif, 'SxbVpnService.kt'), 'utf8');

/** Le relais SOCKS5 complet : l'accepteur et le traitement d'une connexion. */
function relaisSocks(): string {
  const debut = service.indexOf('private fun startLocalSocks5Server(');
  assert.ok(debut > 0, 'le serveur SOCKS5 doit exister');
  assert.ok(service.indexOf('private fun handleSocks5Client(', debut) > debut,
    'le traitement d’une connexion doit suivre l’accepteur');
  const fin = service.indexOf('// STATISTIQUES DE TRAFIC', debut);
  assert.ok(fin > debut, 'la fin du relais doit être repérable');
  return service.slice(debut, fin);
}

/**
 * Le même bloc, COMMENTAIRES RETIRÉS.
 *
 * Un test qui cherche un nom se déclenche sur le commentaire qui l'explique :
 * ma propre note décrivant l'ancien `join(300_000)` faisait échouer le test
 * censé vérifier sa disparition. On vise donc le code, jamais le texte.
 */
function relaisSansCommentaires(): string {
  return relaisSocks()
    .split('\n')
    .filter(ligne => !ligne.trim().startsWith('//'))
    .join('\n');
}

describe('rapidité du relais SSH', () => {
  it('désarme le délai de lecture avant de relayer', () => {
    const code = relaisSansCommentaires();

    // Le délai protège la négociation : il doit rester.
    assert.ok(code.includes('client.soTimeout = 30_000'),
      'la négociation SOCKS doit rester protégée par un délai');

    // ── Le test doit viser la BRANCHE TCP, et elle seule ──────────────────
    //
    // Ma première version cherchait le dernier `client.soTimeout = 0` du
    // bloc. Elle passait même après avoir retiré la correction : elle
    // trouvait celui de la branche UDP, situé plus haut, et le jugeait donc
    // « avant la boucle ». Vérifié à l'envers — d'où ce découpage strict.
    const ouvertureCanal = code.indexOf('session.openChannel("direct-tcpip")');
    const boucle = code.indexOf('val chOut = channel.outputStream');
    assert.ok(ouvertureCanal > 0, 'le canal direct-tcpip doit être ouvert');
    assert.ok(boucle > ouvertureCanal, 'la boucle montante doit suivre le canal');

    const brancheTcp = code.slice(ouvertureCanal, boucle);
    assert.ok(brancheTcp.includes('client.soTimeout = 0'),
      'le délai doit être désarmé ENTRE l’ouverture du canal et le relais : ' +
      'sinon toute connexion inactive 30 s — donc tout téléchargement, dont ' +
      'le sens montant se tait — est coupée net.');
  });

  it('désactive Nagle sur la socket du relais', () => {
    const code = relaisSansCommentaires();
    const ouvertureCanal = code.indexOf('session.openChannel("direct-tcpip")');
    const boucle = code.indexOf('val chOut = channel.outputStream');
    assert.ok(/client\.tcpNoDelay = true/.test(code.slice(ouvertureCanal, boucle)),
      'sans TCP_NODELAY posé avant le relais, chaque petit envoi est retenu ' +
      'jusqu’à ~40 ms, ce qui rend la navigation poussive sur un tunnel latent');
  });

  it('n’impose plus de plafond de durée arbitraire à une connexion', () => {
    const code = relaisSansCommentaires();
    assert.ok(!code.includes('join(300_000)'),
      'un plafond de cinq minutes coupait les longues connexions ; ' +
      'la fin du relais doit venir de la fermeture, pas d’un minuteur');
    assert.ok(!/\bthreadA\b/.test(code),
      'le fil montant dédié a été remplacé par le fil de la connexion');
  });

  it('ne journalise pas chaque connexion sur le chemin des données', () => {
    const code = relaisSansCommentaires();
    // `broadcastLog` masque par expressions régulières puis prend un VERROU
    // GLOBAL. Cinq appels par connexion, et des dizaines de connexions par
    // page, sérialisaient tous ces fils sur le même verrou.
    //
    // Ces quatre étapes sont IGNORÉES par le journal technique (vérifié dans
    // `journalTechnique.ts` : elles ne figurent pas dans `ETAPES`). Les taire
    // hors diagnostic ne retire donc rien à ce que voit l'utilisateur.
    for (const etape of [
      'SOCKS5_CLIENT_ACCEPT', 'SOCKS5_REQUEST',
      'SOCKS5_TARGET_RESOLVED', 'SSH_DIRECT_TCPIP_CONNECTED',
    ]) {
      const ligne = code.split('\n').find(l => l.includes(etape));
      assert.ok(ligne, `la trace ${etape} doit exister`);
      assert.ok(ligne!.includes('traceConnexion('),
        `${etape} doit passer par traceConnexion (sinon verrou global par connexion)`);
    }
    // Celle-ci, en revanche, est la SEULE que le journal affiche
    // (`tech_relay_closed`) : elle doit rester inconditionnelle, sans quoi la
    // correction de performance retirerait une information visible.
    const fermeture = code.split('\n').find(l => l.includes('SOCKS5_RELAY_CLOSED'));
    assert.ok(fermeture?.includes('broadcastLog('),
      'SOCKS5_RELAY_CLOSED alimente le journal technique : elle doit rester émise');
    // Une erreur, elle, reste TOUJOURS visible : c'est rare et c'est utile.
    assert.ok(/broadcastLog\("\[SXB_TRACE\] stage=SOCKS5_ERROR/.test(code),
      'une erreur de relais doit rester journalisée sans condition');
  });

  it('ne tait aucune étape que le journal technique affiche', () => {
    // Garde-fou contre une optimisation trop zélée : si quelqu'un conditionne
    // une étape que le journal montre, l'information disparaîtrait de
    // l'écran sans que rien ne le signale.
    const journal = readFileSync(
      path.join(__dirname, '..', 'services', 'journalTechnique.ts'), 'utf8');
    const bloc = journal.slice(journal.indexOf('const ETAPES'));
    const montrees = [...bloc.matchAll(/^ {2}([A-Z0-9_]+):/gm)].map(m => m[1]);
    assert.ok(montrees.includes('SOCKS5_RELAY_CLOSED'),
      'le journal doit continuer d’afficher la fermeture de relais');

    const code = relaisSansCommentaires();
    for (const etape of montrees) {
      const ligne = code.split('\n').find(l => l.includes(`stage=${etape}`));
      if (!ligne) continue; // étape émise ailleurs que dans le relais
      assert.ok(!ligne.includes('traceConnexion('),
        `${etape} est affichée par le journal : elle ne doit pas être conditionnée`);
    }
  });

  it('traceConnexion n’émet que sous diagnostic actif', () => {
    const bloc = service.slice(service.indexOf('private fun traceConnexion'));
    assert.ok(/if \(SxbSecureLogger\.isDiagnosticEnabled\(\)\) broadcastLog\(message\)/.test(bloc),
      'traceConnexion doit se taire hors diagnostic');
  });

  it('garde le relais bidirectionnel intact', () => {
    const code = relaisSansCommentaires();
    // La correction ne doit pas avoir supprimé un sens de circulation.
    assert.ok(code.includes('uploadBytes.addAndGet'), 'le sens montant doit compter ses octets');
    assert.ok(code.includes('downloadBytes.addAndGet'), 'le sens descendant doit compter ses octets');
    assert.ok(code.includes('"Socks5-Down"'), 'le fil descendant doit subsister');
    assert.ok(/runCatching \{ channel\.disconnect\(\) \}/.test(code),
      'la fermeture du canal doit débloquer le fil descendant');
  });

  it('laisse la branche UDP inchangée', () => {
    const code = relaisSansCommentaires();
    // Elle désarmait déjà le délai, pour la même raison ; on vérifie qu'on ne
    // l'a pas abîmée en corrigeant la branche TCP.
    const udp = code.indexOf('if (command == 3)');
    const associate = code.indexOf('.associate(client, din, dout');
    assert.ok(udp > 0 && associate > udp, 'la branche UDP doit rester en place');
    assert.ok(code.slice(udp, associate).includes('client.soTimeout = 0'),
      'la branche UDP doit continuer de désarmer le délai');
  });
});

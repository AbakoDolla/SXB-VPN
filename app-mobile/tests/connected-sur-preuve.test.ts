/**
 * « CONNECTÉ » DOIT SE MÉRITER.
 *
 * LE CAS RÉEL, tel qu'il est arrivé :
 *
 *   L'application annonçait une connexion réussie alors qu'aucun octet
 *   n'avait traversé le tunnel. L'utilisateur voyait « connecté », puis
 *   aucune page ne s'ouvrait. C'est le reproche central du client.
 *
 *   La cause n'était pas une ligne fautive mais DEUX CORRECTIFS QUI SE SONT
 *   NEUTRALISÉS. `openTun()` avait été corrigé pour publier « handshaking »
 *   au lieu de « connected », afin d'attendre une preuve de flux. Mais
 *   `startLibboxService()` conservait un repli « on s'assure que l'état est
 *   bien connected (déjà fait normalement dans openTun) » — commentaire
 *   devenu faux. Ce repli s'exécutait au retour de `service.start()` et
 *   écrasait systématiquement l'attente.
 *
 *   Pire : la vérification honnête de `writeLog()` exige
 *   `currentState == "handshaking"`. Le repli la rendait INATTEIGNABLE.
 *
 * Ces contrôles lisent le VRAI code natif, pour que le repli ne puisse pas
 * revenir sans faire échouer la suite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const mobile = path.resolve(__dirname, '..');
const lire = (relative: string) => readFileSync(path.join(mobile, relative), 'utf8');

const service = lire('modules/android-native/SxbVpnService.kt');
const politique = lire('modules/android-native/SxbHandshakeProofPolicy.kt');
const trafic = lire('modules/android-native/TrafficStatsManager.kt');

describe('« connected » n’est publié que sur preuve d’acheminement', () => {
  it('ne connaît qu’une seule porte vers « connected »', () => {
    // Le défaut venait de la MULTIPLICITÉ des chemins : tant qu'il en existe
    // plusieurs, un correctif peut en annuler un autre sans que rien ne le
    // signale. Un seul point de publication rend la règle vérifiable.
    const publications = service.match(/setCurrentState\("connected"\)/g) ?? [];
    assert.equal(
      publications.length,
      1,
      'un seul setCurrentState("connected") doit exister, dans promoteToConnected()',
    );
    assert.match(service, /private fun promoteToConnected\(/);
  });

  it('refuse de promouvoir un état qui n’est pas « handshaking »', () => {
    // Sans ce garde-fou, une promotion tardive pourrait ressusciter une
    // session déjà en erreur ou déjà arrêtée.
    const corps = service.slice(service.indexOf('private fun promoteToConnected('));
    assert.match(corps.slice(0, 1200), /if \(currentState != "handshaking"\) return/);
    assert.match(corps.slice(0, 1200), /if \(!running\.get\(\)\) return/);
  });

  it('ne rétablit jamais le repli « on s’assure que l’état est bien connected »', () => {
    // La formulation exacte du repli supprimé, et sa forme générique.
    assert.doesNotMatch(service, /déjà fait normalement dans openTun/);
    assert.doesNotMatch(
      service,
      /if \(currentState != "connected"\) \{\s*\n?\s*broadcastStatus\("connected"\)/,
    );
  });

  it('fait passer TOUS les chemins par « handshaking », y compris le relais SSH', () => {
    // Le relais SSH était explicitement exclu (`&& !isSshRelay`) : il restait
    // donc en « connecting » et ne pouvait être promu que par le repli.
    assert.doesNotMatch(service, /currentState == "connecting" && !isSshRelay/);
    assert.match(service, /startHandshakeProver\(/);
  });

  it('mesure le RETOUR, jamais l’intention d’émettre', () => {
    // `tx_bytes` progresse dès qu'une application tente d'émettre, même vers
    // un tunnel mort : s'y fier reviendrait à simuler la preuve.
    assert.match(trafic, /fun returnBytesSinceTunAttach\(\): Long/);
    assert.match(trafic, /if \(deltaRx > 0L\) tunReturnBytes\.addAndGet\(deltaRx\)/);
    // Aucun champ d'émission ne doit entrer dans la décision. La prose du
    // fichier cite `tx_bytes` pour expliquer son exclusion : on vise donc la
    // déclaration, pas le commentaire.
    assert.doesNotMatch(politique, /val tx[A-Za-z]*Bytes/);
    assert.doesNotMatch(politique, /uploadBytes/);
  });

  it('remet le compteur de preuve à zéro à chaque attache du TUN', () => {
    // Sinon une session suivante hériterait de la preuve de la précédente.
    const attache = trafic.slice(trafic.indexOf('fun attachTunInterface('));
    assert.match(attache.slice(0, 1400), /tunReturnBytes\.set\(0L\)/);
  });

  it('borne l’attente et distingue les deux issues possibles', () => {
    // Sans borne, un tunnel muet laisserait l'utilisateur en « négociation »
    // indéfiniment. Avec une borne aveugle, un appareil dont les compteurs
    // noyau sont illisibles verrait échouer un tunnel pourtant sain.
    assert.match(politique, /FAIL_NO_TRAFFIC/);
    assert.match(politique, /PROMOTE_PRESUMED/);
    assert.match(politique, /DEFAULT_TIMEOUT_MS = 60_000L/);
    assert.match(service, /failVpn\("TUNNEL_STALLED"/);
  });

  it('annonce l’état présumé comme présumé, jamais comme une mesure', () => {
    // §8.A — un état synthétique est autorisé à condition d'être présenté
    // comme tel. « ÉTAT PRÉSUMÉ » doit rester visible dans le journal.
    assert.match(service, /ÉTAT PRÉSUMÉ/);
    assert.match(service, /TUNNEL_PROOF_UNMEASURABLE/);
  });

  it('libère le fil de preuve au nettoyage', () => {
    // Un fil survivant pourrait publier « connected » sur la session suivante.
    const nettoyage = service.slice(service.indexOf('trace("CLEANUP_START"'));
    assert.match(nettoyage.slice(0, 900), /handshakeProver\?\.interrupt\(\)/);
    assert.match(nettoyage.slice(0, 900), /handshakeProver = null/);
  });
});

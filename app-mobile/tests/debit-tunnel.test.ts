/**
 * Débit du tunnel après connexion.
 *
 * Ces tests lisent le SOURCE natif. Ils ne remplacent pas une mesure réelle :
 * ils garantissent que les trois décisions prises pour le débit restent en
 * place, car chacune est invisible à la lecture rapide et facile à annuler par
 * mégarde lors d'une refonte.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (relative: string) => readFileSync(path.join(mobile, relative), 'utf8');

const natif = lire('modules/android-native/SxbVpnService.kt');
const securite = lire('modules/android-native/SecurityModule.kt');

describe('QUIC est refusé quand le tunnel ne peut pas porter d’UDP', () => {
  it('refuse UDP/443 vers l’outbound « block », et non vers le proxy', () => {
    // Un simple reroutage ne suffirait pas : c'est le REFUS qui fait basculer
    // le navigateur en HTTP/2 sans attendre l'expiration de son délai QUIC.
    const regle = natif.slice(natif.indexOf('private fun quicBlockRule'));
    assert.match(regle, /\.put\("network", "udp"\)/);
    assert.match(regle, /\.put\("port", JSONArray\(\)\.put\(443\)\)/);
    assert.match(regle, /\.put\("outbound", "block"\)/);
  });

  it('ne vise QUE les transports en flux HTTP, jamais les sorties UDP natives', () => {
    // Hysteria2, TUIC et WireGuard relaient l'UDP correctement : pour elles
    // QUIC est un GAIN. Les inclure ici transformerait une optimisation en
    // régression silencieuse du débit.
    const ligne = natif.match(/private val TRANSPORTS_SANS_UDP = setOf\(([^)]*)\)/);
    assert.ok(ligne, 'TRANSPORTS_SANS_UDP introuvable');
    const valeurs = ligne[1].split(',').map((v) => v.trim().replace(/"/g, ''));
    for (const attendu of ['ws', 'websocket', 'httpupgrade', 'http', 'h2', 'http2', 'grpc']) {
      assert.ok(valeurs.includes(attendu), `transport sans UDP manquant : ${attendu}`);
    }
    for (const interdit of ['tcp', 'quic', 'hysteria2', 'tuic', 'wireguard', '']) {
      assert.ok(!valeurs.includes(interdit), `transport à relais UDP inclus à tort : ${interdit}`);
    }
  });

  it('laisse toujours l’exploitant reprendre la main', () => {
    const regle = natif.slice(natif.indexOf('private fun quicBlockRule'));
    assert.match(regle, /optBoolean\("autoriserQuic", false\)/);
    assert.match(regle, /optBoolean\("allowQuic", false\)/);
    assert.match(regle, /if \(!sansUdp\) return null/);
  });

  it('est posé par les DEUX constructeurs de configuration', () => {
    // Un profil canonique et un profil sing-box importé produisent deux
    // chemins distincts : n'en couvrir qu'un laisserait la moitié des
    // utilisateurs avec le délai mort.
    const occurrences = natif.match(/quicBlockRule\(cfg,/g) ?? [];
    assert.equal(occurrences.length, 2, 'les deux constructeurs doivent poser la règle');
    assert.match(natif, /quicBlockRule\(cfg, transportSansUdp\(transport\.network\)\)/);
    assert.match(natif, /quicBlockRule\(cfg, transportSansUdp\(transportDeLaSortie\(outbounds, finalTag\)\)\)/);
  });

  it('suit les groupes et les chaînages pour trouver le transport réel', () => {
    // Avec une bascule d'amonts, `route.final` désigne un GROUPE, qui ne porte
    // aucun transport : sans cette descente, la règle ne se poserait jamais
    // précisément sur les profils les plus fragiles.
    const fn = natif.slice(natif.indexOf('private fun transportDeLaSortie'));
    assert.match(fn, /optJSONArray\("outbounds"\)/);
    assert.match(fn, /optString\("detour", ""\)/);
    assert.match(fn, /if \(profondeur > 6 \|\| tag\.isEmpty\(\)\) return ""/);
  });
});

describe('le masquage des journaux ne freine plus le chemin des données', () => {
  it('compile chaque motif UNE SEULE FOIS, hors des fonctions', () => {
    // Ces fonctions tournent sur le rappel de journalisation du moteur.
    // Recompiler les automates à chaque ligne s'exerçait en contre-pression
    // directe sur le tunnel dès que le réseau perdait des paquets.
    for (const motif of [
      'MOTIF_IPV4', 'MOTIF_IPV6', 'MOTIF_UUID', 'MOTIF_JETON_SXB', 'MOTIF_BEARER',
      'MOTIF_JWT', 'MOTIF_URL', 'MOTIF_HOTE', 'MOTIF_CLE_VALEUR', 'MOTIF_BASE64',
    ]) {
      assert.match(securite, new RegExp(`private val ${motif} = Regex\\(`), `motif non compilé : ${motif}`);
    }
    assert.match(securite, /private val MOTIFS_IDENTIFIANTS: List<Regex> =/);
  });

  it('ne construit plus AUCUNE expression dans le corps des deux fonctions', () => {
    const debut = securite.indexOf('fun maskSensitive(');
    const fin = securite.indexOf('// ── Leurres anti-rétro-ingénierie');
    assert.ok(debut > 0 && fin > debut, 'bornes de masquage introuvables');
    const corps = securite.slice(debut, fin);
    assert.ok(!corps.includes('Regex('), 'une expression est encore compilée par appel');
  });

  it('conserve exactement les mêmes motifs qu’avant — aucun masquage affaibli', () => {
    // Le gain de vitesse ne doit RIEN retirer à la protection : chaque motif
    // d'origine doit se retrouver à l'identique dans sa version compilée.
    const attendus = [
      String.raw`(\d{1,3}\.){3}\d{1,3}(:\d+)?`,
      String.raw`[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}`,
      String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`,
      String.raw`SXB-[A-Z]+-[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+`,
      String.raw`Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,
      String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
      String.raw`https?://[^\s"']+`,
      String.raw`[a-zA-Z0-9-]{2,63}\.[a-zA-Z]{2,6}(:\d+)?`,
      String.raw`(password|passwd|key|token|secret|uuid|user|username|deviceId|payload|host|server)[=:]\s*\S+`,
      String.raw`[A-Za-z0-9+/]{20,}={0,2}`,
    ];
    for (const motif of attendus) {
      assert.ok(securite.includes(motif), `motif d'origine perdu : ${motif}`);
    }
    // Les clés d'authentification restent toutes couvertes.
    for (const cle of ['password', 'passwd', 'token', 'secret', 'authorization', 'cookie', 'api-key', 'api_key']) {
      assert.ok(securite.includes(`"${cle}"`), `clé d'identifiant perdue : ${cle}`);
    }
  });

  it('ne masque une ligne que si elle est réellement utilisée', () => {
    // La branche NORMAL — de loin la plus fréquente sur un lien mobile — jette
    // la ligne aussitôt, et le logger de diagnostic est un no-op en release.
    const fn = natif.slice(natif.indexOf('override fun writeLog('));
    assert.match(fn, /val safeMessage by lazy\(LazyThreadSafetyMode\.NONE\) \{/);
    assert.match(fn, /if \(SxbSecureLogger\.isDiagnosticEnabled\(\)\) SxbSecureLogger\.debug\("LIBBOX_LOG: \$safeMessage"\)/);
    // La classification et les sorties restent inchangées.
    assert.match(fn, /EngineEvent\.NORMAL -> \{ \/\* diagnostic local uniquement \*\/ \}/);
  });
});

describe('les réglages de tunnel qui portent le débit restent en place', () => {
  it('garde la pile « system » et un grand MTU', () => {
    // La pile système traite les paquets dans le noyau ; gvisor les remonte en
    // espace utilisateur et coûte plusieurs dizaines de pour cent de débit.
    const tun = natif.slice(natif.indexOf('private fun tunInbound('));
    assert.match(tun, /put\("stack", "system"\)/);
    const politique = lire('modules/android-native/SxbTunnelPolicy.kt');
    const mtu = politique.match(/const val DEFAULT_MTU = (\d+)/);
    assert.ok(mtu, 'DEFAULT_MTU introuvable');
    assert.ok(Number(mtu[1]) >= 1500, 'un MTU réduit multiplie les appels système par paquet');
  });

  it('n’active jamais le multiplexage de sa propre initiative', () => {
    // Le multiplexage réduit le nombre de poignées de main, mais sérialise les
    // flux dans une seule connexion : sur un lien mobile, il PLAFONNE le débit.
    // Il ne doit exister que si le profil le demande explicitement.
    assert.match(natif, /if \(mux\?\.optBoolean\("enabled", false\) == true\)/);
    assert.ok(
      !/put\("multiplex", JSONObject\(\)\.put\("enabled", true\)\)/.test(natif),
      'le multiplexage ne doit jamais être imposé par l’application',
    );
  });
});

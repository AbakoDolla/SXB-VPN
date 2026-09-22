/**
 * Le résolveur employé À TRAVERS le tunnel.
 *
 * LE CAS RÉEL, tel qu'il est arrivé :
 *
 *   Un client reste « en chargement » pendant une minute sans jamais aboutir,
 *   alors qu'un client ordinaire, sur le MÊME téléphone et le MÊME réseau,
 *   joint le serveur en une seconde et navigue en quatre. Ses journaux le
 *   disent en toutes lettres : « connected to server » puis « Preferred DNS
 *   8.8.8.8 », « dns forwarding enable », « happy surfing ».
 *
 *   Notre moteur, lui, imposait `https://1.1.1.1/dns-query` — du DoH — comme
 *   résolveur du tunnel. Avant de résoudre LE PREMIER NOM, il devait donc mener
 *   une négociation TLS complète vers Cloudflare À L'INTÉRIEUR du tunnel :
 *   plusieurs allers-retours et une validation de certificat, sur un lien
 *   mobile qui est précisément le plus mauvais moment pour en demander autant.
 *   Tant qu'elle n'aboutissait pas, aucun nom ne se résolvait, donc aucune
 *   connexion ne traversait le proxy — et l'application restait indéfiniment
 *   sur « négociation en cours », tunnel pourtant debout.
 *
 *   Ce chiffrement était de surcroît redondant : la requête voyage déjà dans le
 *   tunnel. DoH ne protégeait rien de plus, et coûtait le prix fort.
 *
 * Ces contrôles lisent le VRAI code natif.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const natif = readFileSync(
  path.join(path.resolve(__dirname, '..'), 'modules/android-native/SxbVpnService.kt'),
  'utf8',
);

/**
 * Le code, sans la prose qui l'explique.
 *
 * Seuls les blocs `/* … *\/` sont retirés : ils abritent les commentaires qui
 * CITENT l'ancienne valeur, et une citation ne doit pas ressembler au défaut.
 * Les commentaires de fin de ligne, eux, sont laissés en place — les couper
 * amputerait toute chaîne contenant « // », à commencer par une URL, ce qui
 * rendrait le garde aveugle à ce qu'il doit précisément voir.
 */
const code = natif.replace(/\/\*[\s\S]*?\*\//g, '');

describe('résolveur du tunnel', () => {
  it('n’impose plus DoH pour résoudre le premier nom', () => {
    // Plus aucun DoH codé en dur : ni sur le chemin sing-box, ni sur le relais
    // SSH, qui souffrait exactement de la même attente.
    assert.doesNotMatch(code, /https:\/\/1\.1\.1\.1\/dns-query/);
    assert.doesNotMatch(code, /https:\/\/[^"]*\/dns-query/);
  });

  it('interroge le résolveur du tunnel en TCP, jamais en UDP', () => {
    // Un tunnel WebSocket derrière un frontal ne relaie presque jamais l'UDP,
    // et une sortie de type Cloud Run n'en émet pas du tout : une requête DNS
    // en UDP se perdrait en silence, ce qui est indiscernable d'un tunnel mort.
    assert.match(natif, /private const val RESOLVEUR_TUNNEL = "tcp:\/\/8\.8\.8\.8"/);
    // Les deux chemins — sing-box et relais SSH — emploient la même constante.
    const emplois = natif.match(/\bRESOLVEUR_TUNNEL\b/g) ?? [];
    assert.ok(emplois.length >= 3, `la constante doit servir aux deux chemins (vu : ${emplois.length})`);
  });

  it('ne fait sortir un résolveur public que PAR le tunnel', () => {
    // Hors tunnel, seul le résolveur du réseau est joignable sur un forfait qui
    // ne décompte qu'un domaine : un DNS public y serait filtré ou facturé.
    assert.match(natif, /val dansLeTunnel = detourTag != "direct"/);
    assert.match(
      natif,
      /\.put\("address", if \(dansLeTunnel\) RESOLVEUR_TUNNEL else bootstrapDnsAddress\(\)\)/,
    );
    assert.match(natif, /\.put\("tag", "dns-local"\)\.put\("address", bootstrapDnsAddress\(\)\)/);
  });

  it('respecte le résolveur choisi par l’exploitant, en corrigeant son transport', () => {
    // Un schéma explicite est un choix : il passe intact. Une IP nue, elle,
    // serait interrogée en UDP — donc perdue. Même serveur, transport corrigé.
    assert.match(natif, /value\.contains\(":\/\/"\) -> value/);
    assert.match(natif, /else -> "tcp:\/\/\$value"/);
  });

  it('redirige le DNS local vers le résolveur réseau Android', () => {
    // `local` ne doit jamais déléguer à /etc/resolv.conf du résolveur Go :
    // Android expose ses DNS via ConnectivityManager.
    assert.match(natif, /usesSystemDns = value\.equals\("local", ignoreCase = true\)/);
    assert.match(natif, /usesSystemDns -> bootstrapDnsAddress\(\)/);
    assert.match(natif, /if \(usesSystemDns\) "direct" else "proxy"/);
  });

  it('garde le résolveur d’amorçage hors du tunnel, sous peine de boucle', () => {
    // Le nom du serveur de sortie doit être résolu SANS le proxy : le résoudre
    // dedans exigerait le tunnel, qui exige la résolution.
    assert.match(natif, /\.put\("strategy", dnsStrategy\(\)\)\.put\("detour", "direct"\)/);
    assert.ok(natif.includes('private fun applyDnsLoopGuard'));
  });
});

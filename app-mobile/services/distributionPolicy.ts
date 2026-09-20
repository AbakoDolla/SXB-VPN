/**
 * distributionPolicy — SXB n'a plus qu'un seul canal de distribution.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER NE CONNAÎT PLUS QUE « direct »
 * ═══════════════════════════════════════════════════════════════════════════
 * L'application était bâtie pour DEUX canaux : l'APK distribué directement, et
 * une publication Google Play. Le propriétaire ne publie plus sur Play, et ce
 * second canal ne coûtait pas rien — il portait trois comportements qui
 * gênaient les utilisateurs réels :
 *
 *  1. UNE PORTE DE CHIFFREMENT qui refusait en bloc toute configuration
 *     VLESS / Trojan / Hysteria2 / TUIC sans TLS vérifié, VMess sans
 *     chiffrement reconnu, Shadowsocks sans AEAD, et toute configuration
 *     chaînée. C'est ce qui faisait qu'une même configuration V2Ray
 *     fonctionnait chez l'un et pas chez l'autre.
 *
 *  2. LA MISE À JOUR RENVOYÉE VERS LE STORE au lieu de télécharger l'APK.
 *     Sur une fiche Play qui n'existe plus, l'appareil n'aurait AUCUN moyen
 *     de se mettre à jour — donc resterait indéfiniment sur son moteur.
 *
 *  3. UN CONSENTEMENT bloquant avant toute connexion.
 *
 * Ces trois comportements existaient pour satisfaire les règles d'une boutique
 * qu'on n'utilise plus. Les garder derrière un interrupteur aurait laissé la
 * possibilité qu'un build les réactive par accident : le canal est donc retiré,
 * pas désactivé.
 *
 * Le type ne porte plus qu'une valeur. Tout code qui tenterait de distinguer
 * deux canaux cesse de compiler — c'est voulu.
 */
export type Distribution = 'direct';

/**
 * Canal de distribution — toujours « direct ».
 *
 * La signature accepte encore des marqueurs pour ne casser aucun appelant, et
 * les ignore délibérément : aucune valeur, d'où qu'elle vienne (variable
 * d'environnement, configuration Expo, module natif), ne peut plus rétablir un
 * second canal.
 */
export function resolveDistribution(..._markers: unknown[]): Distribution {
  return 'direct';
}

export const PRIVACY_URL = 'https://vpnsxb.afrihall.com/api/public/privacy';
export const DATA_DELETION_URL = 'https://vpnsxb.afrihall.com/api/public/data-deletion';

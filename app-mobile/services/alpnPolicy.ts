/**
 * Choix de l'ALPN pour les transports de type WebSocket.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ — un tunnel qui monte et ne transporte rien
 * ═══════════════════════════════════════════════════════════════════════════
 * Symptôme rapporté : la connexion se déclare établie, l'écran affiche même un
 * débit honorable, mais aucune page ne se charge. La même configuration
 * fonctionne dans d'autres clients.
 *
 * Enchaînement réel :
 *
 *  1. Le moteur applique uTLS « chrome » dès que TLS est actif — c'est
 *     volontaire, un ClientHello de la bibliothèque Go se repère et se bride.
 *  2. Le ClientHello de Chrome annonce `h2` AVANT `http/1.1`.
 *  3. Un frontal moderne (Cloudflare, Google Front End, Cloud Run…) choisit
 *     donc `h2`.
 *  4. Or le transport WebSocket de sing-box parle « HTTP/1.1 Upgrade ». Le
 *     WebSocket sur HTTP/2 exige l'Extended CONNECT de la RFC 8441, qu'il
 *     n'émet pas.
 *  5. La poignée de main TLS réussit — d'où le « connecté » —, l'upgrade
 *     échoue, et plus rien ne passe.
 *
 * Le débit affiché vient des compteurs de l'interface TUN : il mesure ce que le
 * système ÉCRIT DANS le tunnel, retransmissions comprises. Un relais cassé
 * produit donc un chiffre flatteur. Les deux symptômes ont la même origine.
 *
 * ANNONCER `http/1.1` retire l'ambiguïté : le frontal ne peut plus choisir h2,
 * et l'upgrade WebSocket aboutit.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUE CETTE RÈGLE NE FAIT JAMAIS
 * ═══════════════════════════════════════════════════════════════════════════
 * Elle n'écrase PAS un ALPN fourni par le profil. Un exploitant qui écrit
 * `alpn=h2` a une raison de le faire, et la deviner à sa place produirait une
 * panne impossible à diagnostiquer depuis le tableau de bord.
 *
 * Elle ne s'applique qu'aux transports qui négocient un Upgrade HTTP/1.1 —
 * `ws` et `httpupgrade`. gRPC exige `h2` et ne doit surtout pas être touché ;
 * TCP nu n'a pas d'ALPN ; QUIC porte le sien.
 *
 * Elle n'a aucun effet sans TLS : l'ALPN est une extension de la poignée de
 * main TLS, l'imposer en clair n'aurait pas de sens.
 */

/** Transports qui négocient par un Upgrade HTTP/1.1, et eux seuls. */
const TRANSPORTS_UPGRADE = new Set(['ws', 'websocket', 'httpupgrade', 'http-upgrade']);

export const ALPN_UPGRADE = 'http/1.1';

/**
 * Rend l'ALPN à poser, ou `null` s'il ne faut rien poser.
 *
 * @param network  type de transport déclaré par le profil (`ws`, `grpc`, …)
 * @param tls      la couche TLS est-elle active
 * @param alpnDeja ALPN déjà fourni par le profil — respecté tel quel
 */
export function alpnPourTransport(
  network: string | null | undefined,
  tls: boolean,
  alpnDeja?: string | null,
): string | null {
  // Un choix explicite du profil prime toujours, même vide de sens : ce n'est
  // pas à la traduction de corriger l'exploitant.
  if (typeof alpnDeja === 'string' && alpnDeja.trim() !== '') return null;
  if (!tls) return null;
  const clef = String(network ?? '').trim().toLowerCase();
  return TRANSPORTS_UPGRADE.has(clef) ? ALPN_UPGRADE : null;
}

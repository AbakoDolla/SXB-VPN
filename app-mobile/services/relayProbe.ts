/**
 * Preuve de relais — le tunnel transporte-t-il RÉELLEMENT quelque chose ?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CE MODULE REND VISIBLE
 * ═══════════════════════════════════════════════════════════════════════════
 * Un tunnel peut se déclarer monté et ne rien transporter. C'est arrivé : la
 * poignée de main TLS aboutissait, l'état passait à « connecté », et aucune
 * page ne se chargeait. L'écran affichait même un débit honorable.
 *
 * Ce débit n'était pas faux, il était SANS RAPPORT avec ce qu'on croyait lire.
 * `TrafficStatsManager` lit les compteurs du noyau sur l'interface TUN : ils
 * mesurent ce que le système ÉCRIT DANS le tunnel, retransmissions comprises.
 * Quand le relais est cassé, les applications réessaient, et le compteur grimpe
 * d'autant plus vite que rien ne passe.
 *
 * Autrement dit : l'indicateur le plus rassurant de l'écran était alimenté par
 * l'échec lui-même.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA PREUVE : UNE REQUÊTE QUI TRAVERSE VRAIMENT
 * ═══════════════════════════════════════════════════════════════════════════
 * Le moteur route tout vers l'outbound `proxy` ; seules les adresses privées et
 * l'hôte du serveur VPN en sont exclus. Une requête vers l'API passe donc PAR
 * le tunnel. Si elle revient, le tunnel relaie — ce n'est pas une déduction,
 * c'est une observation.
 *
 * Le ping existait déjà sur l'accueil, mais sa valeur était remise à `null` à
 * chaque échec, sans mémoire : impossible de distinguer un creux réseau d'un
 * tunnel mort. C'est cette mémoire qu'on ajoute ici, et rien d'autre.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI TROIS ÉCHECS, ET NON UN SEUL
 * ═══════════════════════════════════════════════════════════════════════════
 * Une requête isolée échoue pour mille raisons qui ne disent rien du tunnel :
 * passage d'une antenne à l'autre, ascenseur, serveur qui redémarre. Annoncer
 * « aucune donnée ne passe » au premier échec ferait clignoter l'écran à chaque
 * creux, et l'utilisateur apprendrait très vite à ignorer le message — ce qui
 * est pire que de ne pas l'afficher.
 *
 * Trois échecs d'affilée, à dix secondes d'intervalle, c'est une demi-minute
 * sans qu'aucune donnée n'aboutisse. Là, ce n'est plus un creux.
 */

/** Seuil d'échecs consécutifs au-delà duquel le relais est déclaré rompu. */
export const ECHECS_AVANT_RUPTURE = 3;

export type EtatRelais =
  /** Le tunnel n'est pas monté : la question ne se pose pas. */
  | 'hors_ligne'
  /** Monté, mais aucune requête n'a encore abouti ni assez échoué. */
  | 'incertain'
  /** Une requête a traversé : le tunnel transporte. */
  | 'prouve'
  /** Assez d'échecs d'affilée pour conclure : monté, mais rien ne passe. */
  | 'rompu';

export interface SuiviRelais {
  echecsConsecutifs: number;
  /** Dernière latence obtenue, en millisecondes. `null` tant qu'aucune n'a abouti. */
  dernierPing: number | null;
}

export const SUIVI_INITIAL: SuiviRelais = { echecsConsecutifs: 0, dernierPing: null };

/** Une mesure a abouti : le compteur d'échecs repart de zéro. */
export function succes(suivi: SuiviRelais, latenceMs: number): SuiviRelais {
  return { echecsConsecutifs: 0, dernierPing: latenceMs };
}

/**
 * Une mesure a échoué.
 *
 * `dernierPing` est CONSERVÉ : l'effacer ferait disparaître la latence de
 * l'écran au premier creux, alors qu'on ne sait pas encore si le tunnel est
 * mort. Il n'est remis à zéro qu'à la déconnexion.
 */
export function echec(suivi: SuiviRelais): SuiviRelais {
  return { ...suivi, echecsConsecutifs: suivi.echecsConsecutifs + 1 };
}

/** Lit l'état à partir du suivi et de l'état du tunnel. */
export function etatRelais(suivi: SuiviRelais, tunnelMonte: boolean): EtatRelais {
  if (!tunnelMonte) return 'hors_ligne';
  if (suivi.echecsConsecutifs >= ECHECS_AVANT_RUPTURE) return 'rompu';
  // Une latence obtenue vaut preuve, même si un échec l'a suivie : le tunnel a
  // démontré qu'il transportait, et un échec isolé ne l'annule pas.
  if (suivi.dernierPing !== null && suivi.echecsConsecutifs === 0) return 'prouve';
  return 'incertain';
}

/**
 * Le débit peut-il être montré ?
 *
 * UNIQUEMENT quand le relais est prouvé. C'est toute la règle : sans preuve, le
 * chiffre viendrait des compteurs TUN, donc possiblement de l'échec lui-même.
 * Mieux vaut ne rien annoncer que d'annoncer une vitesse à quelqu'un dont la
 * connexion ne fonctionne pas.
 */
export function peutMontrerDebit(etat: EtatRelais): boolean {
  return etat === 'prouve';
}

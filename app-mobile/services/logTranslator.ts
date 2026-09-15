/**
 * Traduction des journaux du moteur en langage d'utilisateur.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * L'écran de diagnostic affichait les messages du moteur TELS QUELS. Or ces
 * messages sont écrits pour un développeur, et ils portent tout ce qu'il ne
 * faut pas montrer :
 *
 *   [CONFIG] proto=vless transport=ws tls=true sni_set=true host_hdr_set=true
 *   [SXB] connexion à crashlyticsreports-pa.googleapis.com:443 …
 *
 * Deux problèmes distincts, et c'est le second qui compte.
 *
 *  1. ILLISIBLE : « TUNNEL_REFUSED », « HTTP_UNEXPECTED », « proto=vless » ne
 *     disent rien à quelqu'un qui veut seulement savoir si sa connexion marche.
 *
 *  2. RÉVÉLATEUR : ces lignes exposent le protocole employé, le nom d'hôte, le
 *     port, le chemin WebSocket, parfois l'identifiant du compte. Quiconque
 *     ouvre l'écran — ou reçoit une capture — reconstitue la configuration.
 *     C'est précisément ce que l'exploitant vend.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE PRINCIPE : UNE LISTE BLANCHE, JAMAIS UN NETTOYAGE
 * ═══════════════════════════════════════════════════════════════════════════
 * On ne tente PAS d'effacer les passages sensibles d'une ligne pour montrer le
 * reste. Un masquage par expression régulière est une course perdue : il suffit
 * qu'un message évolue, ou qu'un cas non prévu passe, pour que la fuite
 * revienne — en silence, et sans que personne ne s'en aperçoive.
 *
 * On fait l'inverse. Chaque ligne du moteur est RECONNUE puis REMPLACÉE par une
 * phrase écrite à l'avance. Rien de la ligne d'origine n'est conservé. Ce qui
 * n'est reconnu par aucune règle devient un message générique — donc une ligne
 * inconnue ne peut pas fuir, elle disparaît.
 *
 * Le moteur n'est pas modifié : il continue d'écrire ses journaux complets, qui
 * restent disponibles côté natif pour un diagnostic d'exploitant.
 */

export type NiveauJournal = 'ok' | 'info' | 'attention' | 'echec';

export interface LigneJournal {
  /** Clé de traduction de la phrase montrée à l'utilisateur. */
  cle: string;
  niveau: NiveauJournal;
}

/**
 * Règles de reconnaissance, dans l'ordre d'évaluation.
 *
 * L'ORDRE COMPTE : les échecs sont testés AVANT les succès. Un message comme
 * « handshake failed » contient « handshake », et serait autrement annoncé
 * comme une réussite.
 */
const REGLES: Array<{ motif: RegExp; cle: string; niveau: NiveauJournal }> = [
  // ── Échecs ────────────────────────────────────────────────────────────────
  { motif: /AUTH_FAILED|authentication failed|invalid user|permission denied/i,
    cle: 'log_auth_failed', niveau: 'echec' },
  { motif: /QUOTA_EXHAUSTED|quota.*exhaust|exhausted/i,
    cle: 'log_quota_exhausted', niveau: 'echec' },
  { motif: /REVOKED|SUBSCRIPTION_REVOKED|access denied/i,
    cle: 'log_access_revoked', niveau: 'echec' },
  { motif: /CAPTIVE_PORTAL/i, cle: 'log_captive_portal', niveau: 'attention' },
  { motif: /DNS_FAILED|unable to resolve host|no such host|DNS query loopback/i,
    cle: 'log_dns_failed', niveau: 'echec' },
  { motif: /TIMEOUT|timed? ?out|deadline exceeded/i, cle: 'log_timeout', niveau: 'echec' },
  { motif: /TUNNEL_REFUSED|connection refused|ECONNREFUSED/i,
    cle: 'log_refused', niveau: 'echec' },
  { motif: /HTTP_UNEXPECTED|unexpected (status|response)|bad handshake|upgrade failed/i,
    cle: 'log_handshake_failed', niveau: 'echec' },
  { motif: /NETWORK_UNAVAILABLE|no network|network is unreachable/i,
    cle: 'log_no_network', niveau: 'attention' },
  { motif: /\berror\b|\bfailed\b|\bfatal\b|❌/i, cle: 'log_generic_error', niveau: 'echec' },

  // ── Reprise ───────────────────────────────────────────────────────────────
  { motif: /AUTO_RECONNECT|retry|reconnect/i, cle: 'log_reconnecting', niveau: 'attention' },
  { motif: /⚠️|\bwarn/i, cle: 'log_generic_warning', niveau: 'attention' },

  // ── Progression ───────────────────────────────────────────────────────────
  { motif: /permission|VpnService\.prepare/i, cle: 'log_permission', niveau: 'info' },
  { motif: /resolv|DNS lookup/i, cle: 'log_resolving', niveau: 'info' },
  { motif: /\[CONFIG\]|profile|config/i, cle: 'log_preparing', niveau: 'info' },
  { motif: /connecting|dialing|handshak/i, cle: 'log_connecting', niveau: 'info' },
  { motif: /tun|interface/i, cle: 'log_tunnel_ready', niveau: 'info' },
  { motif: /connected|established|✅/i, cle: 'log_connected', niveau: 'ok' },
  { motif: /disconnect|stopped|closed/i, cle: 'log_disconnected', niveau: 'info' },
];

/**
 * Traduit UNE ligne du moteur.
 *
 * Rend toujours une ligne : ce qui n'est reconnu par aucune règle devient
 * `log_activity`, un message neutre. C'est ce qui garantit qu'aucun contenu
 * brut ne peut atteindre l'écran, même pour un message ajouté plus tard au
 * moteur et inconnu d'ici.
 */
export function traduireLigne(brute: string): LigneJournal {
  const texte = String(brute ?? '');
  for (const regle of REGLES) {
    if (regle.motif.test(texte)) return { cle: regle.cle, niveau: regle.niveau };
  }
  return { cle: 'log_activity', niveau: 'info' };
}

/**
 * Traduit un journal entier en repliant les répétitions consécutives.
 *
 * Le moteur répète volontiers le même message pendant une tentative. Vingt
 * lignes identiques « Connexion en cours… » n'apprennent rien de plus qu'une
 * seule et noient ce qui les entoure.
 */
export function traduireJournal(lignes: readonly string[]): LigneJournal[] {
  const sortie: LigneJournal[] = [];
  for (const brute of lignes) {
    const ligne = traduireLigne(brute);
    const precedente = sortie[sortie.length - 1];
    if (precedente && precedente.cle === ligne.cle) continue;
    sortie.push(ligne);
  }
  return sortie;
}

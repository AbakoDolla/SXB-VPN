/**
 * journalFiltres.ts — choisir ce que le journal montre, sans rien inventer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * Le journal compte désormais une quarantaine d'étapes. Retrouver le seul
 * échec au milieu demandait de tout faire défiler — au moment précis où
 * l'utilisateur est pressé et où la connexion vient d'échouer.
 *
 * Deux questions, et deux seulement, méritent un filtre :
 *
 *   « Qu'est-ce qui a cassé ? »        → le niveau
 *   « L'application ou le moteur ? »   → la source
 *
 * La seconde n'est pas une catégorie inventée pour faire joli. Les étapes
 * venues du moteur portent une clé préfixée `moteur:`, posée par
 * `inscrireFaitMoteur` et par lui seul. Aucune étape écrite par l'application
 * ne peut donc se faire passer pour une trace du moteur, ni l'inverse.
 *
 * Le calcul vit ici, et non dans l'écran, pour la même raison que le
 * chronométrage : ce qui décide de ce que l'utilisateur voit doit pouvoir
 * être mis à l'épreuve sans lancer l'application.
 */

/** Ce qu'une étape rapporte : un état, et la clé qui dit d'où elle vient. */
export interface EtapeFiltrable {
  key: string;
  status: 'pending' | 'active' | 'done' | 'error' | 'warning';
}

export type Niveau = 'tout' | 'probleme' | 'reussite';
export type Source = 'tout' | 'application' | 'moteur';

/**
 * Le préfixe qu'`inscrireFaitMoteur` pose sur chaque trace du moteur.
 *
 * Si cette convention changeait dans VpnContext sans changer ici, le filtre
 * « Moteur » deviendrait silencieusement vide. Un contrôle vérifie que les
 * deux restent d'accord.
 */
export const PREFIXE_MOTEUR = 'moteur:';

/** L'étape vient-elle du moteur VPN, ou de l'application elle-même ? */
export function vientDuMoteur(etape: EtapeFiltrable): boolean {
  return etape.key.startsWith(PREFIXE_MOTEUR);
}

/**
 * L'étape passe-t-elle les deux filtres ?
 *
 * « Problèmes » réunit les échecs ET les avertissements : un état présumé,
 * une trame perdue ou un WebSocket refermé expliquent souvent la panne
 * autant que l'échec final. Les séparer obligerait à regarder deux fois.
 *
 * « Réussites » ne retient que `done`. Une étape encore en cours n'est pas
 * une réussite — l'annoncer comme telle serait exactement le genre de
 * demi-vérité que ce journal existe pour éviter.
 */
export function retenue(etape: EtapeFiltrable, niveau: Niveau, source: Source): boolean {
  if (niveau === 'probleme' && etape.status !== 'error' && etape.status !== 'warning') return false;
  if (niveau === 'reussite' && etape.status !== 'done') return false;

  const duMoteur = vientDuMoteur(etape);
  if (source === 'moteur' && !duMoteur) return false;
  if (source === 'application' && duMoteur) return false;

  return true;
}

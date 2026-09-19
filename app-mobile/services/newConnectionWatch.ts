/**
 * newConnectionWatch.ts — « une nouvelle connexion vous attend ».
 *
 * POURQUOI CE FICHIER EXISTE
 * ──────────────────────────
 * Quand l'exploitant déploie une nouvelle connexion VPN depuis le tableau de
 * bord, l'application ne l'apprenait qu'au prochain démarrage, ou si
 * l'utilisateur pensait de lui-même à tirer pour rafraîchir. Rien ne le lui
 * disait : il devait deviner qu'une nouveauté existait. Le propriétaire l'a
 * résumé ainsi — « The user should not have to randomly guess that they need
 * to refresh ».
 *
 * CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS
 * ──────────────────────────────────────────────
 * Il se souvient des connexions DÉJÀ VUES sur cet appareil, et rien d'autre. Il
 * ne provisionne rien, ne télécharge aucune configuration, ne décide d'aucune
 * connexion : il répond seulement « parmi ce que le serveur vient de renvoyer,
 * qu'est-ce qui n'avait jamais été montré à cet utilisateur ? ».
 *
 * POURQUOI PAS UN SIMPLE COMPTEUR
 * ───────────────────────────────
 * Comparer le NOMBRE de connexions rate le cas qui compte : une connexion
 * retirée et une autre ajoutée dans le même intervalle laissent le compte
 * inchangé, alors qu'il y a bien du neuf. On compare donc les identifiants.
 *
 * POURQUOI LA MÉMOIRE EST PERSISTÉE
 * ─────────────────────────────────
 * Gardée en mémoire vive, elle repartirait vide à chaque lancement et TOUTES
 * les connexions passeraient pour nouvelles — une alerte permanente, qu'on
 * apprend à ignorer, c'est-à-dire pire que pas d'alerte du tout.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Connexions déjà présentées à cet utilisateur, par identifiant. */
const SEEN_CONNECTIONS_KEY = '@sxb_seen_connections_v1';

/**
 * Plafond de la mémoire.
 *
 * Un parc réaliste compte quelques dizaines de connexions ; la borne évite
 * qu'un appareil très ancien traîne indéfiniment des identifiants révoqués.
 * On conserve les plus RÉCEMMENT vues : ce sont celles qu'un retour du serveur
 * peut encore citer.
 */
const MAX_SEEN = 200;

async function lireVues(): Promise<string[]> {
  try {
    const brut = await AsyncStorage.getItem(SEEN_CONNECTIONS_KEY);
    if (!brut) return [];
    const parsed = JSON.parse(brut);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // Une mémoire illisible ne doit pas casser l'écran d'accueil : on repart
    // d'une liste vide, quitte à signaler une fois de trop.
    return [];
  }
}

/**
 * Première lecture d'un appareil : on ADOPTE l'existant sans rien annoncer.
 *
 * Sans cette distinction, un utilisateur qui ouvre l'application pour la
 * première fois — ou après une réinstallation — verrait toutes ses connexions
 * habituelles présentées comme des nouveautés.
 */
export async function connexionsNouvelles(identifiants: ReadonlyArray<string>): Promise<string[]> {
  const propres = [...new Set(identifiants.filter(id => typeof id === 'string' && id.length > 0))];
  if (propres.length === 0) return [];

  const brut = await AsyncStorage.getItem(SEEN_CONNECTIONS_KEY).catch(() => null);
  if (brut === null) {
    await memoriser(propres);
    return [];
  }

  const vues = await lireVues();
  const connues = new Set(vues);
  return propres.filter(id => !connues.has(id));
}

/**
 * Range ces identifiants parmi les connexions déjà vues.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUAND APPELER — ET POURQUOI L'ORDRE COMPTE
 * ═══════════════════════════════════════════════════════════════════════════
 * À appeler AVANT le rafraîchissement que l'utilisateur vient de demander, et
 * non après. C'est ce même rafraîchissement qui relance la détection : si la
 * mémoire ne contient pas encore ces identifiants au moment où il relit, la
 * détection les redonne et l'annonce que l'utilisateur vient de traiter
 * réapparaît aussitôt.
 *
 * Le risque symétrique — mémoriser une nouveauté que le chargement n'a pas
 * réussi à récupérer — se traite avec `oublier()` sur le chemin d'échec,
 * plutôt qu'en retardant la mémorisation.
 */
export async function memoriser(identifiants: ReadonlyArray<string>): Promise<void> {
  const vues = await lireVues();
  // Les nouveaux en tête : la troncature ci-dessous sacrifie les plus anciens.
  const fusion = [...new Set([...identifiants.filter(Boolean), ...vues])].slice(0, MAX_SEEN);
  await AsyncStorage.setItem(SEEN_CONNECTIONS_KEY, JSON.stringify(fusion)).catch(() => {});
}

/**
 * Retire ces identifiants de la mémoire — ils redeviennent des nouveautés.
 *
 * Contrepartie de `memoriser()` : quand le chargement demandé par
 * l'utilisateur a échoué, la nouveauté doit rester annoncée. Sans cela elle
 * disparaîtrait sans avoir jamais été chargée, et rien ne la signalerait plus.
 */
export async function oublier(identifiants: ReadonlyArray<string>): Promise<void> {
  const aRetirer = new Set(identifiants.filter(Boolean));
  if (aRetirer.size === 0) return;
  const restants = (await lireVues()).filter(id => !aRetirer.has(id));
  await AsyncStorage.setItem(SEEN_CONNECTIONS_KEY, JSON.stringify(restants)).catch(() => {});
}

/** Repart de zéro — utilisé à la désactivation d'un appareil. */
export async function oublierConnexionsVues(): Promise<void> {
  await AsyncStorage.removeItem(SEEN_CONNECTIONS_KEY).catch(() => {});
}

export const SEEN_CONNECTIONS_STORAGE_KEY = SEEN_CONNECTIONS_KEY;

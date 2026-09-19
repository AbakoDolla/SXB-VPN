import type { VpnProfile } from '../api/vpn-profiles';

/**
 * brouillonReimport — repartir de la configuration en place, au lieu d'une page blanche.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CE MODULE CORRIGE
 * ═══════════════════════════════════════════════════════════════════════════
 * Le réimport est la SEULE voie pour modifier une configuration, et son champ
 * s'ouvrait VIDE. Pour changer un seul détail — un port, un chemin WebSocket —
 * l'exploitant devait retrouver la configuration d'origine ailleurs et la
 * recoller entièrement. S'il ne l'avait plus, la configuration devenait de
 * fait non modifiable : d'où l'impression d'un verrou que le mot de passe
 * n'ouvre pas.
 *
 * Précharger un brouillon change la nature du geste : on MODIFIE ce qui est
 * là, on ne REMPLACE plus à l'aveugle.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUE AU BROUILLON, ET POURQUOI C'EST VOULU
 * ═══════════════════════════════════════════════════════════════════════════
 * Le serveur ne renvoie JAMAIS les identifiants : le mot de passe arrive en
 * `********`, l'UUID et le payload restent chiffrés. C'est une protection
 * délibérée, et la contourner pour remplir un formulaire serait échanger la
 * confidentialité contre du confort.
 *
 * Le brouillon porte donc des marqueurs explicites à la place. L'appelant doit
 * les signaler à l'exploitant : un brouillon recollé tel quel enverrait
 * « ******** » au serveur comme s'il s'agissait du mot de passe.
 */

/** Ce qui doit être ressaisi : le serveur ne l'a jamais divulgué. */
export const MARQUEUR_SECRET = '<< à ressaisir >>';

export interface Brouillon {
  /** Texte prérempli dans le champ de réimport. */
  texte: string;
  /** Champs que l'exploitant DOIT compléter avant d'enregistrer. */
  aCompleter: string[];
}

/** Un champ absent ne doit pas écrire `undefined` dans le brouillon. */
function present(valeur: unknown): boolean {
  return valeur !== undefined && valeur !== null && String(valeur).trim() !== '';
}

/**
 * Reconstruit une URI de partage à partir d'un profil déverrouillé.
 *
 * Rend `null` quand le protocole ne s'exprime pas en URI : mieux vaut aucun
 * brouillon qu'un brouillon faux, qui ferait perdre plus de temps qu'il n'en
 * fait gagner.
 */
export function brouillonDepuisProfil(profil: VpnProfile | null | undefined): Brouillon | null {
  if (!profil || !present(profil.protocol) || !present(profil.host)) return null;

  const protocole = String(profil.protocol).toLowerCase();
  const aCompleter: string[] = [];

  // Ces protocoles portent un identifiant dans l'autorité de l'URI. Il n'est
  // jamais renvoyé par le serveur : on pose un marqueur voyant plutôt qu'une
  // valeur inventée.
  const identifiant = ['vless', 'vmess', 'trojan'].includes(protocole)
    ? (present(profil.uuid) ? String(profil.uuid) : MARQUEUR_SECRET)
    : (present(profil.username) ? String(profil.username) : MARQUEUR_SECRET);
  if (identifiant === MARQUEUR_SECRET) {
    aCompleter.push(['vless', 'vmess', 'trojan'].includes(protocole) ? 'uuid' : 'username');
  }

  const parametres = new URLSearchParams();
  if (present(profil.network)) parametres.set('type', String(profil.network));
  if (profil.tls) parametres.set('security', 'tls');
  if (present(profil.sni)) parametres.set('sni', String(profil.sni));
  if (present(profil.path)) parametres.set('path', String(profil.path));

  const port = present(profil.port) ? `:${profil.port}` : '';
  const requete = parametres.toString();
  const etiquette = present(profil.name) ? `#${encodeURIComponent(String(profil.name))}` : '';

  return {
    texte: `${protocole}://${identifiant}@${profil.host}${port}${requete ? `?${requete}` : ''}${etiquette}`,
    aCompleter,
  };
}

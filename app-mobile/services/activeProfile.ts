/**
 * activeProfile.ts — Quelle configuration l'application doit-elle utiliser ?
 *
 * DÉFAUT CORRIGÉ — passage d'un essai gratuit à un compte normal.
 *
 * Le déploiement d'un essai réutilise le compte déjà lié au téléphone
 * (`vpnClient.findFirst({ deviceId })` côté serveur) et le renouvellement d'un
 * code `SXB-USER-…` conserve la même identité. `acceptActivatedIdentity` ne
 * purge donc RIEN dans ce cas — et c'est voulu : effacer les profils d'un
 * compte qui n'a pas changé détruirait un accès encore valide.
 *
 * Mais le registre local gardait son profil actif tel quel : la configuration
 * d'essai, marquée active lors du premier provisionnement, le restait après son
 * échéance, et le forfait ordinaire arrivé ensuite était enregistré INACTIF
 * (`entries.length === 0` étant faux). L'application continuait donc de
 * présenter et de proposer l'essai terminé alors qu'un accès valide existait.
 *
 * RÈGLE RETENUE, et elle est étroite : « la configuration du compte ACTIF »,
 * jamais « table rase à chaque activation ». Une configuration encore valide
 * n'est jamais supprimée ni déclassée ; seule une configuration qui NE PEUT
 * PLUS SERVIR cède la place, et seulement s'il existe une remplaçante utilisable.
 *
 * Les états de restriction (suspendu, révoqué, supprimé) restent l'affaire de
 * `accessState`/`accessPolicy` : ce module ne connaît que l'échéance et
 * l'épuisement, ce que le registre local sait déjà, hors ligne compris.
 */
import type { ConfigMeta } from './configStore';

/** Profil épuisé ou arrivé à échéance : il ne peut plus ouvrir de tunnel. */
export function profilEpuiseOuExpire(meta: Pick<ConfigMeta, 'accessStatus' | 'expiryDate'>, maintenant = new Date()): boolean {
  if (meta.accessStatus === 'expired' || meta.accessStatus === 'exhausted') return true;
  if (!meta.expiryDate) return false;
  const fin = Date.parse(String(meta.expiryDate));
  return Number.isFinite(fin) && fin <= maintenant.getTime();
}

/** Négation lisible de la précédente — utilisée partout où l'on choisit. */
export function profilUtilisable(meta: Pick<ConfigMeta, 'accessStatus' | 'expiryDate'>, maintenant = new Date()): boolean {
  return !profilEpuiseOuExpire(meta, maintenant);
}

/**
 * Une configuration qu'on vient d'enregistrer doit-elle devenir l'active ?
 *
 * OUI seulement si aucune configuration utilisable n'est déjà active. Le choix
 * explicite de l'utilisateur n'est donc jamais écrasé par une synchronisation
 * en arrière-plan : tant que son profil courant fonctionne, il le garde.
 */
export function reprendLeProfilActif(
  autres: ReadonlyArray<ConfigMeta>,
  candidat: Pick<ConfigMeta, 'accessStatus' | 'expiryDate'>,
  maintenant = new Date(),
): boolean {
  if (autres.some((entree) => entree.isActive && profilUtilisable(entree, maintenant))) return false;
  // Premier profil du téléphone : il devient actif même s'il est déjà périmé,
  // sinon l'écran d'accueil n'aurait plus rien à expliquer à l'utilisateur.
  return autres.length === 0 || profilUtilisable(candidat, maintenant);
}

/**
 * Configuration à présenter maintenant, parmi celles stockées.
 *
 * L'ordre de préférence conserve EXACTEMENT l'ancienne chaîne de repli en
 * queue : demandée, puis active non restreinte, puis non restreinte, puis la
 * première. Trois préférences la précèdent désormais, toutes limitées aux
 * profils qui peuvent encore servir. Conséquence : le comportement ne change
 * que lorsqu'une remplaçante utilisable existe — exactement le cas de l'essai
 * terminé doublé d'un forfait ordinaire.
 */
export function choisirProfilActif(
  entrees: ReadonlyArray<ConfigMeta>,
  options: {
    /** Identifiant explicitement demandé (choix utilisateur ou dernier actif). */
    demande?: string | null;
    /** Restriction d'accès connue — suspendu, révoqué, supprimé. */
    restreint?: (entree: ConfigMeta) => boolean;
    maintenant?: Date;
  } = {},
): ConfigMeta | undefined {
  const restreint = options.restreint ?? (() => false);
  const maintenant = options.maintenant ?? new Date();
  const utilisable = (entree: ConfigMeta) => !restreint(entree) && profilUtilisable(entree, maintenant);
  const demandee = options.demande ? entrees.find((entree) => entree.configId === options.demande) : undefined;

  if (demandee && utilisable(demandee)) return demandee;
  const activeUtilisable = entrees.find((entree) => entree.isActive && utilisable(entree));
  if (activeUtilisable) return activeUtilisable;
  const premiereUtilisable = entrees.find(utilisable);
  if (premiereUtilisable) return premiereUtilisable;

  // Plus rien d'utilisable : on retombe sur la chaîne d'origine, afin que
  // l'interface montre le profil bloqué et en explique la raison plutôt que
  // d'afficher le vide.
  return demandee
    ?? entrees.find((entree) => entree.isActive && !restreint(entree))
    ?? entrees.find((entree) => !restreint(entree))
    ?? entrees[0];
}

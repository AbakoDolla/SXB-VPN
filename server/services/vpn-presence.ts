/**
 * Présence VPN — « qui utilise RÉELLEMENT le VPN en ce moment ».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE MODULE EXISTE
 *
 * Le tableau de bord présentait `vpnClient.count({ status: "active" })` sous
 * l'étiquette « CONNECTÉS ». C'est le nombre de COMPTES ouverts, pas le nombre
 * de personnes dont le tunnel est monté. Un parc de 82 comptes actifs dont
 * personne ne se sert affichait « 82 connectés ».
 *
 * La seule mesure de présence dont dispose la plateforme est le signal de
 * santé mobile (`mobile_health_devices`) : l'appareil déclare son
 * `tunnelState`. La plateforme n'observe NI le trafic, NI la destination, NI
 * le contenu de ce que fait l'utilisateur — elle sait seulement que le tunnel
 * était monté au moment du dernier signal reçu.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DÉFINITION RETENUE POUR « CONNECTÉ MAINTENANT »
 *
 *   tunnelState === "connected"  ET  lastSeenAt >= maintenant − FENÊTRE
 *
 * avec FENÊTRE = 15 minutes = 3 × la cadence de battement mobile (5 minutes).
 *
 * Justification du facteur 3 : l'application émet un battement toutes les
 * 5 minutes tant que le tunnel est monté. Un facteur 1 déclarerait déconnecté
 * tout appareil dont un seul battement a glissé (Doze Android, bascule
 * Wi-Fi/données, seconde de retard d'ordonnancement) — c'est le faux négatif
 * le plus fréquent. Un facteur 3 tolère DEUX battements consécutifs perdus
 * avant que la plateforme cesse d'affirmer la présence ; au-delà, le silence
 * est trop long pour continuer à prétendre observer quoi que ce soit.
 *
 * CE QUE LA FENÊTRE NE DIT PAS : l'absence de signal ne prouve PAS une
 * déconnexion. Réseau coupé, batterie vide, application tuée par le système :
 * le tunnel peut être tombé comme il peut tourner encore. C'est pourquoi ce
 * module ne renvoie jamais d'état « déconnecté » ; il renvoie une date de
 * DERNIÈRE ACTIVITÉ, et l'interface dit « dernière activité il y a X ».
 *
 * MOBILE_HEALTH_ACTIVE_WINDOW_HOURS (48 h) reste la fenêtre d'ACTIVITÉ
 * GÉNÉRALE de la vue « Santé mobile » : combien d'appareils ont donné signe
 * de vie dans les deux derniers jours. Elle n'est pas touchée ici — une
 * présence instantanée et une activité bi-quotidienne sont deux questions
 * différentes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RAPPROCHEMENT AVEC LES CLIENTS — SANS DÉNOMINALISER LA TABLE DE SANTÉ
 *
 * `mobile_health_devices` ne contient aucune donnée nominative : la clé est un
 * pseudonyme HMAC-SHA256 de (userId, deviceId). Ce module ne lui ajoute rien.
 * Le rapprochement se fait dans l'AUTRE SENS : le serveur connaît déjà les
 * couples (userId, deviceId) de ses clients activés, il RECALCULE leur
 * pseudonyme et cherche la correspondance. La fonction de hachage reste à sens
 * unique ; la table de santé reste anonyme même lue seule.
 */
import { pseudonymizeMobileDevice } from "./mobile-pseudonym";

/** Cadence du battement émis par l'application tant que le tunnel est monté. */
export const PRESENCE_HEARTBEAT_MINUTES = 5;

/** Fenêtre de présence = 3 battements. Voir la justification en tête de module. */
export const PRESENCE_WINDOW_MINUTES = 3 * PRESENCE_HEARTBEAT_MINUTES;

/** Borne dure du nombre d'appareils présents rapprochés en une requête. */
export const PRESENCE_MAX_DEVICES = 500;

/** Borne dure du nombre de couples (userId, deviceId) indexés par cycle. */
export const PRESENCE_MAX_IDENTITIES = 5_000;

/** Profondeur de recherche du début de la session en cours. */
export const PRESENCE_RUN_LOOKBACK_HOURS = 12;

/** Borne dure des lignes d'historique lues pour dater les sessions en cours. */
export const PRESENCE_RUN_MAX_ROWS = 2_000;

/** Durée de validité de l'index pseudonyme → client tenu en mémoire. */
export const PRESENCE_INDEX_TTL_MS = 60_000;

/** Pagination : valeur par défaut et plafond de `limit`. */
export const PRESENCE_PAGE_SIZE = 50;
export const PRESENCE_MAX_PAGE_SIZE = 200;

/** Signal de présence brut, tel que stocké dans `mobile_health_devices`. */
export interface SignalPresence {
  pseudonym: string;
  tunnelState: string;
  lastSeenAt: Date;
  protocol: string | null;
  appVersion: string;
  deviceModel: string | null;
}

/** Couple connu du serveur, seul point d'entrée du rapprochement. */
export interface IdentiteAppareil {
  clientId: string;
  clientName: string | null;
  userId: string;
  deviceId: string;
  resellerId: string | null;
  resellerName: string | null;
  /** Rôle du compte porteur — sert au seul filtrage furtif des comptes OWNER. */
  ownerAccount?: boolean;
}

/** Ligne de présence exposée à l'interface. */
export interface LignePresence {
  clientId: string;
  clientName: string | null;
  deviceId: string;
  resellerId: string | null;
  resellerName: string | null;
  directClient: boolean;
  protocol: string | null;
  appVersion: string;
  deviceModel: string | null;
  lastSeenAt: string;
  lastSeenSecondsAgo: number;
  connectedSinceAt: string | null;
  connectedSinceMeasured: boolean;
}

/** Regroupement par revendeur, avec le détail dépliable de ses connectés. */
export interface GroupePresenceRevendeur {
  resellerId: string | null;
  resellerName: string | null;
  status: string | null;
  directClients: boolean;
  connectedNow: number;
  totalClients: number;
  activeClients: number;
  users: LignePresence[];
}

/**
 * Un appareil est-il connecté MAINTENANT ?
 *
 * Les deux conditions sont indissociables : un appareil dont le dernier état
 * connu était « connected » mais qui s'est tu depuis une heure n'est PAS
 * connecté — c'est précisément le cas que l'ancienne carte ne savait pas
 * distinguer. Les états « connecting » et « error » ne sont pas des tunnels
 * montés : une tentative en cours ou en échec ne fait transiter aucun trafic.
 */
export function estConnecteMaintenant(
  signal: Pick<SignalPresence, "tunnelState" | "lastSeenAt">,
  now: Date,
  fenetreMinutes: number = PRESENCE_WINDOW_MINUTES,
): boolean {
  if (signal.tunnelState !== "connected") return false;
  const vu = signal.lastSeenAt instanceof Date ? signal.lastSeenAt.getTime() : new Date(signal.lastSeenAt).getTime();
  if (!Number.isFinite(vu)) return false;
  // Un horodatage dans le futur trahit une horloge d'appareil décalée : on ne
  // l'exclut pas, mais il ne prolonge pas la fenêtre au-delà du présent.
  return vu >= now.getTime() - fenetreMinutes * 60_000;
}

/** Filtre les seuls signaux qui satisfont la définition ci-dessus. */
export function filtrerPresences(
  signaux: SignalPresence[],
  now: Date,
  fenetreMinutes: number = PRESENCE_WINDOW_MINUTES,
): SignalPresence[] {
  return signaux.filter((signal) => estConnecteMaintenant(signal, now, fenetreMinutes));
}

/**
 * Index pseudonyme → identité, reconstruit à partir des couples connus.
 * C'est la seule direction possible : le HMAC n'est pas réversible.
 */
export function indexerPseudonymes(
  identites: IdentiteAppareil[],
  secret: string,
): Map<string, IdentiteAppareil> {
  const index = new Map<string, IdentiteAppareil>();
  for (const identite of identites) {
    if (!identite.userId || !identite.deviceId) continue;
    index.set(pseudonymizeMobileDevice(identite.userId, identite.deviceId, secret), identite);
  }
  return index;
}

/**
 * Début de la session en cours, lu dans l'historique des rapports.
 *
 * Les battements n'écrivent AUCUNE ligne d'historique (voir
 * `storeMobileHealthReport`) : seules les transitions de cycle de vie en
 * produisent. Le début de la session courante est donc la plus ancienne ligne
 * « connected » de la suite ininterrompue qui termine l'historique.
 *
 * `lignesRecentesDAbord` doit être triée du plus récent au plus ancien. Si la
 * suite consomme tout l'historique fourni sans rencontrer d'état non connecté,
 * la date de début est INCONNUE : on renvoie `null` plutôt qu'une valeur
 * plausible, et l'interface affiche « non mesuré ».
 */
export function calculerDebutSession(
  lignesRecentesDAbord: { tunnelState: string; reportedAt: Date }[],
): { debut: Date | null; mesure: boolean } {
  let debut: Date | null = null;
  for (const ligne of lignesRecentesDAbord) {
    if (ligne.tunnelState !== "connected") {
      // Borne inférieure atteinte : la ligne « connected » retenue ouvre bien
      // la session en cours.
      return { debut, mesure: debut !== null };
    }
    debut = ligne.reportedAt;
  }
  return { debut: null, mesure: false };
}

/**
 * Rapproche les signaux présents des identités connues.
 *
 * `orphelins` compte les appareils présents qu'aucune identité connue
 * n'explique : compte supprimé, appareil réattribué, ou — pour un revendeur —
 * client d'un autre revendeur. Il n'est JAMAIS additionné au total listé : le
 * nombre affiché doit toujours égaler le nombre de lignes réellement montrées.
 */
export function rapprocherPresences(
  signaux: SignalPresence[],
  index: Map<string, IdentiteAppareil>,
  now: Date,
  debuts: Map<string, { debut: Date | null; mesure: boolean }> = new Map(),
): { lignes: LignePresence[]; orphelins: number } {
  const lignes: LignePresence[] = [];
  let orphelins = 0;

  for (const signal of signaux) {
    const identite = index.get(signal.pseudonym);
    if (!identite) {
      orphelins += 1;
      continue;
    }
    const session = debuts.get(signal.pseudonym) ?? { debut: null, mesure: false };
    lignes.push({
      clientId: identite.clientId,
      clientName: identite.clientName,
      deviceId: identite.deviceId,
      resellerId: identite.resellerId,
      resellerName: identite.resellerName,
      directClient: identite.resellerId === null,
      protocol: signal.protocol,
      appVersion: signal.appVersion,
      deviceModel: signal.deviceModel,
      lastSeenAt: signal.lastSeenAt.toISOString(),
      lastSeenSecondsAgo: Math.max(0, Math.round((now.getTime() - signal.lastSeenAt.getTime()) / 1000)),
      connectedSinceAt: session.debut ? session.debut.toISOString() : null,
      connectedSinceMeasured: session.mesure,
    });
  }

  // Le plus récemment vu d'abord : c'est l'ordre attendu d'un suivi temps réel.
  lignes.sort((a, b) => a.lastSeenSecondsAgo - b.lastSeenSecondsAgo);
  return { lignes, orphelins };
}

/**
 * Regroupe les connectés par revendeur propriétaire.
 *
 * `connectedNow` d'un groupe est TOUJOURS `users.length` : un seul calcul, donc
 * aucune divergence possible entre le compteur et la liste dépliée.
 */
export function regrouperParRevendeur(
  lignes: LignePresence[],
  revendeurs: { id: string; name: string | null; status: string | null; totalClients: number; activeClients: number }[],
): { groupes: GroupePresenceRevendeur[]; direct: GroupePresenceRevendeur } {
  const parRevendeur = new Map<string, LignePresence[]>();
  const directes: LignePresence[] = [];

  for (const ligne of lignes) {
    if (!ligne.resellerId) {
      directes.push(ligne);
      continue;
    }
    const liste = parRevendeur.get(ligne.resellerId) ?? [];
    liste.push(ligne);
    parRevendeur.set(ligne.resellerId, liste);
  }

  const groupes = revendeurs.map((revendeur) => {
    const users = parRevendeur.get(revendeur.id) ?? [];
    return {
      resellerId: revendeur.id,
      resellerName: revendeur.name,
      status: revendeur.status,
      directClients: false,
      connectedNow: users.length,
      totalClients: revendeur.totalClients,
      activeClients: revendeur.activeClients,
      users,
    };
  });

  // Le revendeur le plus actif en tête ; à égalité, le plus gros parc.
  groupes.sort((a, b) => b.connectedNow - a.connectedNow || b.totalClients - a.totalClients);

  return {
    groupes,
    direct: {
      resellerId: null,
      resellerName: null,
      status: null,
      directClients: true,
      connectedNow: directes.length,
      totalClients: 0,
      activeClients: 0,
      users: directes,
    },
  };
}

/** Normalise `limit`/`offset` d'une requête HTTP sans jamais faire confiance au client. */
export function normaliserPagination(limitBrut: unknown, offsetBrut: unknown): { limit: number; offset: number } {
  const limit = Number.parseInt(String(limitBrut ?? ""), 10);
  const offset = Number.parseInt(String(offsetBrut ?? ""), 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, PRESENCE_MAX_PAGE_SIZE) : PRESENCE_PAGE_SIZE,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Couche base de données
//
// Les fonctions ci-dessus sont pures et testables sans Prisma ; celles qui
// suivent se contentent de les alimenter avec des requêtes BORNÉES.
// ─────────────────────────────────────────────────────────────────────────────

type IndexCache = { expireAt: number; identites: IdentiteAppareil[] };
let cacheIdentites: IndexCache | null = null;

/** Vide le cache d'identités — utilisé par les tests et après une purge. */
export function viderCachePresence(): void {
  cacheIdentites = null;
}

/**
 * Couples (userId, deviceId) des appareils ACTIVÉS, avec leur propriétaire.
 *
 * Requête bornée et indexée : `deviceId` est unique (donc indexé) et seul le
 * parc activé est lu. Le résultat est mémorisé une minute afin qu'un
 * rafraîchissement de tableau de bord toutes les 30 secondes ne relise pas le
 * parc à chaque appel. Conséquence assumée : un appareil tout juste activé
 * peut apparaître avec au plus une minute de retard.
 */
async function lireIdentites(db: any, now: Date): Promise<IdentiteAppareil[]> {
  if (cacheIdentites && cacheIdentites.expireAt > now.getTime()) return cacheIdentites.identites;

  const clients = await db.vpnClient.findMany({
    where: { deviceId: { not: null }, status: "active" },
    take: PRESENCE_MAX_IDENTITIES,
    select: {
      id: true,
      userId: true,
      deviceId: true,
      resellerId: true,
      user: { select: { name: true, email: true, role: { select: { name: true } } } },
      reseller: { select: { id: true, user: { select: { name: true, email: true } } } },
    },
  });

  const identites: IdentiteAppareil[] = clients.map((client: any) => ({
    clientId: client.id,
    clientName: client.user?.name || client.user?.email || null,
    userId: client.userId,
    deviceId: client.deviceId,
    resellerId: client.resellerId ?? null,
    resellerName: client.reseller?.user?.name || client.reseller?.user?.email || null,
    ownerAccount: client.user?.role?.name === "OWNER",
  }));

  cacheIdentites = { expireAt: now.getTime() + PRESENCE_INDEX_TTL_MS, identites };
  return identites;
}

/** Signaux de présence bruts : uniquement les tunnels déclarés montés et récents. */
async function lireSignauxPresents(db: any, now: Date): Promise<SignalPresence[]> {
  const rows = await db.mobileHealthDevice.findMany({
    where: {
      tunnelState: "connected",
      lastSeenAt: { gte: new Date(now.getTime() - PRESENCE_WINDOW_MINUTES * 60_000) },
    },
    orderBy: { lastSeenAt: "desc" },
    take: PRESENCE_MAX_DEVICES,
    select: {
      id: true,
      pseudonym: true,
      tunnelState: true,
      lastSeenAt: true,
      protocol: true,
      appVersion: true,
      deviceModel: true,
    },
  });
  return rows as SignalPresence[];
}

/** Datation des sessions en cours, en une seule requête bornée. */
async function lireDebutsSession(
  db: any,
  appareils: { id: string; pseudonym: string }[],
  now: Date,
): Promise<Map<string, { debut: Date | null; mesure: boolean }>> {
  const debuts = new Map<string, { debut: Date | null; mesure: boolean }>();
  if (appareils.length === 0) return debuts;

  const lignes = await db.mobileHealthReport.findMany({
    where: {
      deviceId: { in: appareils.map((appareil) => appareil.id) },
      reportedAt: { gte: new Date(now.getTime() - PRESENCE_RUN_LOOKBACK_HOURS * 3_600_000) },
    },
    orderBy: { reportedAt: "desc" },
    take: PRESENCE_RUN_MAX_ROWS,
    select: { deviceId: true, tunnelState: true, reportedAt: true },
  });

  const parAppareil = new Map<string, { tunnelState: string; reportedAt: Date }[]>();
  for (const ligne of lignes as any[]) {
    const liste = parAppareil.get(ligne.deviceId) ?? [];
    liste.push({ tunnelState: ligne.tunnelState, reportedAt: ligne.reportedAt });
    parAppareil.set(ligne.deviceId, liste);
  }
  for (const appareil of appareils) {
    debuts.set(appareil.pseudonym, calculerDebutSession(parAppareil.get(appareil.id) ?? []));
  }
  return debuts;
}

export interface OptionsPresence {
  /** Filtre Prisma restreignant le parc visible (cloisonnement revendeur). */
  porteeClients?: Record<string, unknown> | null;
  /** Masque les comptes OWNER pour les rôles qui ne doivent pas les voir. */
  masquerProprietaire?: boolean;
  /**
   * Ne date pas les sessions en cours. La carte du tableau de bord n'affiche
   * qu'un nombre : lui faire lire l'historique des rapports toutes les
   * 30 secondes serait une requête payée pour rien.
   */
  sansDatation?: boolean;
  now?: Date;
}

/**
 * Liste complète des connectés visibles par le demandeur, AVANT pagination.
 * Le total est celui de cette liste : aucun second comptage divergent.
 */
export async function listerConnectes(
  db: any,
  secret: string,
  options: OptionsPresence = {},
): Promise<{
  generatedAt: string;
  presenceWindowMinutes: number;
  heartbeatMinutes: number;
  lignes: LignePresence[];
  orphelins: number;
  devicesTruncated: boolean;
}> {
  const now = options.now ?? new Date();
  const signaux = await lireSignauxPresents(db, now);
  const identites = await lireIdentites(db, now);
  const visibles = filtrerIdentites(identites, options);
  const index = indexerPseudonymes(visibles, secret);

  // Le filtre de présence est réappliqué en mémoire : la requête le pose déjà,
  // mais la règle « connecté maintenant » doit tenir même si la source change.
  const presents = filtrerPresences(signaux, now);

  // Les débuts de session ne sont datés que pour les appareils effectivement
  // rapprochés : inutile d'interroger l'historique d'un orphelin.
  const rapprochables = presents
    .filter((signal) => index.has(signal.pseudonym))
    .map((signal) => ({ id: (signal as any).id as string, pseudonym: signal.pseudonym }));
  const debuts = options.sansDatation
    ? new Map<string, { debut: Date | null; mesure: boolean }>()
    : await lireDebutsSession(db, rapprochables, now);

  const { lignes, orphelins } = rapprocherPresences(presents, index, now, debuts);
  return {
    generatedAt: now.toISOString(),
    presenceWindowMinutes: PRESENCE_WINDOW_MINUTES,
    heartbeatMinutes: PRESENCE_HEARTBEAT_MINUTES,
    lignes,
    orphelins,
    devicesTruncated: signaux.length >= PRESENCE_MAX_DEVICES,
  };
}

/**
 * Applique le cloisonnement en mémoire sur l'index mutualisé.
 *
 * L'index des couples est construit une fois pour toute la plateforme (c'est
 * lui qui coûte le hachage) ; la restriction par revendeur est ensuite un
 * simple filtre, appliqué AVANT tout rapprochement — un revendeur ne peut donc
 * jamais recevoir une ligne qui ne lui appartient pas.
 */
function filtrerIdentites(identites: IdentiteAppareil[], options: OptionsPresence): IdentiteAppareil[] {
  // Furtivité : hors OWNER, les appareils portés par un compte OWNER n'existent
  // pas — même règle qu'à la lecture des KPIs, appliquée au même endroit.
  const visibles = options.masquerProprietaire
    ? identites.filter((identite) => identite.ownerAccount !== true)
    : identites;
  const portee = options.porteeClients;
  if (!portee) return visibles;
  const conditions = Array.isArray((portee as any).OR) ? (portee as any).OR : [portee];
  return visibles.filter((identite) =>
    conditions.some((condition: any) => {
      if (condition?.id === "__aucun__") return false;
      if (condition?.resellerId !== undefined && condition.resellerId !== null) {
        return identite.resellerId === condition.resellerId;
      }
      if (condition?.resellerId === null) {
        return identite.resellerId === null && identite.userId === condition.userId;
      }
      return false;
    }),
  );
}

/**
 * Compteur « connectés maintenant » pour la carte du tableau de bord.
 * Il dérive de la MÊME liste que la vue de suivi : les deux ne peuvent pas
 * diverger.
 */
export async function compterConnectes(
  db: any,
  secret: string,
  options: OptionsPresence = {},
): Promise<number> {
  const { lignes } = await listerConnectes(db, secret, { ...options, sansDatation: true });
  return lignes.length;
}

/**
 * Revendeurs enregistrés et leurs connectés — vue d'administration.
 *
 * Le détail dépliable de chaque revendeur est servi dans la MÊME réponse et
 * provient de la MÊME liste que le compteur : impossible qu'un revendeur
 * annonce « 4 connectés » et n'en déplie que 3.
 */
export async function listerRevendeursConnectes(
  db: any,
  secret: string,
  options: OptionsPresence = {},
): Promise<{
  generatedAt: string;
  presenceWindowMinutes: number;
  heartbeatMinutes: number;
  totalConnected: number;
  resellers: GroupePresenceRevendeur[];
  direct: GroupePresenceRevendeur;
  unmatched: number;
  devicesTruncated: boolean;
}> {
  const presence = await listerConnectes(db, secret, options);
  const stealth = options.masquerProprietaire ? { user: { role: { name: { not: "OWNER" } } } } : {};
  const [fiches, compteurs] = await Promise.all([
    db.reseller.findMany({
      ...(Object.keys(stealth).length ? { where: stealth } : {}),
      select: { id: true, status: true, user: { select: { name: true, email: true } } },
    }),
    // Agrégat plutôt que chargement des parcs : le nombre de clients d'un
    // revendeur se compte en base, il ne se rapatrie pas ligne à ligne.
    db.vpnClient.groupBy({
      by: ["resellerId", "status"],
      where: { resellerId: { not: null }, ...stealth },
      _count: { _all: true },
    }),
  ]);

  const parcs = new Map<string, { total: number; actifs: number }>();
  for (const ligne of compteurs as any[]) {
    if (!ligne.resellerId) continue;
    const parc = parcs.get(ligne.resellerId) ?? { total: 0, actifs: 0 };
    parc.total += ligne._count._all;
    if (ligne.status === "active") parc.actifs += ligne._count._all;
    parcs.set(ligne.resellerId, parc);
  }

  const { groupes, direct } = regrouperParRevendeur(
    presence.lignes,
    fiches.map((fiche: any) => ({
      id: fiche.id,
      name: fiche.user?.name || fiche.user?.email || null,
      status: fiche.status ?? null,
      totalClients: parcs.get(fiche.id)?.total ?? 0,
      activeClients: parcs.get(fiche.id)?.actifs ?? 0,
    })),
  );

  return {
    generatedAt: presence.generatedAt,
    presenceWindowMinutes: presence.presenceWindowMinutes,
    heartbeatMinutes: presence.heartbeatMinutes,
    // Somme des lignes réellement listées, jamais un comptage indépendant.
    totalConnected: presence.lignes.length,
    resellers: groupes,
    direct,
    unmatched: presence.orphelins,
    devicesTruncated: presence.devicesTruncated,
  };
}

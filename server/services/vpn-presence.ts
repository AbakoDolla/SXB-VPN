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
 * La PREMIÈRE mesure de présence est le signal de
 * santé mobile (`mobile_health_devices`) : l'appareil déclare son
 * `tunnelState`. La plateforme n'observe NI le trafic, NI la destination, NI
 * le contenu de ce que fait l'utilisateur — elle sait seulement que le tunnel
 * était monté au moment du dernier signal reçu.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECONDE SOURCE : LA CONSOMMATION REMONTÉE
 *
 * Ce seul signal ne suffit pas. En production, le tableau de bord a affiché
 * « 0 connecté » pendant CINQ JOURS alors que le trafic montait chaque jour :
 * plus aucun battement de santé n'arrivait. C'est un signal fragile — il
 * dépend du consentement aux diagnostics et de la version installée, et rien
 * ne le remplaçait quand il se taisait.
 *
 * La remontée de consommation, elle, porte la FACTURATION : toute application
 * qui transporte du trafic l'émet, quelle que soit sa version et sans
 * consentement optionnel. Un appareil qui a remis des octets mesurés dans la
 * fenêtre est donc listé lui aussi, avec `source: 'usage'`.
 *
 * Ce que cette source prouve : l'application a joint l'API et remis des octets
 * qu'elle a mesurés. Ce qu'elle ne prouve PAS : que le tunnel soit monté à la
 * seconde près — un retard accumulé hors ligne est rejoué au retour du réseau.
 * Les deux sources ne sont jamais confondues : chaque ligne porte celle qui
 * l'explique, et l'interface la montre.
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
import { FURTIVITE_OWNER, FURTIVITE_OWNER_PORTEUR } from "../middleware/rbac/owner";

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

/**
 * Cadence à laquelle l'application remonte sa consommation pendant un tunnel.
 *
 * C'est le SECOND signal de présence, et le plus fiable en production : il ne
 * dépend ni du consentement aux diagnostics, ni de la version installée — il
 * porte la facturation, donc toute application qui transporte du trafic
 * l'émet. La plateforme a mesuré 0 connecté pendant cinq jours alors que le
 * trafic montait chaque jour : le battement de santé, lui, n'arrivait plus.
 */
export const PRESENCE_USAGE_INTERVAL_MINUTES = 5;

/** Borne dure des rapports de consommation lus pour la présence. */
export const PRESENCE_USAGE_MAX_ROWS = 5_000;

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
  /** Administrateur gestionnaire — sert au cloisonnement par compartiment. */
  managedById?: string | null;
  /** Le gestionnaire est-il le OWNER ? Sert à la furtivité de son parc. */
  managedByOwner?: boolean;
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
  /**
   * Ce qui prouve la présence de cet appareil.
   *
   * `heartbeat` : l'application a déclaré son tunnel monté.
   * `usage` : elle a remonté de la consommation mesurée, sans avoir déclaré
   * son état — c'est le cas d'une version ancienne ou d'un appareil dont les
   * diagnostics sont refusés. L'interface ne doit pas présenter les deux comme
   * la même chose : le second prouve du trafic remonté, pas un état annoncé.
   */
  source: 'heartbeat' | 'usage';
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
      source: 'heartbeat',
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
      managedById: true,
      managedBy: { select: { role: { select: { name: true } } } },
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
    managedById: client.managedById ?? null,
    managedByOwner: client.managedBy?.role?.name === "OWNER",
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
  /**
   * Filtre Prisma restreignant les FICHES revendeur listées.
   *
   * Porté à part car une fiche revendeur n'a pas de gestionnaire : elle porte
   * son auteur. Sans lui, un administrateur voyait nommément les revendeurs
   * des autres comptes alors que son parc n'en contenait qu'un.
   */
  porteeFichesRevendeur?: Record<string, unknown> | null;
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
 * Appareils ayant REMONTÉ DE LA CONSOMMATION dans la fenêtre.
 *
 * Ce que cela prouve : l'application a joint l'API et lui a remis des octets
 * mesurés. Ce que cela ne prouve pas : que le tunnel soit monté à la seconde
 * près — un retard accumulé hors ligne est rejoué au retour du réseau. C'est
 * précisément pourquoi la ligne produite porte `source: 'usage'` et non l'état
 * annoncé d'un tunnel.
 *
 * Sans cette source, la plateforme affichait 0 connecté pendant des jours :
 * le battement de santé dépend du consentement aux diagnostics et de la
 * version installée, alors que la remontée de consommation porte la
 * facturation et existe donc sur tout appareil qui transporte du trafic.
 */
async function lireSignauxTrafic(db: any, now: Date): Promise<Map<string, Date>> {
  if (!db?.trafficUsage?.findMany) return new Map();
  const depuis = new Date(now.getTime() - PRESENCE_WINDOW_MINUTES * 60_000);
  const lignes = await db.trafficUsage.findMany({
    where: { timestamp: { gte: depuis }, deviceId: { not: null } },
    orderBy: { timestamp: "desc" },
    take: PRESENCE_USAGE_MAX_ROWS,
    select: { deviceId: true, timestamp: true },
  });
  const parAppareil = new Map<string, Date>();
  for (const ligne of lignes as any[]) {
    const deviceId = typeof ligne.deviceId === "string" ? ligne.deviceId : null;
    if (!deviceId) continue;
    const vu = ligne.timestamp instanceof Date ? ligne.timestamp : new Date(ligne.timestamp);
    if (!Number.isFinite(vu.getTime()) || vu < depuis) continue;
    // La requête trie déjà du plus récent au plus ancien ; on garde malgré tout
    // le maximum, pour que l'ordre de la source ne puisse pas changer le résultat.
    const connu = parAppareil.get(deviceId);
    if (!connu || vu > connu) parAppareil.set(deviceId, vu);
  }
  return parAppareil;
}

/**
 * Ajoute les appareils vus par leur consommation, sans jamais doublonner ceux
 * qu'un battement explique déjà — un même appareil ne doit compter qu'une fois.
 */
function completerParTrafic(
  lignes: LignePresence[],
  identites: IdentiteAppareil[],
  trafic: Map<string, Date>,
  now: Date,
): LignePresence[] {
  if (trafic.size === 0) return lignes;
  const dejaPresents = new Set(lignes.map((ligne) => ligne.deviceId));
  const complement: LignePresence[] = [];
  for (const identite of identites) {
    if (!identite.deviceId || dejaPresents.has(identite.deviceId)) continue;
    const vu = trafic.get(identite.deviceId);
    if (!vu) continue;
    complement.push({
      clientId: identite.clientId,
      clientName: identite.clientName,
      deviceId: identite.deviceId,
      resellerId: identite.resellerId,
      resellerName: identite.resellerName,
      directClient: identite.resellerId === null,
      // Ces champs viennent du signal de santé : sans battement, ils sont
      // inconnus. Les inventer ferait passer une supposition pour une mesure.
      protocol: null,
      appVersion: "",
      deviceModel: null,
      lastSeenAt: vu.toISOString(),
      lastSeenSecondsAgo: Math.max(0, Math.round((now.getTime() - vu.getTime()) / 1000)),
      connectedSinceAt: null,
      connectedSinceMeasured: false,
      source: 'usage',
    });
  }
  return [...lignes, ...complement].sort((a, b) => a.lastSeenSecondsAgo - b.lastSeenSecondsAgo);
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
  // Second signal : la consommation remontée. Le cloisonnement est appliqué
  // sur `visibles`, donc AVANT le rapprochement, exactement comme pour les
  // battements — un revendeur ne peut pas recevoir l'appareil d'un autre.
  const trafic = await lireSignauxTrafic(db, now);
  const completes = completerParTrafic(lignes, visibles, trafic, now);
  return {
    generatedAt: now.toISOString(),
    presenceWindowMinutes: PRESENCE_WINDOW_MINUTES,
    heartbeatMinutes: PRESENCE_HEARTBEAT_MINUTES,
    lignes: completes,
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
  // Furtivité : hors OWNER, les appareils rattachés au OWNER n'existent pas —
  // qu'il les porte sous son compte ou qu'il les gère. Même règle qu'à la
  // lecture des KPIs, appliquée au même endroit.
  const visibles = options.masquerProprietaire
    ? identites.filter((identite) => identite.ownerAccount !== true && identite.managedByOwner !== true)
    : identites;
  const portee = options.porteeClients;
  if (!portee) return visibles;
  // Le filtre reçu peut être un `AND` (compartiment administrateur : furtivité
  // OWNER + gestionnaire) ou un `OR` (revendeur : attribution explicite ou
  // rattachement historique). Les deux formes sont traitées, car une forme non
  // reconnue ne doit jamais se lire comme « aucune restriction ».
  const evalue = (condition: any, identite: IdentiteAppareil): boolean => {
    if (!condition || typeof condition !== "object") return false;
    if (Array.isArray(condition.AND)) return condition.AND.every((c: any) => evalue(c, identite));
    if (Array.isArray(condition.OR)) return condition.OR.some((c: any) => evalue(c, identite));
    if (condition.id === "__aucun__") return false;
    // ── Listes d'identifiants — `{ id: { in: [...] } }` / `{ notIn: [...] }` ──
    //
    // C'est la forme que produit `exclureIdentifiants()` pour retrancher les
    // comptes d'essai. Faute d'être traitée ici, elle tombait dans le `return
    // false` final : la carte « CONNECTÉS » du tableau de bord affichait donc
    // ZÉRO en permanence — y compris pour le propriétaire, et alors même que
    // des clients étaient bel et bien connectés. Pire, comme les essais sont
    // comptés par différence (`total - connectedNow`), TOUS les connectés
    // basculaient dans « essais gratuits » : quatre clients commerciaux réels
    // étaient présentés comme quatre essayeurs.
    //
    // Mesuré en production avant correction : présence réelle 4, carte 0, et
    // `connectedTrials` 4 sur un parc qui n'avait aucun essai connecté.
    if (condition.id && typeof condition.id === "object") {
      const liste = condition.id as { in?: unknown; notIn?: unknown };
      if (Array.isArray(liste.notIn)) return !liste.notIn.map(String).includes(String(identite.clientId));
      if (Array.isArray(liste.in)) return liste.in.map(String).includes(String(identite.clientId));
    }
    // Furtivité exprimée en filtre Prisma : ici elle est déjà appliquée
    // au-dessus, la condition est donc satisfaite par construction.
    if (condition.user?.role?.name?.not === "OWNER") return identite.ownerAccount !== true;
    if (condition.managedBy?.role?.name?.not === "OWNER") return identite.managedByOwner !== true;
    if (condition.managedById !== undefined) return identite.managedById === condition.managedById;
    if (condition.resellerId !== undefined && condition.resellerId !== null) {
      return identite.resellerId === condition.resellerId;
    }
    if (condition.resellerId === null) {
      return identite.resellerId === null && identite.userId === condition.userId;
    }
    // ── Un refus, mais JAMAIS un refus muet ──────────────────────────────────
    //
    // Refuser reste le choix sûr : une forme non reconnue ne doit pas se lire
    // comme « aucune restriction », sous peine de fuite entre exploitants.
    // Mais refuser EN SILENCE est ce qui a permis au défaut ci-dessus de vivre
    // sans être vu : le compteur affichait zéro, et rien nulle part ne disait
    // pourquoi. On trace donc la forme incomprise — le prochain filtre ajouté
    // en amont se signalera dans les journaux au lieu de vider un compteur.
    console.error(
      "[presence] condition de portée non reconnue, appareils écartés par prudence:",
      JSON.stringify(condition)?.slice(0, 200),
    );
    return false;
  };
  return visibles.filter((identite) => evalue(portee, identite));
}

/**
 * Date du dernier signal reçu, toutes sources confondues.
 *
 * « 0 connecté » ne dit pas si personne n'est en ligne ou si plus rien
 * n'arrive. Cette date tranche : un exploitant qui lit « aucun signal depuis
 * cinq jours » sait que le problème n'est pas dans le compteur.
 *
 * Elle interroge les DEUX sources qui alimentent la présence — le battement de
 * santé et la consommation remontée. N'en lire qu'une faisait annoncer « aucun
 * signal depuis six jours » à un parc qui avait consommé le jour même : le
 * compteur comptait le trafic, la date l'ignorait.
 */
export async function dernierSignalPresence(db: any): Promise<Date | null> {
  const dates: Date[] = [];

  try {
    const battement = await db.mobileHealthDevice.findFirst({
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true },
    });
    if (battement?.lastSeenAt) dates.push(new Date(battement.lastSeenAt));
  } catch {
    // Une source muette ne doit pas effacer l'autre.
  }

  try {
    if (db?.trafficUsage?.findFirst) {
      const trafic = await db.trafficUsage.findFirst({
        where: { deviceId: { not: null } },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      });
      if (trafic?.timestamp) dates.push(new Date(trafic.timestamp));
    }
  } catch {
    // Idem : le battement seul reste exploitable.
  }

  const valides = dates.filter((date) => Number.isFinite(date.getTime()));
  if (valides.length === 0) return null;
  return valides.reduce((recent, date) => (date > recent ? date : recent));
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
  // Deux filtres, car ils portent sur deux modèles : une fiche revendeur n'a
  // pas de gestionnaire, un client si. Les mélanger ferait échouer la requête
  // sur un champ inconnu.
  const stealthRevendeur = options.masquerProprietaire ? FURTIVITE_OWNER_PORTEUR : {};
  const stealth = options.masquerProprietaire ? FURTIVITE_OWNER : {};
  // Le cloisonnement s'ajoute à la furtivité au lieu de la remplacer : les deux
  // conditions doivent tenir ensemble, sans quoi l'une annule l'autre.
  const etAvec = (base: Record<string, unknown>, portee?: Record<string, unknown> | null) => {
    const conditions = [base, portee ?? {}].filter((c) => c && Object.keys(c).length > 0);
    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  };
  const filtreFiches = etAvec(stealthRevendeur, options.porteeFichesRevendeur);
  const filtreParcs = etAvec({ resellerId: { not: null }, ...stealth }, options.porteeClients);
  const [fiches, compteurs] = await Promise.all([
    db.reseller.findMany({
      ...(filtreFiches ? { where: filtreFiches } : {}),
      select: { id: true, status: true, user: { select: { name: true, email: true } } },
    }),
    // Agrégat plutôt que chargement des parcs : le nombre de clients d'un
    // revendeur se compte en base, il ne se rapatrie pas ligne à ligne.
    db.vpnClient.groupBy({
      by: ["resellerId", "status"],
      where: filtreParcs,
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

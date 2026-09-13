/// free-trial.ts — Accès HTTP à la fonctionnalité « Essai gratuit ».
///
/// Rappel du principe : le jeton d'essai n'est PAS une configuration VPN.
/// Aucun type déclaré ici ne porte de champ technique (hôte, port, uuid,
/// quota du jeton…) ; les seules données d'accès apparaissent au moment du
/// DÉPLOIEMENT, et c'est l'admin qui les saisit.
import { apiRequest } from './client';

/** Jeton d'invitation, tel que le tableau de bord peut le lire. */
export interface FreeTrialToken {
  id: string;
  token: string;
  label: string | null;
  maxUses: number | null;
  usedCount: number;
  status: string;
  /** active | revoked | expired | exhausted — calculé côté serveur. */
  state: string;
  expiresAt: string | null;
  createdAt: string;
  requestCount?: number;
  /**
   * Compteurs par statut. Ils rendent la ligne du jeton lisible sans ouvrir le
   * volet : « 12 en attente · 3 déployées » se lit d'un coup d'œil, et les
   * demandes ne sont chargées qu'à l'ouverture.
   */
  pendingCount?: number;
  deployedCount?: number;
  rejectedCount?: number;
}

/** Taille maximale d'un lot, alignée sur `MAX_LOT_ESSAI` côté serveur. */
export const MAX_FREE_TRIAL_BATCH = 200;

/**
 * Nombre maximal de configurations VPN retenues d'un même geste, aligné sur
 * `MAX_CONFIGS_ESSAI`. Annoncé à l'écran plutôt que découvert par un refus.
 */
export const MAX_FREE_TRIAL_PROFILES = 10;

/**
 * Plafond du PRODUIT « inscrits × configurations », aligné sur
 * `MAX_FORFAITS_ESSAI`. C'est lui qui empêche une sélection large de fabriquer
 * des milliers de forfaits d'un clic ; l'interface l'annonce et calcule le
 * total avant toute confirmation.
 */
export const MAX_FREE_TRIAL_SUBSCRIPTIONS = 400;

/** Un forfait d'essai tel que la section Essais l'affiche. */
export interface FreeTrialSubscriptionView {
  id: string;
  name: string;
  profileId: string | null;
  profileName: string | null;
  status: string;
  /** Octets accordés, `"0"` pour un accès sans plafond. */
  quotaBytes: string;
  /** Octets CONSOMMÉS : le propriétaire veut voir ce qui a été utilisé. */
  quotaUsed: string;
  deviceLimit: number | null;
  startAt: string | null;
  expireAt: string | null;
}

/**
 * Accès courant d'un essai DÉJÀ déployé.
 *
 * C'est ce qui rend la section Essais autonome : serveur(s) attribué(s), quota
 * accordé et consommé, échéance, état. Sans cette lecture, retirer les options
 * d'essai des écrans d'exploitation priverait l'exploitant de tout moyen de
 * voir ce qu'un essai a reçu.
 */
export interface FreeTrialAccess {
  subscriptions: FreeTrialSubscriptionView[];
  quotaBytes: string;
  quotaUsed: string;
  /** Échéance la plus lointaine de l'ensemble des forfaits d'essai. */
  expireAt: string | null;
  active: boolean;
}

/** Demande déposée par un appareil : Nom | Pays | Identifiant d'appareil | Jeton. */
export interface FreeTrialRequest {
  id: string;
  name: string;
  deviceId: string;
  /**
   * Pays DÉCLARÉ par l'inscrit (ISO 3166-1 alpha-2), ou null pour les demandes
   * antérieures au champ. C'est une saisie, jamais une géolocalisation.
   */
  country: string | null;
  trialToken: string | null;
  trialLabel: string | null;
  platform: string | null;
  appVersion: string | null;
  status: string;
  clientId: string | null;
  subscriptionId: string | null;
  submittedAt: string;
  deployedAt: string | null;
  rejectedAt: string | null;
  lastCheckedAt: string | null;
  reviewNote: string | null;
  /**
   * Accès courant, présent uniquement pour une demande déployée. `null` tant
   * que rien n'a été attribué — jamais un objet vide qui se lirait « aucun
   * quota ».
   */
  access?: FreeTrialAccess | null;
  /**
   * Connexion RÉELLE de l'essayeur, mesurée par les battements de
   * l'application tant que le tunnel est monté — jamais déduite d'un compte
   * « actif ». `measured: false` signifie « rien n'a pu être mesuré », ce qui
   * n'est pas la même chose que « hors ligne ».
   */
  presence?: { connected: boolean; lastSeenAt: string | null; measured: boolean } | null;
}

/** Une ligne du récapitulatif « d'où viennent nos clients ». */
export interface FreeTrialCountryStat {
  /** Code ISO, ou null pour les demandes sans pays déclaré. */
  country: string | null;
  requests: number;
  pending: number;
  rejected: number;
  clients: number;
}

export interface FreeTrialCountryStats {
  countries: FreeTrialCountryStat[];
  totals: {
    countries: number;
    requests: number;
    clients: number;
    pending: number;
    rejected: number;
  };
}

export interface FreeTrialDeployResult {
  id: string;
  status: string;
  reason?: string;
  /** Nombre de forfaits créés pour CETTE demande — un par configuration. */
  subscriptions?: number;
}

export interface FreeTrialDeployResponse {
  success: boolean;
  deployed: number;
  total: number;
  /** Nombre de configurations retenues pour ce déploiement. */
  profiles?: number;
  /** Nombre TOTAL de forfaits créés : inscrits déployés × configurations. */
  subscriptionsCreated?: number;
  results: FreeTrialDeployResult[];
}

/** Un essai traité par la gestion groupée, rapporté élément par élément. */
export interface FreeTrialManageResult {
  id: string;
  status: string;
  reason?: string;
  /** Forfaits existants modifiés pour cet essai. */
  updated?: number;
  /** Forfaits créés par l'attribution de configurations supplémentaires. */
  created?: number;
}

export interface FreeTrialManageResponse {
  success: boolean;
  total: number;
  succeeded: number;
  updated: number;
  created: number;
  results: FreeTrialManageResult[];
}

/** Gestes d'état applicables à un essai déployé. */
export const FREE_TRIAL_STATE = {
  SUSPEND: 'suspend',
  RESUME: 'resume',
  REVOKE: 'revoke',
} as const;

export type FreeTrialState = (typeof FREE_TRIAL_STATE)[keyof typeof FREE_TRIAL_STATE];

/** Statuts d'une demande, alignés sur `STATUT_DEMANDE` du service. */
export const FREE_TRIAL_STATUS = {
  PENDING: 'pending',
  DEPLOYED: 'deployed',
  REJECTED: 'rejected',
} as const;

export async function fetchFreeTrialTokens(): Promise<FreeTrialToken[]> {
  const data = await apiRequest<{ tokens: FreeTrialToken[] }>('/free-trial/tokens');
  return Array.isArray(data?.tokens) ? data.tokens : [];
}

/**
 * Création d'un jeton. Le corps n'accepte volontairement AUCUN paramètre
 * d'accès : ni serveur, ni quota, ni fenêtre de validité de l'abonnement.
 * `expiresAt` borne la durée de vie de l'INVITATION, pas celle de l'essai.
 */
export async function createFreeTrialToken(input: {
  label?: string;
  maxUses?: number | null;
  expiresAt?: string;
}): Promise<FreeTrialToken> {
  const data = await apiRequest<{ success: boolean; token: FreeTrialToken }>('/free-trial/tokens', {
    method: 'POST',
    body: input,
  });
  return data.token;
}

export async function revokeFreeTrialToken(id: string): Promise<FreeTrialToken> {
  const data = await apiRequest<{ success: boolean; token: FreeTrialToken }>(
    `/free-trial/tokens/${encodeURIComponent(id)}/revoke`,
    { method: 'POST' },
  );
  return data.token;
}

/**
 * Modifie un jeton déjà émis : libellé, plafond, échéance.
 *
 * Le CODE n'est pas modifiable — il est distribué, et le changer invaliderait
 * en silence tous les exemplaires déjà dans la nature.
 *
 * `null` est signifiant : il LÈVE le plafond ou RETIRE l'échéance. Une clé
 * absente ne change rien, donc l'appelant n'envoie que ce qu'il édite.
 */
export async function updateFreeTrialToken(id: string, input: {
  label?: string | null;
  maxUses?: number | null;
  expiresAt?: string | null;
}): Promise<FreeTrialToken> {
  const data = await apiRequest<{ success: boolean; token: FreeTrialToken }>(
    `/free-trial/tokens/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input },
  );
  return data.token;
}

/**
 * Supprime un jeton JAMAIS UTILISÉ.
 *
 * Le serveur refuse (409) dès qu'une inscription existe : la relation porte un
 * `onDelete: Cascade`, si bien que supprimer un jeton qui a servi effacerait
 * l'historique des personnes qu'il a inscrites. Pour celles-là, la révocation
 * est la bonne réponse — elle ferme le jeton sans rien détruire.
 */
export async function deleteFreeTrialToken(id: string): Promise<void> {
  await apiRequest<{ success: boolean; deleted: boolean }>(
    `/free-trial/tokens/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

/** Une session VPN observée pour un essayeur. */
export interface FreeTrialSession {
  at: string | null;
  tunnelState: string | null;
  protocol: string | null;
  outcome: string | null;
  errorCode: string | null;
  durationSeconds: number;
  reconnects: number;
}

/** Une remontée de consommation pour un essayeur. */
export interface FreeTrialUsageEntry {
  at: string | null;
  downloadBytes: string;
  uploadBytes: string;
  deviceId: string | null;
}

/**
 * Historique d'UN essayeur : ses sessions VPN et sa consommation.
 *
 * `sessionsMeasured: false` signifie « rien n'a pu être lu » — pas de secret de
 * pseudonymisation, appareil inconnu de la table de santé —, ce qui n'est pas
 * la même chose qu'un historique vide.
 */
export interface FreeTrialActivity {
  requestId: string;
  name: string;
  deviceId: string;
  windowDays: number;
  sessionsMeasured: boolean;
  sessions: FreeTrialSession[];
  usage: FreeTrialUsageEntry[];
  /** La lecture est bornée : au-delà, l'historique affiché est partiel. */
  truncated: boolean;
}

export async function fetchFreeTrialActivity(requestId: string): Promise<FreeTrialActivity> {
  return apiRequest<FreeTrialActivity>(
    `/free-trial/requests/${encodeURIComponent(requestId)}/activity`,
  );
}

export async function fetchFreeTrialRequests(status?: string): Promise<FreeTrialRequest[]> {  const page = await fetchFreeTrialRequestPage({ status });
  return page.requests;
}

/** Une page de demandes, éventuellement restreinte à UN jeton. */
export interface FreeTrialRequestPage {
  requests: FreeTrialRequest[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Lecture paginée, normalement restreinte à un jeton.
 *
 * C'est le chemin utilisé par le volet dépliable : on ne charge jamais les
 * demandes de tous les jetons pour dessiner la page, et 200 inscriptions sous
 * un même jeton se parcourent page par page.
 */
export async function fetchFreeTrialRequestPage(params: {
  status?: string;
  tokenId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<FreeTrialRequestPage> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.tokenId) query.set('tokenId', params.tokenId);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await apiRequest<FreeTrialRequestPage>(`/free-trial/requests${suffix}`);
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  return {
    requests,
    total: Number.isFinite(data?.total) ? Number(data.total) : requests.length,
    limit: Number(data?.limit ?? requests.length),
    offset: Number(data?.offset ?? 0),
  };
}

/**
 * Indicateurs de la SECTION essai gratuit — jamais mélangés à ceux des comptes
 * principaux, puisqu'ils dérivent tous des demandes d'essai.
 */
export interface FreeTrialOverview {
  total: number;
  pending: number;
  deployed: number;
  rejected: number;
  /** Essais déployés dont l'accès est encore ouvert aujourd'hui. */
  active: number;
  /** `null` quand la présence n'a pas pu être mesurée — jamais un zéro trompeur. */
  connectedNow: number | null;
  presence: {
    measured: boolean;
    reason: string | null;
    windowMinutes: number;
    heartbeatMinutes: number;
    /**
     * La lecture des signaux de présence est bornée. Au-delà du plafond, un
     * essai connecté peut se trouver hors de la tranche lue : le compteur reste
     * alors un minimum, ce que dit déjà la mention sous les indicateurs.
     */
    truncated?: boolean;
  };
  /**
   * Volume PROPRE aux essais, en octets et en chaînes (BigInt non transportable
   * en JSON). Il ne se mélange jamais au trafic commercial.
   */
  trafficGrantedBytes?: string;
  trafficUsedBytes?: string;
  trafficRemainingBytes?: string;
  /** Forfaits d'essai sans plafond : ils ne s'additionnent pas à l'accordé. */
  unlimitedPlans?: number;
}

/**
 * Récapitulatif par pays : combien de clients et de demandes, d'où.
 *
 * Ne renvoie QUE des compteurs — jamais un nom, un appareil ni un jeton. La
 * route est réservée à l'exploitation interne : un revendeur reçoit un 403,
 * ses propres clients lui parvenant déjà par /clients et /devices.
 */
export async function fetchFreeTrialCountryStats(): Promise<FreeTrialCountryStats> {
  const data = await apiRequest<FreeTrialCountryStats>('/free-trial/stats/countries');
  return {
    countries: Array.isArray(data?.countries) ? data.countries : [],
    totals: data?.totals ?? { countries: 0, requests: 0, clients: 0, pending: 0, rejected: 0 },
  };
}

/**
 * Indicateurs propres à l'essai : inscrits, en attente, déployés, refusés,
 * essais encore actifs et essais connectés maintenant.
 *
 * « Connectés maintenant » vient de la mesure de présence déjà en place
 * (fenêtre de 15 min, battement de 5 min) : aucun second calcul n'existe.
 * Quand elle n'est pas mesurable, `connectedNow` vaut `null` et l'interface le
 * dit, au lieu d'afficher un zéro qui se lirait « personne n'est connecté ».
 */
export async function fetchFreeTrialOverview(): Promise<FreeTrialOverview> {
  return apiRequest<FreeTrialOverview>('/free-trial/stats/overview');
}

/**
 * Étape 3 → 4 : l'admin a sélectionné des inscrits, puis décide de ce que
 * CHACUN reçoit. Une seule requête couvre toute la sélection ; le serveur
 * traite les demandes une par une et rend le détail par identifiant.
 *
 * `profileIds` accepte PLUSIEURS configurations : chaque inscrit retenu reçoit
 * alors un forfait par configuration, comme un client principal peut détenir
 * plusieurs forfaits. Le quota et les dates s'appliquent à chacun. Le produit
 * « inscrits × configurations » est borné par `MAX_FREE_TRIAL_SUBSCRIPTIONS`.
 *
 * `profileId` reste accepté par le serveur pour les appelants historiques ;
 * le tableau de bord envoie toujours `profileIds`, même à une seule valeur.
 */
export async function deployFreeTrialRequests(input: {
  requestIds: string[];
  /** Jeton SOUS LEQUEL l'action est lancée : le serveur revérifie chaque demande. */
  tokenId?: string;
  profileIds: string[];
  quotaGB: number;
  startAt?: string;
  expireAt: string;
  deviceLimit?: number;
  note?: string;
}): Promise<FreeTrialDeployResponse> {
  return apiRequest<FreeTrialDeployResponse>('/free-trial/requests/deploy', {
    method: 'POST',
    body: input,
  });
}

/**
 * Gestion des essais DÉJÀ déployés, en sélection multiple.
 *
 * C'est la contrepartie de la séparation totale : les écrans d'exploitation
 * n'offrent plus aucune prise sur un essai, donc TOUT se fait ici. Chaque champ
 * est indépendamment facultatif — ce qui n'est pas renseigné n'est pas
 * réécrit —, exactement comme l'action groupée « apply » des forfaits, dont la
 * mécanique serveur est réutilisée et non recopiée.
 *
 *  • `profileId`   — REMPLACE la configuration des forfaits d'essai existants ;
 *  • `profileIds`  — ATTRIBUE des configurations SUPPLÉMENTAIRES (un forfait de
 *                    plus par configuration) ; s'exclut de `profileId` ;
 *  • `quotaGB`     — volume accordé, `quotaMode` valant `set` (par défaut) ou `add` ;
 *  • `expireAt`    — échéance explicite, exclusive de `durationDays` ;
 *  • `durationDays`— durée, `durationMode` valant `set` (par défaut) ou `add`,
 *                    ce qui prolonge ou raccourcit ;
 *  • `state`       — geste explicite : suspendre, réactiver ou révoquer.
 */
export async function manageFreeTrialRequests(input: {
  requestIds: string[];
  tokenId?: string;
  profileId?: string;
  profileIds?: string[];
  quotaGB?: number;
  quotaMode?: 'set' | 'add';
  startAt?: string;
  expireAt?: string;
  durationDays?: number;
  durationMode?: 'set' | 'add';
  state?: FreeTrialState;
  note?: string;
}): Promise<FreeTrialManageResponse> {
  return apiRequest<FreeTrialManageResponse>('/free-trial/requests/manage', {
    method: 'POST',
    body: input,
  });
}

export async function rejectFreeTrialRequests(input: {
  requestIds: string[];
  tokenId?: string;
  note?: string;
}): Promise<{ success: boolean; rejected: number; total: number }> {
  return apiRequest<{ success: boolean; rejected: number; total: number }>(
    '/free-trial/requests/reject',
    { method: 'POST', body: input },
  );
}

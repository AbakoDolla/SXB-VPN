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
}

/** Demande déposée par un appareil : Nom | Identifiant d'appareil | Jeton. */
export interface FreeTrialRequest {
  id: string;
  name: string;
  deviceId: string;
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
}

export interface FreeTrialDeployResult {
  id: string;
  status: string;
  reason?: string;
}

export interface FreeTrialDeployResponse {
  success: boolean;
  deployed: number;
  total: number;
  results: FreeTrialDeployResult[];
}

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

export async function fetchFreeTrialRequests(status?: string): Promise<FreeTrialRequest[]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await apiRequest<{ requests: FreeTrialRequest[] }>(`/free-trial/requests${suffix}`);
  return Array.isArray(data?.requests) ? data.requests : [];
}

/**
 * Étape 3 → 4 : l'admin a sélectionné des inscrits, puis décide de ce que
 * CHACUN reçoit. Une seule requête couvre toute la sélection ; le serveur
 * traite les demandes une par une et rend le détail par identifiant.
 */
export async function deployFreeTrialRequests(input: {
  requestIds: string[];
  profileId: string;
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

export async function rejectFreeTrialRequests(input: {
  requestIds: string[];
  note?: string;
}): Promise<{ success: boolean; rejected: number; total: number }> {
  return apiRequest<{ success: boolean; rejected: number; total: number }>(
    '/free-trial/requests/reject',
    { method: 'POST', body: input },
  );
}

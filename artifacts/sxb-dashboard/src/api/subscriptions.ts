import { apiRequest } from './client';

export interface Subscription {
  id: string;
  name: string;
  clientId: string;
  profileId: string;
  dataToken: string;
  quotaBytes: string | number;
  quotaUsed: string | number;
  durationDays: number;
  deviceLimit: number;
  deviceId: string | null;
  startAt: string;
  expireAt: string | null;
  status: 'active' | 'expired' | 'revoked' | 'suspended' | 'exhausted';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  client?: {
    id: string;
    token: string;
    user?: { name: string; email: string };
    resellerId?: string | null;
    reseller?: { id: string; name: string | null; email: string | null } | null;
  };
  profile?: { id: string; name: string; protocol?: string; displayProtocol?: string | null };
  /** Propriété commerciale, remontée au niveau du forfait pour les rôles supérieurs. */
  resellerId?: string | null;
  resellerName?: string | null;
}

export interface SubStats { total: number; active: number; expired: number }

/**
 * SÉPARATION TOTALE — aucune option d'inclusion n'existe ici.
 *
 * « Forfaits Data », « Comptes VPN » et « Appareils » ne connaissent plus les
 * essais gratuits : ils relèvent exclusivement de leur propre section. Aucun
 * paramètre d'inclusion n'est donc construit, envoyé, ni même déclaré côté
 * tableau de bord — il n'y a rien à basculer, et rien qui puisse les ramener.
 * L'exclusion est appliquée par le SERVEUR, qui la tient pour règle par défaut.
 */
export async function fetchSubscriptions(): Promise<Subscription[]> {
  const data = await apiRequest<{ subscriptions: Subscription[] }>('/subscriptions');
  return data.subscriptions ?? [];
}

/** Compteurs du même périmètre que la liste : ils ne peuvent pas diverger. */
export async function fetchSubStats(): Promise<SubStats> {
  const data = await apiRequest<SubStats>('/subscriptions/stats');
  return data;
}

/**
 * SEUL point d'attribution d'un plan.
 *
 * Ni l'activation d'un appareil ni la création d'un client n'attribuent de
 * forfait : c'est un choix commercial explicite, qui exige un client possédé,
 * une configuration attribuée, un volume et une durée.
 */
export async function createSubscription(payload: {
  clientId: string;
  profileId: string;
  name?: string;
  quotaGB: number;
  durationDays: number;
  deviceLimit?: number;
  deviceId?: string;
}): Promise<Subscription> {
  const data = await apiRequest<{ subscription: Subscription }>('/subscriptions', {
    method: 'POST',
    body: { ...payload, name: payload.name?.trim() || undefined },
  });
  return data.subscription;
}

/**
 * Modification d'un forfait : quota, durée, appareils, configuration, et
 * suspension/réactivation via `status`. Suspendre et réduire restent possibles
 * quand le plafond est atteint — ce sont les gestes qui en font sortir.
 */
export async function updateSubscription(id: string, payload: Partial<{
  name: string; quotaGB: number; durationDays: number; deviceLimit: number;
  status: 'active' | 'suspended' | 'expired' | 'revoked'; profileId: string;
}>): Promise<Subscription> {
  const data = await apiRequest<{ subscription: Subscription }>(`/subscriptions/${id}`, {
    method: 'PUT',
    body: payload,
  });
  return data.subscription;
}

export async function suspendSubscription(id: string): Promise<Subscription> {
  return updateSubscription(id, { status: 'suspended' });
}

export async function reactivateSubscription(id: string): Promise<Subscription> {
  return updateSubscription(id, { status: 'active' });
}

export async function deleteSubscription(id: string): Promise<void> {
  await apiRequest(`/subscriptions/${id}`, { method: 'DELETE' });
}

export async function revokeSubscription(id: string, reason?: string): Promise<void> {
  await apiRequest(`/subscriptions/${id}/revoke`, { method: 'POST', body: { reason } });
}

// ── Opérations groupées ──────────────────────────────────────────────────────
//
// `apply` est le point d'entrée du formulaire groupé : chacun de ses champs est
// indépendamment facultatif, et ce qui n'est pas renseigné n'est pas réécrit.
// Les quatre actions historiques restent exposées pour les intégrations qui
// les appellent encore ; l'interface, elle, n'utilise plus que `apply` et
// `deploy`.
//   apply           applique en une passe serveur / volume / début / échéance
//   deploy          crée un forfait (config + quota + durée) pour N clients
//   set             REMPLACE le quota et/ou la durée des forfaits visés
//   add_data        AJOUTE du quota au solde existant, sans l'écraser
//   extend_duration AJOUTE des jours à l'échéance existante
export type BulkAction = 'apply' | 'deploy' | 'set' | 'add_data' | 'extend_duration';

/** `set` remplace la valeur ; `add` s'ajoute à l'existant. */
export type BulkValueMode = 'set' | 'add';

/** Taille maximale d'un lot « appliquer » — doit rester alignée sur le serveur. */
export const MAX_BULK_APPLY = 200;

export interface BulkResult {
  action: BulkAction;
  selected: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: Array<{ id: string; status: string; reason?: string }>;
}

export interface BulkPayload {
  action: BulkAction;
  clientIds?: string[];
  subscriptionIds?: string[];
  /** Configuration VPN / serveur de rattachement. Omis = inchangé. */
  profileId?: string;
  /** Volume en Go, interprété selon `quotaMode`. Omis = inchangé. */
  quotaGB?: number;
  quotaMode?: BulkValueMode;
  /** Date/heure ISO de début. Omis = inchangé. */
  startAt?: string;
  /** Échéance ISO explicite. Exclusive de `durationDays`. Omis = inchangé. */
  expireAt?: string;
  /** Durée en jours, interprétée selon `durationMode`. Omis = inchangé. */
  durationDays?: number;
  durationMode?: BulkValueMode;
}

export async function bulkSubscriptions(payload: BulkPayload): Promise<BulkResult> {
  return await apiRequest<BulkResult>('/subscriptions/bulk', { method: 'POST', body: payload });
}

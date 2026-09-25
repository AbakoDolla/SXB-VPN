import { apiRequest } from './client';

/**
 * « Données ajoutées » — historique des Go ajoutés aux connexions, par serveur.
 *
 * Les octets restent des chaînes exactes : un volume cumulé dépasse vite ce
 * qu'un `number` représente sans perte, et `formatBytes` les lit tels quels.
 * Les essais gratuits sont exclus par le serveur, sans option d'inclusion —
 * la même séparation que dans tous les écrans commerciaux.
 */
export interface DataAddition {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  /** Serveur : la configuration VPN du forfait. */
  profileId: string;
  profileName: string;
  clientId: string;
  clientName: string;
  actorName: string;
  /** `creation` : volume initial du forfait ; `ajout` : Go ajoutés ensuite. */
  kind: 'creation' | 'ajout';
  addedBytes: string;
  quotaBeforeBytes: string;
  quotaAfterBytes: string;
  createdAt: string;
}

export interface DataAdditionServer {
  profileId: string;
  profileName: string;
  /** Nombre d'ajouts consignés sur ce serveur. */
  additions: number;
  addedBytes: string;
  lastAddedAt: string | null;
  /** Forfaits ACTUELS du serveur, sur lesquels portent consommé et restant. */
  subscriptions: number;
  usedBytes: string;
  remainingBytes: string;
  /** Au moins un forfait illimité : le restant n'a pas de borne. */
  unlimited: boolean;
}

export interface DataAdditionCursor { before: string; beforeId: string }

export interface DataAdditionPage {
  additions: DataAddition[];
  next: DataAdditionCursor | null;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function fetchDataAdditions(options: { limit?: number; cursor?: DataAdditionCursor | null } = {}):
  Promise<DataAdditionPage & { totals: { count: number; addedBytes: string } }> {
  const data = await apiRequest<DataAdditionPage & { totals: { count: number; addedBytes: string } }>(
    `/data-additions${query({ limit: options.limit, before: options.cursor?.before, beforeId: options.cursor?.beforeId })}`,
  );
  return {
    additions: data.additions ?? [],
    next: data.next ?? null,
    totals: data.totals ?? { count: 0, addedBytes: '0' },
  };
}

export async function fetchDataAdditionServers(): Promise<DataAdditionServer[]> {
  const data = await apiRequest<{ servers: DataAdditionServer[] }>('/data-additions/servers');
  return data.servers ?? [];
}

export async function fetchDataAdditionServer(profileId: string, cursor?: DataAdditionCursor | null):
  Promise<DataAdditionPage & { server: DataAdditionServer }> {
  const data = await apiRequest<DataAdditionPage & { server: DataAdditionServer }>(
    `/data-additions/servers/${encodeURIComponent(profileId)}${query({ limit: 200, before: cursor?.before, beforeId: cursor?.beforeId })}`,
  );
  return { server: data.server, additions: data.additions ?? [], next: data.next ?? null };
}

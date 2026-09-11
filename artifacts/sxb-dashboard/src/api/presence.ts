import { apiRequest } from './client';

/**
 * Présence VPN — contrat de lecture.
 *
 * Ces types décrivent ce que la plateforme a MESURÉ, pas ce qu'elle suppose.
 * `lastSeenAt` est un fait ; il n'existe aucun champ « déconnecté », parce que
 * le silence d'un appareil n'est pas une déconnexion observée.
 */
export interface ConnectedUser {
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
  /** Début de la session en cours, ou null quand il n'a pas pu être daté. */
  connectedSinceAt: string | null;
  connectedSinceMeasured: boolean;
}

export interface ConnectedUsersPage {
  generatedAt: string;
  presenceWindowMinutes: number;
  heartbeatMinutes: number;
  measured: boolean;
  scope: 'own' | 'platform';
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  unmatched: number;
  users: ConnectedUser[];
}

export interface ResellerPresenceGroup {
  resellerId: string | null;
  resellerName: string | null;
  status: string | null;
  directClients: boolean;
  connectedNow: number;
  totalClients: number;
  activeClients: number;
  users: ConnectedUser[];
}

export interface ResellerPresence {
  generatedAt: string;
  presenceWindowMinutes: number;
  heartbeatMinutes: number;
  measured: boolean;
  totalConnected: number;
  unmatched: number;
  truncated: boolean;
  resellers: ResellerPresenceGroup[];
  direct: ResellerPresenceGroup;
}

export function fetchConnectedUsers(limit = 200, offset = 0): Promise<ConnectedUsersPage> {
  return apiRequest<ConnectedUsersPage>(`/presence/connected?limit=${limit}&offset=${offset}`);
}

export function fetchResellerPresence(): Promise<ResellerPresence> {
  return apiRequest<ResellerPresence>('/presence/resellers');
}

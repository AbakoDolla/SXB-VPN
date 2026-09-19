import { apiRequest } from './client';

export type AnnouncementLevel = 'info' | 'success' | 'warning' | 'error';

export interface Announcement {
  id: string;
  title: string;
  message: string;
  level: AnnouncementLevel;
  active: boolean;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  targetDeviceId?: string | null;
};

export type AnnouncementInput = Pick<Announcement, 'title' | 'message' | 'level' | 'active'> & {
  startsAt?: string;
  expiresAt?: string | null;
  targetDeviceId?: string | null;
};

/**
 * Ce que le serveur a RÉELLEMENT fait de l'annonce, au-delà de l'enregistrer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE RÉSULTAT DOIT REMONTER
 * ═══════════════════════════════════════════════════════════════════════════
 * Le serveur renvoie déjà ce compte rendu, et le tableau de bord le jetait.
 * L'exploitant publiait donc une annonce, ne voyait aucune erreur, et en
 * concluait qu'elle était arrivée sur tous les téléphones.
 *
 * Mesuré en production : `status: "disabled"`, motif `FCM_NOT_CONFIGURED`,
 * zéro destinataire sur trente-huit appareils. Aucune annonce n'avait jamais
 * été poussée, et rien ne le disait.
 *
 * Un envoi qui échoue en silence est pire qu'un envoi qui refuse : on continue
 * de s'en servir en croyant qu'il porte.
 */
export interface ResultatPoussee {
  /** `disabled` = le serveur n'a pas les identifiants Firebase. */
  status: 'sent' | 'partial' | 'failed' | 'disabled' | 'skipped';
  /**
   * Code de diagnostic, par exemple `FCM_NOT_CONFIGURED`.
   *
   * Le serveur le nomme `error`. `reason` est toléré au cas où un déploiement
   * antérieur emploierait l'autre nom : lire le mauvais champ ferait retomber
   * l'affichage sur le message générique, en taisant justement la cause qu'on
   * voulait nommer.
   */
  error?: string;
  reason?: string;
  /** Nombre d'appareils réellement touchés. */
  sent?: number;
  /** Nombre d'appareils visés — un zéro ici signale un parc sans jeton. */
  attempted?: number;
}

/** Code de diagnostic de l'envoi, quel que soit le nom que le serveur lui donne. */
export function motifPoussee(push: ResultatPoussee | null | undefined): string | undefined {
  return push?.error ?? push?.reason;
}

export interface AnnouncementCreated {
  announcement: Announcement;
  /** Absent d'un serveur antérieur à ce compte rendu : traité comme inconnu. */
  push?: ResultatPoussee;
}

export async function fetchAnnouncements(): Promise<Announcement[]> {
  const data = await apiRequest<{ announcements: Announcement[] }>('/announcements');
  return data.announcements || [];
}

export async function createAnnouncement(input: AnnouncementInput): Promise<AnnouncementCreated> {
  const data = await apiRequest<AnnouncementCreated>('/announcements', { method: 'POST', body: input });
  return { announcement: data.announcement, push: data.push };
}

export async function updateAnnouncement(id: string, input: Partial<AnnouncementInput>): Promise<Announcement> {
  const data = await apiRequest<{ announcement: Announcement }>(`/announcements/${id}`, { method: 'PATCH', body: input });
  return data.announcement;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await apiRequest(`/announcements/${id}`, { method: 'DELETE' });
}

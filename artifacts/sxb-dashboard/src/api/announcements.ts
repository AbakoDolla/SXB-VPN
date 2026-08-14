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

export async function fetchAnnouncements(): Promise<Announcement[]> {
  const data = await apiRequest<{ announcements: Announcement[] }>('/announcements');
  return data.announcements || [];
}

export async function createAnnouncement(input: AnnouncementInput): Promise<Announcement> {
  const data = await apiRequest<{ announcement: Announcement }>('/announcements', { method: 'POST', body: input });
  return data.announcement;
}

export async function updateAnnouncement(id: string, input: Partial<AnnouncementInput>): Promise<Announcement> {
  const data = await apiRequest<{ announcement: Announcement }>(`/announcements/${id}`, { method: 'PATCH', body: input });
  return data.announcement;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await apiRequest(`/announcements/${id}`, { method: 'DELETE' });
}

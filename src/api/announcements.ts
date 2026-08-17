import { apiClient } from './client';

export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: 'info' | 'warning' | 'success' | 'critical';
  target?: string | null;
  isActive: boolean;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getAnnouncements(): Promise<Announcement[]> {
  const res = await apiClient.get('/announcements');
  return res.data;
}

export async function createAnnouncement(data: Partial<Announcement>): Promise<Announcement> {
  const res = await apiClient.post('/announcements', data);
  return res.data;
}

export async function updateAnnouncement(id: string, data: Partial<Announcement>): Promise<Announcement> {
  const res = await apiClient.patch(`/announcements/${id}`, data);
  return res.data;
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await apiClient.delete(`/announcements/${id}`);
}

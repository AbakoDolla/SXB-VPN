import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import type { Notification as MobileNotification } from '@/types/api';

const DELIVERED_ANNOUNCEMENTS_KEY = '@sxb_delivered_announcement_ids_v1';
const MAX_REMEMBERED_IDS = 100;

interface SxbAnnouncementNativeModule {
  postAnnouncementNotification?: (id: string, title: string, message: string) => Promise<boolean>;
}

function isDeliverableNotification(notification: MobileNotification): boolean {
  return notification.id.startsWith('announcement-') || notification.id.startsWith('app-update-');
}

async function readDeliveredIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(DELIVERED_ANNOUNCEMENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Fait remonter les annonces actives depuis l’API authentifiée vers Android.
 * Ce mécanisme est volontairement local : il ne prétend pas être un push lorsque
 * l’application est arrêtée. Un transport FCM côté serveur reste nécessaire pour
 * la réception immédiate sur application complètement fermée.
 */
export async function syncAnnouncementNotifications(): Promise<void> {
  if (Platform.OS !== 'android') return;

  const nativeModule = NativeModules.SxbVpnNative as SxbAnnouncementNativeModule | undefined;
  if (!nativeModule?.postAnnouncementNotification) return;

  let notifications: MobileNotification[] = [];
  try {
    const response = await apiClient.get('/mobile/notifications');
    notifications = Array.isArray(response.data) ? response.data : [];
  } catch {
    return;
  }

  const announcements = notifications
    .filter(isDeliverableNotification)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  if (announcements.length === 0) return;

  const delivered = await readDeliveredIds();
  const deliveredSet = new Set(delivered);
  const newlyDelivered: string[] = [];

  for (const announcement of announcements) {
    if (deliveredSet.has(announcement.id)) continue;
    try {
      const posted = await nativeModule.postAnnouncementNotification(
        announcement.id,
        announcement.title,
        announcement.message,
      );
      if (posted) newlyDelivered.push(announcement.id);
    } catch {
      // Une erreur de notification ne doit jamais bloquer la synchronisation VPN.
    }
  }

  if (newlyDelivered.length > 0) {
    const next = [...newlyDelivered, ...delivered.filter((id) => !newlyDelivered.includes(id))]
      .slice(0, MAX_REMEMBERED_IDS);
    await AsyncStorage.setItem(DELIVERED_ANNOUNCEMENTS_KEY, JSON.stringify(next)).catch(() => {});
  }
}

import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import type { Notification as MobileNotification } from '@/types/api';
import { getPrivacyConsent } from './privacyConsent';
import { isPlayDistribution } from './distribution';

const DELIVERED_ANNOUNCEMENTS_KEY = '@sxb_delivered_announcement_ids_v1';
export const ANNOUNCEMENT_NOTIFICATIONS_ENABLED_KEY = '@sxb_announcement_notifications_enabled_v1';
const MAX_REMEMBERED_IDS = 100;

interface SxbAnnouncementNativeModule {
  postAnnouncementNotification?: (id: string, title: string, message: string) => Promise<boolean>;
}

function isDeliverableNotification(notification: MobileNotification): boolean {
  if (isPlayDistribution && (notification.appUpdate || notification.id.startsWith('app-update-'))) return false;
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

export async function areAnnouncementNotificationsEnabled(): Promise<boolean> {
  if (!getPrivacyConsent().vpn || !getPrivacyConsent().notifications) return false;
  if (isPlayDistribution) return true;
  const stored = await AsyncStorage.getItem(ANNOUNCEMENT_NOTIFICATIONS_ENABLED_KEY).catch(() => null);
  return stored !== 'false';
}

export async function setAnnouncementNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(ANNOUNCEMENT_NOTIFICATIONS_ENABLED_KEY, enabled ? 'true' : 'false');
}

/**
 * Fait remonter les annonces actives depuis l’API authentifiée vers Android.
 * Ce mécanisme reste le repli au premier plan lorsque FCM n'est pas configuré ou
 * que l'appareil n'a pas encore enregistré son jeton.
 */
export async function syncAnnouncementNotifications(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!(await areAnnouncementNotificationsEnabled())) return;

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
    if (!(await areAnnouncementNotificationsEnabled())) return;
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

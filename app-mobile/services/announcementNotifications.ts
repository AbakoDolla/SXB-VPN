import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import type { Notification as MobileNotification } from '@/types/api';
import { getPrivacyConsent } from './privacyConsent';

const DELIVERED_ANNOUNCEMENTS_KEY = '@sxb_delivered_announcement_ids_v1';
export const ANNOUNCEMENT_NOTIFICATIONS_ENABLED_KEY = '@sxb_announcement_notifications_enabled_v1';
const MAX_REMEMBERED_IDS = 100;

interface SxbAnnouncementNativeModule {
  postAnnouncementNotification?: (
    id: string,
    title: string,
    message: string,
    /** Gravité, pour que la teinte du bandeau dise l'urgence avant le texte. */
    level: string,
  ) => Promise<boolean>;
}

/**
 * Cette nouvelle doit-elle apparaître sur l'écran de l'appareil ?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CE QUI ÉTAIT ÉCARTÉ EN SILENCE
 * ═══════════════════════════════════════════════════════════════════════════
 * La règle ne retenait que deux préfixes : `announcement-` et `app-update-`.
 * Or le serveur en produit un troisième — `ticket-`, quand une demande de
 * support est résolue ou clôturée — et toute nouvelle catégorie future aurait
 * subi le même sort. L'utilisateur ne l'apprenait qu'en ouvrant l'application
 * de lui-même, c'est-à-dire rarement.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LA RÈGLE EST DONC INVERSÉE : ON EXCLUT, ON N'ÉNUMÈRE PLUS
 * ═══════════════════════════════════════════════════════════════════════════
 * Tout ce qui vient du tableau de bord passe, SAUF deux cas :
 *
 *   - `log-…` : l'écho de l'activité de l'utilisateur lui-même — ses propres
 *     connexions et déconnexions VPN. Les annoncer serait lui apprendre ce
 *     qu'il vient de faire, plusieurs fois par jour. Une alerte qu'on apprend
 *     à ignorer est pire que pas d'alerte du tout.
 *
 *   - ce que le serveur marque DÉJÀ LU : il a lui-même jugé qu'il n'y avait
 *     rien à signaler.
 *
 * Une catégorie nouvelle atteint ainsi l'appareil sans qu'on ait à y penser,
 * ce qui est précisément ce qu'on attend d'un centre de notifications.
 */
function isDeliverableNotification(notification: MobileNotification): boolean {
  // Les annonces de MISE À JOUR sont désormais délivrées à tout le monde : le
  // canal Play les masquait, puisque la boutique s'en chargeait elle-même.
  // Sans ce canal, les masquer priverait l'appareil du seul avis qui lui dit
  // qu'une nouvelle version existe.
  // L'activité propre de l'utilisateur n'est pas une nouvelle du tableau de bord.
  if (notification.id.startsWith('log-')) return false;
  // Le serveur écrit `read`, le type de l'application `isRead` : les deux sont
  // lus, faute de quoi la distinction se perdrait selon la version du serveur.
  const vue = (notification as { read?: boolean }).read ?? notification.isRead;
  return vue !== true;
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
        announcement.type ?? 'info',
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

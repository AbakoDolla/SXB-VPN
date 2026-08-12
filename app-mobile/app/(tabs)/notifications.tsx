import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "@/services/apiClient";
import type { Notification } from "@/types/api";
import Colors from "@/constants/colors";
import { useTranslation } from "@/localization";

const READ_NOTIFICATION_IDS_KEY = '@sxb_read_notification_ids_v1';

const TYPE_MAP: Record<string, { icon: string; color: string }> = {
  warning: { icon: "warning",       color: Colors.warning },
  error:   { icon: "alert-circle",  color: Colors.disconnected },
  success: { icon: "checkmark-circle", color: Colors.connected },
  info:    { icon: "information-circle", color: Colors.primary },
};

function NotifRow({ item, onMarkRead }: { item: Notification; onMarkRead: (id: string) => void }) {
  const { t } = useTranslation();
  const meta = TYPE_MAP[item.type] || TYPE_MAP.info;
  const timeAgo = (() => {
    const diff = Date.now() - new Date(item.createdAt).getTime();
    const m = Math.max(0, Math.floor(diff / 60000));
    if (m < 60) return `${m}${t('time_minutes_short')}`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}${t('time_hours_short')}`;
    return `${Math.floor(h / 24)}${t('time_days_short')}`;
  })();

  return (
    <Pressable
      onPress={() => !item.isRead && onMarkRead(item.id)}
      style={[styles.notifCard, !item.isRead && styles.notifCardUnread]}
    >
      {!item.isRead && <View style={[styles.unreadDot, { backgroundColor: meta.color }]} />}
      <View style={[styles.notifIcon, { backgroundColor: meta.color + "15" }]}>
        <Ionicons name={meta.icon as any} size={20} color={meta.color} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[styles.notifTitle, !item.isRead && styles.notifTitleUnread]}>{item.title}</Text>
        <Text style={styles.notifMsg} numberOfLines={2}>{item.message}</Text>
        <Text style={styles.notifTime}>{timeAgo}</Text>
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [items, setItems]   = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiClient.get('/mobile/notifications'),
      AsyncStorage.getItem(READ_NOTIFICATION_IDS_KEY),
    ]).then(([response, stored]) => {
      if (cancelled) return;
      const readIds = new Set<string>(stored ? JSON.parse(stored) : []);
      const remoteItems = Array.isArray(response.data) ? response.data : [];
      setItems(remoteItems.map((item: Notification) => ({ ...item, isRead: item.isRead || readIds.has(item.id) })));
    }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const persistReadIds = async (ids: string[]) => {
    const unique = Array.from(new Set(ids)).slice(-200);
    await AsyncStorage.setItem(READ_NOTIFICATION_IDS_KEY, JSON.stringify(unique)).catch(() => {});
  };

  const markRead = async (id: string) => {
    setItems((prev) => {
      const next = prev.map((n) => n.id === id ? { ...n, isRead: true } : n);
      void persistReadIds(next.filter((n) => n.isRead).map((n) => n.id));
      return next;
    });
  };

  const markAllRead = async () => {
    setItems((prev) => {
      const next = prev.map((n) => ({ ...n, isRead: true }));
      void persistReadIds(next.map((n) => n.id));
      return next;
    });
  };

  const unreadCount = items.filter((n) => !n.isRead).length;

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>{t('notifications')}</Text>
          {unreadCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadCount}</Text>
            </View>
          )}
        </View>
        {unreadCount > 0 && (
          <Pressable onPress={markAllRead} style={styles.markAllBtn}>
            <Text style={styles.markAllText}>{t('notifications_read_all')}</Text>
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <View style={styles.emptyIcon}>
            <Ionicons name="notifications-off-outline" size={36} color={Colors.textMuted} />
          </View>
          <Text style={styles.emptyTitle}>{t('no_notifications')}</Text>
          <Text style={styles.emptyHint}>{t('notifications_empty_hint')}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}
          renderItem={({ item }) => <NotifRow item={item} onMarkRead={markRead} />}
          showsVerticalScrollIndicator={false}
        />
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: Colors.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 24, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  badge: { backgroundColor: Colors.disconnected, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  markAllBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard },
  markAllText: { fontSize: 12, color: Colors.primary, fontFamily: "Inter_500Medium" },
  list: { paddingHorizontal: 20, paddingTop: 16, gap: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  emptyHint: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  notifCard: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, padding: 14 },
  notifCardUnread: { borderColor: Colors.primary + "30", backgroundColor: Colors.primaryDim },
  unreadDot: { position: "absolute", top: 14, right: 14, width: 8, height: 8, borderRadius: 4 },
  notifIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 2 },
  notifTitle: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary, fontFamily: "Inter_600SemiBold" },
  notifTitleUnread: { color: "#FFF" },
  notifMsg: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular", lineHeight: 18 },
  notifTime: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
});

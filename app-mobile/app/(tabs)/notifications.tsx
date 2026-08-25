import React, { useMemo } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "@/services/apiClient";
import type { Notification } from "@/types/api";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

const READ_NOTIFICATION_IDS_KEY = "@sxb_read_notification_ids_v1";
const TYPE_ICONS: Record<string, string> = { warning: "warning", error: "alert-circle", success: "checkmark-circle", info: "information-circle" };

function NotifRow({ item, onMarkRead }: { item: Notification; onMarkRead: (id: string) => void }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t } = useTranslation();
  const color = item.type === "warning" ? colors.warning : item.type === "error" ? colors.disconnected : item.type === "success" ? colors.connected : colors.primary;
  const diff = Math.max(0, Date.now() - new Date(item.createdAt).getTime());
  const minutes = Math.floor(diff / 60000);
  const timeAgo = minutes < 60 ? `${minutes}${t("time_minutes_short")}` : minutes < 1440 ? `${Math.floor(minutes / 60)}${t("time_hours_short")}` : `${Math.floor(minutes / 1440)}${t("time_days_short")}`;

  return (
    <Pressable onPress={() => !item.isRead && onMarkRead(item.id)} style={({ pressed }) => [styles.notifCard, !item.isRead && { borderColor: color + "55", backgroundColor: color + "10" }, pressed && styles.pressed]} accessibilityRole="button">
      {!item.isRead && <View style={[styles.unreadDot, { backgroundColor: color }]} />}
      <View style={[styles.notifIcon, { backgroundColor: color + "18" }]}><Ionicons name={(TYPE_ICONS[item.type] || TYPE_ICONS.info) as any} size={20} color={color} /></View>
      <View style={styles.copy}><Text style={[styles.notifTitle, !item.isRead && { color: colors.textPrimary }]}>{item.title}</Text><Text style={styles.notifMsg} numberOfLines={3}>{item.message}</Text><Text style={styles.notifTime}>{timeAgo}</Text></View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [items, setItems] = React.useState<Notification[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([apiClient.get("/mobile/notifications"), AsyncStorage.getItem(READ_NOTIFICATION_IDS_KEY)])
      .then(([response, stored]) => {
        if (cancelled) return;
        const readIds = new Set<string>(stored ? JSON.parse(stored) : []);
        const remoteItems = Array.isArray(response.data) ? response.data : [];
        setItems(remoteItems.map((item: Notification & { read?: boolean }) => ({ ...item, isRead: item.isRead ?? item.read ?? readIds.has(item.id) })));
      }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const persistReadIds = async (ids: string[]) => AsyncStorage.setItem(READ_NOTIFICATION_IDS_KEY, JSON.stringify(Array.from(new Set(ids)).slice(-200))).catch(() => {});
  const markRead = (id: string) => setItems((prev) => { const next = prev.map((item) => item.id === id ? { ...item, isRead: true } : item); void persistReadIds(next.filter((item) => item.isRead).map((item) => item.id)); return next; });
  const markAllRead = () => setItems((prev) => { const next = prev.map((item) => ({ ...item, isRead: true })); void persistReadIds(next.map((item) => item.id)); return next; });
  const unreadCount = items.filter((item) => !item.isRead).length;

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}><View style={styles.headerLeft}><View><Text style={styles.eyebrow}>SXB VPN</Text><Text style={styles.title}>{t("notifications")}</Text></View>{unreadCount > 0 && <View style={[styles.badge, { backgroundColor: colors.primary }]}><Text style={styles.badgeText}>{unreadCount}</Text></View>}</View>{unreadCount > 0 && <Pressable onPress={markAllRead} style={({ pressed }) => [styles.markAllBtn, pressed && styles.pressed]}><Text style={styles.markAllText}>{t("notifications_read_all")}</Text></Pressable>}</View>
      {loading ? <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View> : items.length === 0 ? <View style={styles.center}><View style={styles.emptyIcon}><Ionicons name="notifications-off-outline" size={36} color={colors.textMuted} /></View><Text style={styles.emptyTitle}>{t("no_notifications")}</Text><Text style={styles.emptyHint}>{t("notifications_empty_hint")}</Text></View> : <FlatList data={items} keyExtractor={(item) => item.id} contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]} renderItem={({ item }) => <NotifRow item={item} onMarkRead={markRead} />} showsVerticalScrollIndicator={false} />}
    </LinearGradient>
  );
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({
    container: { flex: 1 }, header: { paddingHorizontal: 20, paddingBottom: 17, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }, headerLeft: { flexDirection: "row", alignItems: "flex-end", gap: 10 }, eyebrow: { color: colors.primary, fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.7, marginBottom: 4 }, title: { color: colors.textPrimary, fontSize: 26, fontFamily: "Inter_700Bold" }, badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginBottom: 3 }, badgeText: { color: "#fff", fontSize: 11, fontFamily: "Inter_700Bold" }, markAllBtn: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard }, markAllText: { color: colors.primary, fontSize: 11, fontFamily: "Inter_600SemiBold" }, list: { paddingHorizontal: 20, paddingTop: 16, gap: 9 }, notifCard: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: colors.bgCard, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 14 }, notifIcon: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" }, copy: { flex: 1, gap: 4 }, notifTitle: { color: colors.textSecondary, fontSize: 13, fontFamily: "Inter_600SemiBold" }, notifMsg: { color: colors.textMuted, fontSize: 12, lineHeight: 18, fontFamily: "Inter_400Regular" }, notifTime: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_400Regular" }, unreadDot: { position: "absolute", right: 13, top: 13, width: 7, height: 7, borderRadius: 4 }, pressed: { opacity: 0.7, transform: [{ scale: 0.99 }] }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 20 }, emptyIcon: { width: 76, height: 76, borderRadius: 26, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }, emptyTitle: { color: colors.textPrimary, fontSize: 16, fontFamily: "Inter_600SemiBold" }, emptyHint: { color: colors.textMuted, fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" },
  });
}

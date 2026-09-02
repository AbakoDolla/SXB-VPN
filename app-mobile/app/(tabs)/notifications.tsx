import React from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "@/services/apiClient";
import type { Notification } from "@/types/api";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";
import { downloadAndInstallAppUpdate } from "@/services/appUpdate";
import { alpha, layout, radius, spacing, type } from "@/constants/theme";
import { EmptyState } from "@/components/ui/Primitives";

const READ_NOTIFICATION_IDS_KEY = "@sxb_read_notification_ids_v1";
const TYPE_ICONS: Record<string, string> = {
  warning: "warning",
  error: "alert-circle",
  success: "checkmark-circle",
  info: "information-circle",
};

function NotifRow({ item, onMarkRead }: { item: Notification; onMarkRead: (id: string) => void }) {
  const colors = useColors();
  const { t } = useTranslation();
  const [downloading, setDownloading] = React.useState(false);

  const color = item.type === "warning"
    ? colors.warning
    : item.type === "error"
    ? colors.disconnected
    : item.type === "success"
    ? colors.connected
    : colors.primary;

  const diff = Math.max(0, Date.now() - new Date(item.createdAt).getTime());
  const minutes = Math.floor(diff / 60000);
  const timeAgo = minutes < 60
    ? `${minutes}${t("time_minutes_short")}`
    : minutes < 1440
    ? `${Math.floor(minutes / 60)}${t("time_hours_short")}`
    : `${Math.floor(minutes / 1440)}${t("time_days_short")}`;

  const handleDownload = async () => {
    onMarkRead(item.id);
    setDownloading(true);
    try {
      await downloadAndInstallAppUpdate({
        versionCode: item.versionCode || 0,
        versionName: item.versionName || '',
        apkUrl: item.downloadUrl!,
        // Le condensat publié doit suivre jusqu'ici : sans lui la vérification
        // d'intégrité est silencieusement ignorée et un APK altéré serait remis
        // à l'installeur système.
        apkSha256: item.downloadSha256,
        notes: item.notes,
        minSupportedCode: item.minSupportedCode,
        forceUpdate: item.forceUpdate,
      });
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      Alert.alert(
        code === 'integrity_mismatch' || code === 'integrity_unavailable'
          ? t('update_integrity_error')
          : t('update_download_error'),
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Pressable
      onPress={() => !item.isRead && onMarkRead(item.id)}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      style={({ pressed }) => [
        styles.notifCard,
        {
          backgroundColor: item.isRead ? colors.bgCard : color + alpha.f08,
          borderColor: item.isRead ? colors.border : color + alpha.f40,
        },
        pressed && styles.pressed,
      ]}
    >
      {/* Barre latérale colorée : signale une notification non lue de façon
          bien plus lisible qu'une pastille de 7 px dans un coin. */}
      {!item.isRead && <View style={[styles.unreadBar, { backgroundColor: color }]} />}

      <View style={[styles.notifIcon, { backgroundColor: color + alpha.f16 }]}>
        <Ionicons name={(TYPE_ICONS[item.type] || TYPE_ICONS.info) as any} size={19} color={color} />
      </View>

      <View style={styles.copy}>
        <Text
          style={[
            item.isRead ? type.bodyMedium : type.h3,
            { color: item.isRead ? colors.textSecondary : colors.textPrimary },
          ]}
        >
          {item.title}
        </Text>
        <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={3}>
          {item.message}
        </Text>
        <Text style={[type.micro, { color: colors.textMuted }]}>{timeAgo}</Text>

        {item.appUpdate && item.downloadUrl && (
          <Pressable
            disabled={downloading}
            onPress={handleDownload}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.updateButton,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              downloading && styles.disabled,
            ]}
          >
            <Ionicons name="download-outline" size={15} color={colors.primaryForeground} />
            <Text style={[type.captionMedium, { color: colors.primaryForeground }]}>
              {downloading ? t('update_downloading') : t('update_download')}
            </Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const colors = useColors();
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
        setItems(remoteItems.map((item: Notification & { read?: boolean }) => ({
          ...item,
          isRead: item.isRead ?? item.read ?? readIds.has(item.id),
        })));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const persistReadIds = async (ids: string[]) =>
    AsyncStorage.setItem(READ_NOTIFICATION_IDS_KEY, JSON.stringify(Array.from(new Set(ids)).slice(-200))).catch(() => {});

  const markRead = (id: string) => setItems((prev) => {
    const next = prev.map((item) => item.id === id ? { ...item, isRead: true } : item);
    void persistReadIds(next.filter((item) => item.isRead).map((item) => item.id));
    return next;
  });

  const markAllRead = () => setItems((prev) => {
    const next = prev.map((item) => ({ ...item, isRead: true }));
    void persistReadIds(next.map((item) => item.id));
    return next;
  });

  const unreadCount = items.filter((item) => !item.isRead).length;

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.lg, borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[type.overline, { color: colors.primary }]}>SXB VPN</Text>
          <View style={styles.titleRow}>
            <Text style={[type.h1, { color: colors.textPrimary }]}>{t("notifications")}</Text>
            {unreadCount > 0 && (
              <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                <Text style={[type.micro, { color: colors.primaryForeground }]}>{unreadCount}</Text>
              </View>
            )}
          </View>
        </View>

        {unreadCount > 0 && (
          <Pressable
            onPress={markAllRead}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.markAllBtn,
              { borderColor: colors.border, backgroundColor: colors.bgCard },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[type.captionMedium, { color: colors.primary }]}>{t("notifications_read_all")}</Text>
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <EmptyState
            icon="notifications-off-outline"
            title={t("no_notifications")}
            description={t("notifications_empty_hint")}
          />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + layout.tabBarClearance }]}
          renderItem={({ item }) => <NotifRow item={item} onMarkRead={markRead} />}
          showsVerticalScrollIndicator={false}
        />
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.md,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  markAllBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },

  list: { paddingHorizontal: layout.screenPadding, paddingTop: spacing.lg, gap: spacing.md },
  notifCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: layout.cardPadding,
    overflow: "hidden",
  },
  unreadBar: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 },
  notifIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: spacing.xs },
  updateButton: {
    alignSelf: "flex-start",
    marginTop: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.99 }] },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: layout.screenPadding },
});

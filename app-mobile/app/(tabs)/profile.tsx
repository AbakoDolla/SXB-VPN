import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useAuthContext } from "@/contexts/AuthContext";
import { useVpnContext } from "@/contexts/VpnContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";
import { alpha, layout, radius, spacing, type } from "@/constants/theme";
import { IconButton, Pill, ProgressBar, SectionHeader, StatRow, StatTile, Surface } from "@/components/ui/Primitives";

export default function ProfileScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, accountState, logout } = useAuthContext();
  const { activeConnection, derivedQuota } = useVpnContext();
  const effectiveExpiry = derivedQuota.expiryDate || activeConnection?.expiresAt || accountState?.expireAt || null;

  const initials = (user?.name || "?").split(" ").map((word: string) => word[0]).join("").toUpperCase().slice(0, 2);
  const state = accountState?.state;
  const accountActive = state === "ready" || activeConnection?.status === "active";
  const stateKey = state === "suspended" ? "suspended" : state === "expired" ? "expired" : state === "exhausted" ? "exhausted" : accountActive ? "ready" : "no_package";
  const stateColor = stateKey === "ready" ? colors.connected : stateKey === "no_package" ? colors.warning : colors.disconnected;
  const stateLabel = stateKey === "ready" ? t("active") : stateKey === "no_package" ? t("status_no_package") : stateKey === "exhausted" ? t("friendly_quota_exhausted") : stateKey === "expired" ? t("expired") : t("suspended_status");

  const handleLogout = () => Alert.alert(t("logout"), t("logout_confirm_local"), [
    { text: t("cancel"), style: "cancel" },
    { text: t("logout"), style: "destructive", onPress: () => logout().then(() => router.replace("/activate")) },
  ]);

  const menu = [
    { icon: "person-outline", label: t("section_personal_info"), action: () => router.push("/settings") },
    { icon: "phone-portrait-outline", label: t("section_authorized_devices"), value: `${accountState?.deviceLimit ?? 1} ${accountState?.deviceLimit && accountState.deviceLimit > 1 ? t("devices") : t("device")}` },
    { icon: "shield-checkmark-outline", label: t("section_security_conn"), action: () => router.push("/settings") },
    { icon: "notifications-outline", label: t("notifications"), action: () => router.push("/(tabs)/notifications") },
  ];

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + layout.tabBarClearance },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[type.overline, { color: colors.primary }]}>SXB VPN</Text>
            <Text style={[type.h1, { color: colors.textPrimary }]}>{t("profile")}</Text>
          </View>
          <IconButton icon="settings-outline" onPress={() => router.push("/settings")} accessibilityLabel={t("settings")} />
        </View>

        {/* Identité. L'avatar est le seul élément fortement teinté de l'écran :
            il fixe le regard avant que celui-ci ne descende vers les données. */}
        <Surface variant="raised">
          <Pressable
            onPress={() => router.push("/settings")}
            accessibilityRole="button"
            accessibilityLabel={t("section_personal_info")}
            style={({ pressed }) => [styles.identityRow, pressed && styles.pressed]}
          >
            <View style={[styles.avatar, { backgroundColor: colors.primaryDim, borderColor: colors.primary + alpha.f40 }]}>
              <Text style={[type.h1, { color: colors.primary }]}>{initials}</Text>
            </View>
            <View style={styles.identityCopy}>
              <Text style={[type.h2, { color: colors.textPrimary }]} numberOfLines={1}>
                {user?.name || t("user_default")}
              </Text>
              {!!user?.email && (
                <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>{user.email}</Text>
              )}
              <Pill label={stateLabel} tone={stateColor} dot style={{ alignSelf: "flex-start", marginTop: spacing.xs }} />
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </Pressable>
        </Surface>

        {/* Forfait : une barre de progression rend la part consommée lisible
            instantanément, là où trois nombres imposaient un calcul mental. */}
        <Surface>
          <SectionHeader title={t("current_plan")} icon="shield-checkmark-outline" />
          <StatRow>
            <StatTile label={t("quota_total")} value={derivedQuota.formattedTotal} monospace />
            <StatTile label={t("quota_used")} value={derivedQuota.formattedUsed} monospace />
            <StatTile label={t("quota_remaining")} value={derivedQuota.formattedRemaining} tone={colors.connected} monospace />
          </StatRow>
          {derivedQuota.totalBytes > 0 && (
            <ProgressBar progress={derivedQuota.usedRatio} tone={colors.primary} warnTone={colors.disconnected} />
          )}
          {effectiveExpiry && (
            <View style={styles.expiryRow}>
              <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
              <Text style={[type.caption, { color: colors.textMuted }]}>
                {t("expires_on")} {new Date(effectiveExpiry).toLocaleDateString("fr-FR", { dateStyle: "medium" })}
              </Text>
            </View>
          )}
        </Surface>

        <Surface padded={false} style={{ paddingVertical: spacing.xs }}>
          {menu.map((item, index) => (
            <Pressable
              key={item.label}
              onPress={item.action}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              style={({ pressed }) => [
                styles.menuItem,
                index < menu.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.menuIcon, { backgroundColor: colors.primaryDim }]}>
                <Ionicons name={item.icon as any} size={17} color={colors.primary} />
              </View>
              <Text style={[type.bodyMedium, { color: colors.textPrimary, flex: 1 }]}>{item.label}</Text>
              {item.value && <Text style={[type.caption, { color: colors.textMuted }]}>{item.value}</Text>}
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          ))}
        </Surface>

        <Pressable
          onPress={() => router.push("/plan")}
          accessibilityRole="button"
          accessibilityLabel={t("activate_plan")}
          style={({ pressed }) => [
            styles.planButton,
            { backgroundColor: colors.purpleDim, borderColor: colors.purple + alpha.f40 },
            pressed && styles.pressed,
          ]}
        >
          <Ionicons name="sparkles-outline" size={19} color={colors.purple} />
          <Text style={[type.h3, { color: colors.purple, flex: 1 }]}>{t("activate_plan")}</Text>
          <Ionicons name="arrow-forward" size={17} color={colors.purple} />
        </Pressable>

        <Pressable
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel={t("logout")}
          style={({ pressed }) => [
            styles.logoutButton,
            { backgroundColor: colors.disconnectedDim, borderColor: colors.disconnected + alpha.f40 },
            pressed && styles.pressed,
          ]}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.disconnected} />
          <Text style={[type.h3, { color: colors.disconnected }]}>{t("logout")}</Text>
        </Pressable>

        <View style={styles.appInfo}>
          <Text style={[type.caption, { color: colors.textMuted }]}>
            SXB VPN v{Constants.expoConfig?.version ?? "1.0.0"}
          </Text>
          <Text style={[type.micro, { color: colors.textMuted, letterSpacing: 2.4 }]}>STUFF X BILAL</Text>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: layout.screenPadding, gap: spacing.lg },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },

  identityRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  avatar: {
    width: 62,
    height: 62,
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  identityCopy: { flex: 1, gap: 2 },

  expiryRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },

  menuItem: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: layout.cardPadding,
  },
  menuIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },

  planButton: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: layout.cardPadding,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  logoutButton: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  appInfo: { alignItems: "center", gap: spacing.xs, paddingVertical: spacing.sm },
});

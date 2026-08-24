import React, { useMemo } from "react";
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

export default function ProfileScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 100 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <View><Text style={styles.eyebrow}>SXB VPN</Text><Text style={styles.pageTitle}>{t("profile")}</Text></View>
          <Pressable onPress={() => router.push("/settings")} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]} accessibilityLabel={t("settings")}><Ionicons name="settings-outline" size={20} color={colors.textSecondary} /></Pressable>
        </View>

        <View style={styles.identityCard}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
          <View style={styles.identityCopy}><Text style={styles.userName}>{user?.name || t("user_default")}</Text><Text style={styles.userEmail}>{user?.email || ""}</Text><View style={[styles.statusPill, { backgroundColor: stateColor + "18", borderColor: stateColor + "45" }]}><View style={[styles.statusDot, { backgroundColor: stateColor }]} /><Text style={[styles.statusText, { color: stateColor }]}>{stateLabel}</Text></View></View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </View>

        <View style={styles.quotaCard}>
          <View style={styles.cardHeader}><Text style={styles.sectionLabel}>{t("current_plan").toUpperCase()}</Text><Ionicons name="shield-checkmark-outline" size={18} color={colors.primary} /></View>
          <View style={styles.statsRow}>
            <Metric label={t("quota_total")} value={derivedQuota.formattedTotal} styles={styles} />
            <View style={styles.statDivider} />
            <Metric label={t("quota_used")} value={derivedQuota.formattedUsed} styles={styles} />
            <View style={styles.statDivider} />
            <Metric label={t("quota_remaining")} value={derivedQuota.formattedRemaining} styles={styles} accent />
          </View>
          {effectiveExpiry && <View style={styles.expiryRow}><Ionicons name="calendar-outline" size={14} color={colors.textMuted} /><Text style={styles.expiryText}>{t("expires_on")} {new Date(effectiveExpiry).toLocaleDateString()}</Text></View>}
        </View>

        <View style={styles.menuCard}>
          <Text style={styles.sectionLabel}>{t("section_personal_info").toUpperCase()}</Text>
          {menu.map((item, index) => <Pressable key={item.label} onPress={item.action} style={({ pressed }) => [styles.menuItem, index < menu.length - 1 && styles.menuBorder, pressed && styles.pressed]}><View style={styles.menuLeft}><View style={styles.menuIcon}><Ionicons name={item.icon as any} size={18} color={colors.primary} /></View><Text style={styles.menuLabel}>{item.label}</Text></View><View style={styles.menuRight}>{item.value && <Text style={styles.menuValue}>{item.value}</Text>}<Ionicons name="chevron-forward" size={16} color={colors.textMuted} /></View></Pressable>)}
        </View>

        <Pressable onPress={() => router.push("/plan")} style={({ pressed }) => [styles.planButton, pressed && styles.pressed]}><Ionicons name="sparkles-outline" size={19} color={colors.purple} /><Text style={styles.planButtonText}>{t("activate_plan")}</Text><Ionicons name="arrow-forward" size={17} color={colors.purple} /></Pressable>

        <View style={styles.appInfo}><Text style={styles.appVersion}>SXB VPN v{Constants.expoConfig?.version ?? "1.0.0"}</Text><Text style={styles.appTagline}>STUFF X BILAL</Text></View>
        <Pressable onPress={handleLogout} style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}><Ionicons name="log-out-outline" size={18} color={colors.disconnected} /><Text style={styles.logoutText}>{t("logout")}</Text></Pressable>
      </ScrollView>
    </LinearGradient>
  );
}

function Metric({ label, value, styles, accent }: { label: string; value: string; styles: ReturnType<typeof makeStyles>; accent?: boolean }) {
  return <View style={styles.metric}><Text style={[styles.metricValue, accent && styles.metricAccent]}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>;
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({
    container: { flex: 1 }, content: { paddingHorizontal: 20, gap: 14 }, headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, eyebrow: { color: colors.primary, fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.7 }, pageTitle: { color: colors.textPrimary, fontSize: 27, fontFamily: "Inter_700Bold", marginTop: 3 }, iconButton: { width: 42, height: 42, borderRadius: 15, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }, pressed: { opacity: 0.68, transform: [{ scale: 0.98 }] }, identityCard: { flexDirection: "row", alignItems: "center", gap: 13, padding: 17, borderRadius: 22, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }, avatar: { width: 62, height: 62, borderRadius: 22, backgroundColor: colors.primaryDim, borderWidth: 1, borderColor: colors.primary + "55", alignItems: "center", justifyContent: "center" }, avatarText: { color: colors.primary, fontSize: 23, fontFamily: "Inter_700Bold" }, identityCopy: { flex: 1, gap: 3 }, userName: { color: colors.textPrimary, fontSize: 17, fontFamily: "Inter_700Bold" }, userEmail: { color: colors.textMuted, fontSize: 12, fontFamily: "Inter_400Regular" }, statusPill: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4, marginTop: 3 }, statusDot: { width: 6, height: 6, borderRadius: 3 }, statusText: { fontSize: 10, fontFamily: "Inter_600SemiBold" }, quotaCard: { padding: 17, borderRadius: 22, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, gap: 16 }, cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, sectionLabel: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.4 }, statsRow: { flexDirection: "row", justifyContent: "space-around", alignItems: "center" }, metric: { alignItems: "center", gap: 4, flex: 1 }, metricValue: { color: colors.textPrimary, fontSize: 17, fontFamily: "Inter_700Bold" }, metricAccent: { color: colors.connected }, metricLabel: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_400Regular" }, statDivider: { width: 1, height: 34, backgroundColor: colors.border }, expiryRow: { flexDirection: "row", alignItems: "center", gap: 6 }, expiryText: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular" }, menuCard: { padding: 16, borderRadius: 22, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }, menuItem: { minHeight: 62, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, menuBorder: { borderBottomWidth: 1, borderBottomColor: colors.border }, menuLeft: { flexDirection: "row", alignItems: "center", gap: 11, flex: 1 }, menuIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" }, menuLabel: { color: colors.textPrimary, fontSize: 13, fontFamily: "Inter_500Medium" }, menuRight: { flexDirection: "row", alignItems: "center", gap: 5 }, menuValue: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular" }, planButton: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 16, borderRadius: 18, backgroundColor: colors.purpleDim, borderWidth: 1, borderColor: colors.purple + "48" }, planButtonText: { flex: 1, color: colors.purple, fontSize: 14, fontFamily: "Inter_600SemiBold" }, appInfo: { alignItems: "center", gap: 4, paddingVertical: 7 }, appVersion: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular" }, appTagline: { color: colors.textMuted, fontSize: 9, fontFamily: "Inter_600SemiBold", letterSpacing: 2.4 }, logoutButton: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 15, backgroundColor: colors.disconnectedDim, borderWidth: 1, borderColor: colors.disconnected + "40" }, logoutText: { color: colors.disconnected, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  });
}

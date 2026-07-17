import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useAuthContext } from "@/contexts/AuthContext";
import Colors from "@/constants/colors";

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { user, accountState, logout } = useAuthContext();

  const handleLogout = () => {
    Alert.alert(
      "Se déconnecter",
      "Votre session locale sera effacée. Votre compte reste actif.",
      [
        { text: "Annuler", style: "cancel" },
        { text: "Se déconnecter", style: "destructive", onPress: () => logout().then(() => router.replace("/activate")) },
      ]
    );
  };

  const initials = (user?.name || "?")
    .split(" ")
    .map((w: string) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const stateColor = {
    ready: Colors.connected,
    no_package: Colors.warning,
    expired: Colors.disconnected,
    suspended: Colors.disconnected,
  }[accountState?.state || "no_package"] ?? Colors.textMuted;

  const stateLabel = {
    ready: "Compte actif",
    no_package: "Sans forfait",
    expired: "Expiré",
    suspended: "Suspendu",
  }[accountState?.state || "no_package"] ?? "—";

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <Text style={styles.pageTitle}>Profil</Text>
          <Pressable onPress={() => router.push("/settings")} style={styles.iconBtn}>
            <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
          </Pressable>
        </View>

        {/* Avatar Card */}
        <View style={styles.avatarCard}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarInitials}>{initials}</Text>
          </View>
          <View style={styles.avatarInfo}>
            <Text style={styles.userName}>{user?.name || "Utilisateur"}</Text>
            <Text style={styles.userEmail}>{user?.email || ""}</Text>
            <View style={[styles.stateBadge, { borderColor: stateColor + "40", backgroundColor: stateColor + "15" }]}>
              <View style={[styles.stateDot, { backgroundColor: stateColor }]} />
              <Text style={[styles.stateText, { color: stateColor }]}>{stateLabel}</Text>
            </View>
          </View>
        </View>

        {/* Stats Card */}
        {accountState && (
          <View style={styles.statsCard}>
            <Text style={styles.sectionLabel}>FORFAIT ACTUEL</Text>
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statValue}>
                  {Math.round(accountState.quotaRemainingGb ?? 0)} GB
                </Text>
                <Text style={styles.statLabel}>Restant</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>
                  {Math.round(accountState.quotaTotalGb ?? 0)} GB
                </Text>
                <Text style={styles.statLabel}>Total</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{accountState.deviceLimit ?? 1}</Text>
                <Text style={styles.statLabel}>Appareils</Text>
              </View>
            </View>
            {accountState.expireAt && (
              <View style={styles.expireRow}>
                <Ionicons name="calendar-outline" size={13} color={Colors.textMuted} />
                <Text style={styles.expireText}>
                  Expire le {new Date(accountState.expireAt).toLocaleDateString("fr-FR")}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Menu items */}
        <View style={styles.menuCard}>
          <Text style={styles.sectionLabel}>INFORMATIONS</Text>
          {[
            { icon: "person-outline", label: "Informations personnelles", action: () => router.push("/settings") },
            { icon: "phone-portrait-outline", label: "Appareils autorisés", value: `${accountState?.deviceLimit ?? 1} appareils` },
            { icon: "shield-outline", label: "Sécurité & Connexion", action: () => router.push("/settings") },
            { icon: "notifications-outline", label: "Notifications", action: () => router.push("/(tabs)/notifications") },
          ].map((item, i) => (
            <Pressable
              key={i}
              onPress={item.action}
              style={[styles.menuItem, i < 3 && styles.menuItemBorder]}
            >
              <View style={styles.menuItemLeft}>
                <View style={styles.menuItemIcon}>
                  <Ionicons name={item.icon as any} size={18} color={Colors.primary} />
                </View>
                <Text style={styles.menuItemLabel}>{item.label}</Text>
              </View>
              <View style={styles.menuItemRight}>
                {item.value && <Text style={styles.menuItemValue}>{item.value}</Text>}
                <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
              </View>
            </Pressable>
          ))}
        </View>

        {/* Activate plan */}
        <Pressable onPress={() => router.push("/plan")} style={styles.planBtn}>
          <Ionicons name="gift-outline" size={18} color={Colors.purple} />
          <Text style={styles.planBtnText}>Activer un forfait</Text>
          <Ionicons name="arrow-forward" size={16} color={Colors.purple} />
        </Pressable>

        {/* App info */}
        <View style={styles.appInfo}>
          <Text style={styles.appVersion}>SXB VPN v{Constants.expoConfig?.version ?? "1.0.0"}</Text>
          <Text style={styles.appTagline}>STUFF X BILAL</Text>
        </View>

        {/* Logout */}
        <Pressable onPress={handleLogout} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={18} color={Colors.disconnected} />
          <Text style={styles.logoutText}>Se déconnecter</Text>
        </Pressable>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 14 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
  pageTitle: { fontSize: 24, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  avatarCard: { flexDirection: "row", alignItems: "center", gap: 16, backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 20 },
  avatarCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.primaryDim, borderWidth: 2, borderColor: Colors.primary + "50", alignItems: "center", justifyContent: "center" },
  avatarInitials: { fontSize: 26, fontWeight: "700", color: Colors.primary, fontFamily: "Inter_700Bold" },
  avatarInfo: { flex: 1, gap: 4 },
  userName: { fontSize: 18, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  userEmail: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  stateBadge: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, borderWidth: 1, marginTop: 4 },
  stateDot: { width: 6, height: 6, borderRadius: 3 },
  stateText: { fontSize: 11, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  statsCard: { backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 14 },
  sectionLabel: { fontSize: 10, fontWeight: "700", color: Colors.textMuted, letterSpacing: 1.5, fontFamily: "Inter_700Bold" },
  statsRow: { flexDirection: "row", justifyContent: "space-around" },
  statItem: { alignItems: "center", gap: 4 },
  statDivider: { width: 1, backgroundColor: Colors.border },
  statValue: { fontSize: 22, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  statLabel: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  expireRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  expireText: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  menuCard: { backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 0 },
  menuItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14 },
  menuItemBorder: { borderBottomWidth: 1, borderBottomColor: Colors.border },
  menuItemLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  menuItemIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: Colors.primaryDim, alignItems: "center", justifyContent: "center" },
  menuItemLabel: { fontSize: 14, color: "#FFF", fontFamily: "Inter_500Medium" },
  menuItemRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  menuItemValue: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  planBtn: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.purpleDim, borderRadius: 16, borderWidth: 1, borderColor: Colors.purple + "40", padding: 16 },
  planBtnText: { flex: 1, fontSize: 15, fontWeight: "600", color: Colors.purple, fontFamily: "Inter_600SemiBold" },
  appInfo: { alignItems: "center", gap: 4, paddingVertical: 8 },
  appVersion: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  appTagline: { fontSize: 10, color: Colors.textMuted, letterSpacing: 3, fontFamily: "Inter_600SemiBold" },
  logoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: Colors.disconnected + "40", backgroundColor: Colors.disconnectedDim },
  logoutText: { fontSize: 15, fontWeight: "600", color: Colors.disconnected, fontFamily: "Inter_600SemiBold" },
});

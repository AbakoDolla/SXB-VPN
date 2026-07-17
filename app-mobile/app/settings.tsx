import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import { useAuthContext } from "@/contexts/AuthContext";
import Colors from "@/constants/colors";

interface SettingRowProps {
  icon: string;
  label: string;
  value?: string;
  toggle?: boolean;
  toggleValue?: boolean;
  onToggle?: (v: boolean) => void;
  onPress?: () => void;
  color?: string;
  destructive?: boolean;
}

function SettingRow({ icon, label, value, toggle, toggleValue, onToggle, onPress, color, destructive }: SettingRowProps) {
  const c = destructive ? Colors.disconnected : (color || Colors.primary);
  return (
    <Pressable onPress={onPress} style={styles.row} disabled={toggle && !onPress}>
      <View style={[styles.rowIcon, { backgroundColor: c + "15" }]}>
        <Ionicons name={icon as any} size={18} color={c} />
      </View>
      <Text style={[styles.rowLabel, destructive && { color: Colors.disconnected }]}>{label}</Text>
      {toggle ? (
        <Switch
          value={toggleValue}
          onValueChange={onToggle}
          trackColor={{ false: Colors.border, true: c + "60" }}
          thumbColor={toggleValue ? c : Colors.textMuted}
        />
      ) : value ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
      ) : null}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuthContext();

  const [darkMode, setDarkMode]     = useState(true);
  const [notifPush, setNotifPush]   = useState(true);
  const [biometric, setBiometric]   = useState(false);
  const [pinLock, setPinLock]       = useState(false);

  const handleLogout = () => {
    Alert.alert("Se déconnecter", "Votre session locale sera effacée.", [
      { text: "Annuler", style: "cancel" },
      { text: "Se déconnecter", style: "destructive", onPress: () => logout().then(() => router.replace("/activate")) },
    ]);
  };

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: 16, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Account info */}
        <View style={styles.accountCard}>
          <View style={styles.accountAvatar}>
            <Text style={styles.accountInitials}>
              {(user?.name || "?").split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2)}
            </Text>
          </View>
          <View>
            <Text style={styles.accountName}>{user?.name || "Utilisateur"}</Text>
            <Text style={styles.accountEmail}>{user?.email || ""}</Text>
          </View>
        </View>

        {/* Theme */}
        <Section title="APPARENCE">
          <SettingRow icon="moon-outline" label="Thème sombre" toggle toggleValue={darkMode} onToggle={setDarkMode} />
          <View style={styles.divider} />
          <SettingRow icon="globe-outline" label="Langue" value="Français 🇫🇷" onPress={() => {}} />
        </Section>

        {/* Security */}
        <Section title="SÉCURITÉ">
          <SettingRow icon="lock-closed-outline" label="Verrouillage par code" toggle toggleValue={pinLock} onToggle={setPinLock} color={Colors.warning} />
          <View style={styles.divider} />
          <SettingRow icon="finger-print-outline" label="Authentification biométrique" toggle toggleValue={biometric} onToggle={setBiometric} color={Colors.warning} />
        </Section>

        {/* Notifications */}
        <Section title="NOTIFICATIONS">
          <SettingRow icon="notifications-outline" label="Notifications push" toggle toggleValue={notifPush} onToggle={setNotifPush} />
          <View style={styles.divider} />
          <SettingRow icon="mail-outline" label="Alertes email" toggle toggleValue={false} onToggle={() => {}} />
        </Section>

        {/* About */}
        <Section title="À PROPOS">
          <SettingRow icon="information-circle-outline" label="Version" value={`v${Constants.expoConfig?.version ?? "1.0.0"}`} />
          <View style={styles.divider} />
          <SettingRow icon="document-text-outline" label="Conditions d'utilisation" onPress={() => {}} />
          <View style={styles.divider} />
          <SettingRow icon="shield-checkmark-outline" label="Politique de confidentialité" onPress={() => {}} />
        </Section>

        {/* Logout */}
        <Pressable onPress={handleLogout} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={18} color={Colors.disconnected} />
          <Text style={styles.logoutText}>Se déconnecter</Text>
        </Pressable>

        <Text style={styles.footer}>SXB VPN — STUFF X BILAL</Text>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 20 },
  accountCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 16 },
  accountAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.primaryDim, borderWidth: 1.5, borderColor: Colors.primary + "50", alignItems: "center", justifyContent: "center" },
  accountInitials: { fontSize: 20, fontWeight: "700", color: Colors.primary, fontFamily: "Inter_700Bold" },
  accountName: { fontSize: 16, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  accountEmail: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular", marginTop: 2 },
  section: { gap: 8 },
  sectionLabel: { fontSize: 10, fontWeight: "700", color: Colors.textMuted, letterSpacing: 1.5, fontFamily: "Inter_700Bold", paddingLeft: 4 },
  sectionCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, fontSize: 14, color: "#FFF", fontFamily: "Inter_500Medium" },
  rowValue: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  divider: { height: 1, backgroundColor: Colors.border },
  logoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: Colors.disconnected + "40", backgroundColor: Colors.disconnectedDim },
  logoutText: { fontSize: 15, fontWeight: "600", color: Colors.disconnected, fontFamily: "Inter_600SemiBold" },
  footer: { textAlign: "center", fontSize: 10, color: Colors.textMuted, fontFamily: "Inter_400Regular", letterSpacing: 2 },
});

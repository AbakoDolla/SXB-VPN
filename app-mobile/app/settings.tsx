/**
 * SettingsScreen — SXB VPN Mobile
 * Paramètres enrichis : compte, sécurité fonctionnelle, langue, VPN, données
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  Alert, Pressable, ScrollView, StyleSheet,
  Switch, Text, View, ActivityIndicator, TextInput, Modal,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuthContext } from "@/contexts/AuthContext";
import { useVpnContext } from "@/contexts/VpnContext";
import { useLanguageContext } from "@/contexts/LanguageContext";
import Colors from "@/constants/colors";

// ── Row component ─────────────────────────────────────────────────────────────

interface RowProps {
  icon: string;
  label: string;
  value?: string;
  toggle?: boolean;
  toggleValue?: boolean;
  onToggle?: (v: boolean) => void;
  onPress?: () => void;
  color?: string;
  destructive?: boolean;
  badge?: string;
  badgeColor?: string;
  disabled?: boolean;
}

function Row({
  icon, label, value, toggle, toggleValue,
  onToggle, onPress, color, destructive, badge, badgeColor, disabled,
}: RowProps) {
  const c = destructive ? Colors.disconnected : (color || Colors.primary);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || (toggle && !onPress)}
      style={({ pressed }) => [styles.row, pressed && !disabled && { opacity: 0.7 }]}
    >
      <View style={[styles.rowIcon, { backgroundColor: c + "15" }]}>
        <Ionicons name={icon as any} size={18} color={c} />
      </View>
      <Text style={[styles.rowLabel, destructive && { color: Colors.disconnected }, disabled && { color: Colors.textMuted }]}>
        {label}
      </Text>
      {toggle ? (
        <Switch
          value={toggleValue}
          onValueChange={onToggle}
          trackColor={{ false: Colors.border, true: c + "40" }}
          thumbColor={toggleValue ? c : Colors.textMuted}
          style={styles.rowSwitch}
        />
      ) : value ? (
        <Text style={styles.rowValue}>{value}</Text>
      ) : badge ? (
        <View style={[styles.rowBadge, { backgroundColor: (badgeColor || c) + "20" }]}>
          <Text style={[styles.rowBadgeText, { color: badgeColor || c }]}>{badge}</Text>
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
      )}
    </Pressable>
  );
}

// ── Section component ────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{title}</Text>
        {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
      </View>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

// ── Language selector modal ───────────────────────────────────────────────────

const LANGS = [
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "en", label: "English",  flag: "🇬🇧" },
];

function LangModal({ visible, current, onSelect, onClose }: {
  visible: boolean; current: string;
  onSelect: (code: string) => void; onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.langSheet}>
          <Text style={styles.langSheetTitle}>Langue / Language</Text>
          {LANGS.map(l => (
            <Pressable
              key={l.code}
              onPress={() => { onSelect(l.code); onClose(); }}
              style={[styles.langRow, current === l.code && styles.langRowActive]}
            >
              <Text style={styles.langFlag}>{l.flag}</Text>
              <Text style={[styles.langLabel, current === l.code && { color: Colors.primary }]}>{l.label}</Text>
              {current === l.code && <Ionicons name="checkmark" size={18} color={Colors.primary} />}
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

// ── V2Ray JSON Editor Modal ──────────────────────────────────────────────────

function V2rayJsonModal({ visible, onSave, onClose }: {
  visible: boolean; onSave: (config: any) => Promise<void>; onClose: () => void;
}) {
  const [jsonText, setJsonText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    setError("");
    try {
      const parsed = JSON.parse(jsonText);
      setSaving(true);
      await onSave(parsed);
      setSaving(false);
      onClose();
    } catch (e: any) {
      setError(e.message || "JSON invalide");
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.v2raySheet}>
          <Text style={styles.v2rayTitle}>Importer une configuration JSON</Text>
          <Text style={styles.v2rayHint}>Collez votre configuration V2Ray / VLESS / VMess / Trojan ici :</Text>
          <TextInput
            style={styles.v2rayInput}
            value={jsonText}
            onChangeText={setJsonText}
            placeholder={`{\n  "protocol": "vless",\n  "address": "mon-serveur.com",\n  "port": 443,\n  "id": "votre-uuid-ici",\n  "tls": true\n}`}
            placeholderTextColor={Colors.textMuted}
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {error ? <Text style={styles.v2rayError}>{error}</Text> : null}
          <View style={styles.v2rayButtons}>
            <Pressable onPress={onClose} style={styles.v2rayCancelBtn}>
              <Text style={styles.v2rayCancelText}>Annuler</Text>
            </Pressable>
            <Pressable onPress={handleSave} disabled={saving || !jsonText.trim()} style={styles.v2raySaveBtn}>
              {saving ? <ActivityIndicator color="#FFF" /> : <Text style={styles.v2raySaveText}>Importer</Text>}
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

// ── PIN Modal ─────────────────────────────────────────────────────────────────

function PinModal({ visible, mode, onSet, onClose }: {
  visible: boolean; mode: "set" | "verify"; onSet: (pin: string) => void; onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  const handleSet = () => {
    if (pin.length < 4) { setError("Le code doit contenir au moins 4 chiffres"); return; }
    if (mode === "set" && pin !== confirm) { setError("Les codes ne correspondent pas"); return; }
    onSet(pin);
    setPin(""); setConfirm(""); setError("");
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.pinSheet}>
          <Text style={styles.pinTitle}>{mode === "set" ? "Définir un code PIN" : "Entrer votre code PIN"}</Text>
          <TextInput
            style={styles.pinInput}
            value={pin}
            onChangeText={(t) => { setPin(t.replace(/\D/g, "")); setError(""); }}
            placeholder="••••" placeholderTextColor={Colors.textMuted}
            keyboardType="number-pad" secureTextEntry maxLength={8}
          />
          {mode === "set" && (
            <TextInput
              style={styles.pinInput}
              value={confirm}
              onChangeText={(t) => { setConfirm(t.replace(/\D/g, "")); setError(""); }}
              placeholder="Confirmer ••••" placeholderTextColor={Colors.textMuted}
              keyboardType="number-pad" secureTextEntry maxLength={8}
            />
          )}
          {error ? <Text style={styles.pinError}>{error}</Text> : null}
          <View style={styles.pinButtons}>
            <Pressable onPress={onClose} style={styles.pinCancelBtn}>
              <Text style={styles.pinCancelText}>Annuler</Text>
            </Pressable>
            <Pressable onPress={handleSet} style={styles.pinSaveBtn}>
              <Text style={styles.pinSaveText}>Confirmer</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

// ── Logs Modal ────────────────────────────────────────────────────────────────

function LogsModal({ visible, logs, onClose }: {
  visible: boolean; logs: string[]; onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.logsSheet}>
          <Text style={styles.logsTitle}>Logs VPN ({logs.length})</Text>
          <ScrollView style={styles.logsScroll} contentContainerStyle={styles.logsContent}>
            {logs.length === 0 ? (
              <Text style={styles.logsEmpty}>Aucun log pour le moment</Text>
            ) : (
              logs.map((log, i) => (
                <Text key={i} style={styles.logLine}>{log}</Text>
              ))
            )}
          </ScrollView>
          <Pressable onPress={onClose} style={styles.logsCloseBtn}>
            <Text style={styles.logsCloseText}>Fermer</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, accountState, logout } = useAuthContext();
  const {
    logs, isConnected, selectedProtocol, availableProtocols, refreshVpnConfig,
    killSwitch: ksCtx, autoReconnect: arCtx,
    setKillSwitch: setKsCtx, setAutoReconnect: setArCtx,
    traffic,
    manuallySetConfig,
  } = useVpnContext();
  const { language, setLanguage } = useLanguageContext();

  // State
  const [notifPush,   setNotifPush]   = useState(true);

  // Persist notification preference
  const handleNotifToggle = async (v: boolean) => {
    setNotifPush(v);
    await AsyncStorage.setItem('@sxb_notif_push', v ? 'true' : 'false');
  };
  const [v2rayModal,  setV2rayModal]  = useState(false);
  const [pinEnabled,  setPinEnabled]  = useState(false);
  const [pinModal,    setPinModal]    = useState<"set"|"verify"|null>(null);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [killSwitch,  setKillSwitch]  = useState(false);
  const [langModal,   setLangModal]   = useState(false);
  const [logsModal,   setLogsModal]   = useState(false);
  const [deviceId,    setDeviceId]    = useState<string | null>(null);
  const [storageSize,      setStorageSize]      = useState<string>("…");
  const [clearing,         setClearing]         = useState(false);
  const [refreshingConfig, setRefreshingConfig] = useState(false);

  useEffect(() => {
    (async () => {
      // Load device ID
      let did = await AsyncStorage.getItem("@sxb_device_id");
      if (!did) {
        did = "SXB" + Math.random().toString(36).slice(2,14).toUpperCase();
        await AsyncStorage.setItem("@sxb_device_id", did);
      }
      setDeviceId(did);

      // Load PIN setting
      const storedPin = await AsyncStorage.getItem("@sxb_pin");
      const storedNotif = await AsyncStorage.getItem("@sxb_notif_push");
      if (storedNotif !== null) setNotifPush(storedNotif === 'true');
      setPinEnabled(!!storedPin);

      // auto reconnect + kill switch viennent du VpnContext (synchronisés avec le service natif)
      setAutoReconnect(arCtx);
      setKillSwitch(ksCtx);

      // Estimate storage
      const keys = await AsyncStorage.getAllKeys();
      let total = 0;
      const pairs = await AsyncStorage.multiGet(keys as string[]);
      pairs.forEach(([_, v]) => { total += (v?.length || 0); });
      setStorageSize(total < 1024 ? `${total} o` : `${(total/1024).toFixed(1)} ko`);
    })();
  }, []);

  const handlePinToggle = (v: boolean) => {
    if (v) {
      setPinModal("set");
    } else {
      Alert.alert("Désactiver le PIN ?", "Le verrouillage par code sera supprimé.", [
        { text: "Annuler", style: "cancel" },
        {
          text: "Désactiver", style: "destructive", onPress: async () => {
            await AsyncStorage.removeItem("@sxb_pin");
            setPinEnabled(false);
          }
        },
      ]);
    }
  };

  const handlePinSet = async (pin: string) => {
    // btoa-encoded PIN for minimal obfuscation
    const encoded = btoa(pin);
    await AsyncStorage.setItem("@sxb_pin", encoded);
    setPinEnabled(true);
    setPinModal(null);
    Alert.alert("PIN activé", "Le verrouillage par code est maintenant actif.");
  };

  const handleRefreshConfig = async () => {
    if (refreshingConfig) return;
    setRefreshingConfig(true);
    try {
      await refreshVpnConfig();
      Alert.alert("✅ Configuration mise à jour", "La configuration VPN a été synchronisée depuis le serveur.");
    } catch {
      Alert.alert("❌ Erreur", "Impossible de synchroniser la configuration. Vérifiez votre connexion.");
    } finally {
      setRefreshingConfig(false);
    }
  };

  const handleAutoReconnect = async (v: boolean) => {
    setAutoReconnect(v);
    await setArCtx(v);
  };

  const handleKillSwitch = async (v: boolean) => {
    setKillSwitch(v);
    await setKsCtx(v);
    if (v) {
      Alert.alert("Kill Switch activé", "Toute connexion internet sera bloquée si le VPN se déconnecte.");
    }
  };

  const handleClearData = () => {
    Alert.alert(
      "Effacer les données locales",
      "Cette action supprime la configuration VPN, les logs et les préférences locales. Votre compte ne sera pas supprimé.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Effacer", style: "destructive", onPress: async () => {
            setClearing(true);
            const keys = ["@sxb_vpn_config","@sxb_vpn_connected","@sxb_vpn_protocol",
              "@sxb_connection_uri","@sxb_pin","@sxb_kill_switch","@sxb_auto_reconnect"];
            await AsyncStorage.multiRemove(keys);
            setClearing(false);
            Alert.alert("Données effacées", "Les données locales ont été supprimées.");
          }
        },
      ]
    );
  };

  const handleLogout = () => {
    Alert.alert(
      "Se déconnecter",
      "Votre session locale sera effacée.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Se déconnecter", style: "destructive",
          onPress: () => logout().then(() => router.replace("/activate")),
        },
      ]
    );
  };

  const currentLang = LANGS.find(l => l.code === language) || LANGS[0];

  // Account state display
  const acctStatus = accountState?.state;
  const acctBadge = {
    ready: { text: "Actif", color: Colors.connected },
    no_package: { text: "Sans forfait", color: Colors.warning },
    expired: { text: "Expiré", color: Colors.disconnected },
    suspended: { text: "Suspendu", color: Colors.disconnected },
  }[acctStatus || "no_package"] || { text: "Inconnu", color: Colors.textMuted };

  const formatExpiry = () => {
    if (!accountState?.expireAt) return "—";
    const d = new Date(accountState.expireAt);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  };

  const quotaUsed = accountState
    ? `${accountState.quotaUsedGb?.toFixed(1) || 0} / ${accountState.quotaTotalGb?.toFixed(1) || 0} GB`
    : "—";

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.pageHeader}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={20} color={Colors.textSecondary} />
          </Pressable>
          <Text style={styles.pageTitle}>Paramètres</Text>
          <View style={{ width: 36 }} />
        </View>

        {/* Account card */}
        <View style={styles.accountCard}>
          <View style={styles.accountAvatar}>
            <Text style={styles.accountInitials}>
              {(user?.name || "?").split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2)}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.accountName}>{user?.name || "Utilisateur"}</Text>
            <Text style={styles.accountEmail}>{user?.email || ""}</Text>
            <View style={[styles.badge, { backgroundColor: acctBadge.color + "20", borderColor: acctBadge.color + "40", alignSelf: "flex-start", marginTop: 4 }]}>
              <Text style={[styles.badgeText, { color: acctBadge.color }]}>{acctBadge.text}</Text>
            </View>
          </View>
          <View style={styles.accountDotWrap}>
            <View style={[styles.accountDot, { backgroundColor: isConnected ? Colors.connected : Colors.disconnected }]} />
          </View>
        </View>

        {/* Subscription info */}
        <Section title="FORFAIT" subtitle={accountState?.expireAt ? `Expire le ${formatExpiry()}` : undefined}>
          <Row icon="data-usage-outline" label="Quota utilisé" value={quotaUsed} color={Colors.primary} />
          <View style={styles.divider} />
          <Row icon="calendar-outline" label="Expiration" value={formatExpiry()} color={Colors.warning} />
          <View style={styles.divider} />
          <Row
            icon="gift-outline" label="Activer un forfait"
            onPress={() => router.push("/plan")} color={Colors.purple}
          />
        </Section>

        {/* VPN */}
        <Section title="VPN">
          <Row
            icon="globe-outline" label="Protocole actif"
            value={selectedProtocol || "AUTO"} color={Colors.primary}
          />
          <View style={styles.divider} />
          <Row
            icon="code-working-outline" label="Éditeur JSON V2Ray"
            onPress={() => setV2rayModal(true)} color={Colors.primary}
          />
          <View style={styles.divider} />
          <Row
            icon="refresh-outline" label="Reconnexion automatique"
            toggle toggleValue={autoReconnect} onToggle={handleAutoReconnect}
            color={Colors.primary}
          />
          <View style={styles.divider} />
          <Row
            icon="shield-outline" label="Kill Switch"
            toggle toggleValue={killSwitch} onToggle={handleKillSwitch}
            color={Colors.warning}
            badge={killSwitch ? "ON" : undefined} badgeColor={Colors.warning}
          />
          <View style={styles.divider} />
          <View style={styles.divider} />
          <Row
            icon="cloud-download-outline"
            label={refreshingConfig ? "Synchronisation..." : "Actualiser la configuration"}
            onPress={handleRefreshConfig}
            color={Colors.primary}
            disabled={refreshingConfig}
            badge={refreshingConfig ? "…" : undefined}
          />
          <View style={styles.divider} />
          <Row
            icon="terminal-outline" label="Voir les logs VPN"
            onPress={() => setLogsModal(true)} color={Colors.primary}
            badge={logs.length > 0 ? String(logs.length) : undefined}
          />
        </Section>

        {/* Security */}
        <Section title="SÉCURITÉ">
          <Row
            icon="lock-closed-outline" label="Verrouillage par code PIN"
            toggle toggleValue={pinEnabled} onToggle={handlePinToggle}
            color={Colors.warning}
          />

          <View style={styles.divider} />
          <Row
            icon="phone-portrait-outline" label="ID Appareil"
            value={deviceId ? deviceId.slice(0,14) + "…" : "…"}
            color={Colors.textMuted}
          />
        </Section>

        {/* Appearance */}
        <Section title="APPARENCE & LANGUE">
          <Row
            icon="moon-outline" label="Thème sombre"
            value="Activé"
            color={Colors.primary}
          />
          <View style={styles.divider} />
          <Row
            icon="language-outline" label="Langue"
            value={`${currentLang.flag} ${currentLang.label}`}
            onPress={() => setLangModal(true)} color={Colors.primary}
          />
        </Section>

        {/* Notifications */}
        <Section title="NOTIFICATIONS">
          <Row
            icon="notifications-outline" label="Notifications push"
            toggle toggleValue={notifPush} onToggle={handleNotifToggle}
          />
          <View style={styles.divider} />
          <Row
            icon="warning-outline" label="Alertes expiration forfait"
            toggle toggleValue={notifPush} onToggle={handleNotifToggle}
            color={Colors.warning}
          />
        </Section>

        {/* Data */}
        <Section title="DONNÉES & STOCKAGE">
          <Row
            icon="server-outline" label="Taille du cache"
            value={storageSize}
            color={Colors.textMuted}
          />
          <View style={styles.divider} />
          <Pressable
            onPress={handleClearData}
            disabled={clearing}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            <View style={[styles.rowIcon, { backgroundColor: Colors.disconnected + "15" }]}>
              <Ionicons name="trash-outline" size={18} color={Colors.disconnected} />
            </View>
            <Text style={[styles.rowLabel, { color: Colors.disconnected }]}>
              {clearing ? "Effacement..." : "Effacer les données locales"}
            </Text>
            {clearing ? <ActivityIndicator color={Colors.disconnected} size="small" /> : null}
          </Pressable>
        </Section>

        {/* About */}
        <Section title="À PROPOS">
          <Row icon="information-circle-outline" label="Version" value={Constants.expoConfig?.version || "1.0.0"} color={Colors.textMuted} />
          <View style={styles.divider} />
          <Row icon="hardware-chip-outline" label="Moteur VPN" value="sing-box + JSch" color={Colors.textMuted} />
          <View style={styles.divider} />
          <Pressable
            onPress={() => router.push("/support")}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            <View style={[styles.rowIcon, { backgroundColor: Colors.primary + "15" }]}>
              <Ionicons name="help-circle-outline" size={18} color={Colors.primary} />
            </View>
            <Text style={styles.rowLabel}>Support & Aide</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
          </Pressable>
        </Section>

        {/* Logout */}
        <Pressable onPress={handleLogout} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={20} color={Colors.disconnected} />
          <Text style={styles.logoutText}>Se déconnecter</Text>
        </Pressable>

        <Text style={styles.footerText}>SXB VPN © 2025 — Tous droits réservés</Text>
      </ScrollView>

      {/* Modals */}
      <V2rayJsonModal visible={v2rayModal} onSave={manuallySetConfig} onClose={() => setV2rayModal(false)} />
      <PinModal visible={pinModal === "set"} mode="set" onSet={handlePinSet} onClose={() => setPinModal(null)} />
      <LangModal visible={langModal} current={language} onSelect={setLanguage} onClose={() => setLangModal(false)} />
      <LogsModal visible={logsModal} logs={logs} onClose={() => setLogsModal(false)} />
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 20 },
  pageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.bgCard, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 20, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  accountCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: Colors.bgCard, borderRadius: 18, borderWidth: 1, borderColor: Colors.border, padding: 16 },
  accountAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.primaryDim, alignItems: "center", justifyContent: "center" },
  accountInitials: { fontSize: 18, fontWeight: "700", color: Colors.primary, fontFamily: "Inter_700Bold" },
  accountName: { fontSize: 15, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  accountEmail: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  accountDotWrap: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.bgInput, alignItems: "center", justifyContent: "center" },
  accountDot: { width: 8, height: 8, borderRadius: 4 },
  badge: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1, gap: 4 },
  badgeText: { fontSize: 10, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  section: { gap: 10 },
  sectionHeader: { paddingHorizontal: 4 },
  sectionLabel: { fontSize: 11, fontWeight: "700", color: Colors.textMuted, letterSpacing: 1.2, fontFamily: "Inter_700Bold" },
  sectionSubtitle: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", marginTop: 2 },
  sectionCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12, minHeight: 52 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, fontSize: 14, fontWeight: "500", color: "#FFF", fontFamily: "Inter_500Medium" },
  rowValue: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  rowSwitch: { transform: [{ scale: 0.85 }] },
  rowBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  rowBadgeText: { fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold" },
  divider: { height: 1, backgroundColor: Colors.border, marginHorizontal: 14 },
  modalOverlay: { flex: 1, backgroundColor: Colors.overlay, justifyContent: "center", alignItems: "center", padding: 24 },
  langSheet: { backgroundColor: Colors.bgCard, borderRadius: 20, padding: 20, width: "100%", maxWidth: 360, gap: 8, borderWidth: 1, borderColor: Colors.border },
  langSheetTitle: { fontSize: 18, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", marginBottom: 8 },
  langRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: Colors.border },
  langRowActive: { borderColor: Colors.primary + "50", backgroundColor: Colors.primaryDim },
  langFlag: { fontSize: 24 },
  langLabel: { flex: 1, fontSize: 15, fontWeight: "500", color: "#FFF", fontFamily: "Inter_500Medium" },
  v2raySheet: { backgroundColor: Colors.bgCard, borderRadius: 20, padding: 20, width: "100%", maxWidth: 400, gap: 10, borderWidth: 1, borderColor: Colors.border },
  v2rayTitle: { fontSize: 18, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  v2rayHint: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  v2rayInput: { backgroundColor: Colors.bgInput, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: 12, minHeight: 120, color: "#FFF", fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 18 },
  v2rayError: { fontSize: 12, color: Colors.disconnected, fontFamily: "Inter_400Regular" },
  v2rayButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  v2rayCancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: Colors.border },
  v2rayCancelText: { fontSize: 14, color: Colors.textMuted, fontFamily: "Inter_500Medium" },
  v2raySaveBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: Colors.primary },
  v2raySaveText: { fontSize: 14, fontWeight: "600", color: "#060914", fontFamily: "Inter_600SemiBold" },
  pinSheet: { backgroundColor: Colors.bgCard, borderRadius: 20, padding: 20, width: "100%", maxWidth: 340, gap: 10, borderWidth: 1, borderColor: Colors.border },
  pinTitle: { fontSize: 18, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", marginBottom: 4 },
  pinInput: { backgroundColor: Colors.bgInput, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: 14, color: "#FFF", fontSize: 18, textAlign: "center", fontFamily: "Inter_600SemiBold", letterSpacing: 8 },
  pinError: { fontSize: 12, color: Colors.disconnected, fontFamily: "Inter_400Regular" },
  pinButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  pinCancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: Colors.border },
  pinCancelText: { fontSize: 14, color: Colors.textMuted, fontFamily: "Inter_500Medium" },
  pinSaveBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: Colors.primary },
  pinSaveText: { fontSize: 14, fontWeight: "600", color: "#060914", fontFamily: "Inter_600SemiBold" },
  logsSheet: { backgroundColor: Colors.bgCard, borderRadius: 20, padding: 20, width: "100%", maxWidth: 400, maxHeight: "80%", gap: 10, borderWidth: 1, borderColor: Colors.border },
  logsTitle: { fontSize: 16, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  logsScroll: { flex: 1 },
  logsContent: { gap: 6 },
  logsEmpty: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular", textAlign: "center", paddingVertical: 20 },
  logLine: { fontSize: 11, color: Colors.textSecondary, fontFamily: "Inter_400Regular", lineHeight: 16 },
  logsCloseBtn: { alignSelf: "center", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, backgroundColor: Colors.primary, marginTop: 8 },
  logsCloseText: { fontSize: 14, fontWeight: "600", color: "#060914", fontFamily: "Inter_600SemiBold" },
  logoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: Colors.disconnected + "30", backgroundColor: Colors.disconnected + "10" },
  logoutText: { fontSize: 14, fontWeight: "600", color: Colors.disconnected, fontFamily: "Inter_600SemiBold" },
  footerText: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 10 },
});

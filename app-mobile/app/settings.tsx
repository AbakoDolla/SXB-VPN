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
import { useTranslation } from "@/localization";
import { deriveQuota, formatBytes } from "@/services/quotaState";
import Colors from "@/constants/colors";
import { getDiagnosticLogging, setDiagnosticLogging } from "@/modules/expo-sxb-vpn/src";

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
      {badge && (
        <View style={[styles.badge, { backgroundColor: (badgeColor || Colors.primary) + "20", borderColor: (badgeColor || Colors.primary) + "40" }]}>
          <Text style={[styles.badgeText, { color: badgeColor || Colors.primary }]}>{badge}</Text>
        </View>
      )}
      {toggle ? (
        <Switch
          value={toggleValue}
          onValueChange={onToggle}
          trackColor={{ false: Colors.border, true: c + "60" }}
          thumbColor={toggleValue ? c : Colors.textMuted}
          disabled={disabled}
        />
      ) : value ? (
        <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
      ) : null}
    </Pressable>
  );
}

function Section({ title, children, subtitle }: { title: string; children: React.ReactNode; subtitle?: string }) {
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
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <View style={styles.langSheet}>
          <Text style={styles.langSheetTitle}>{t("language_row")} / Language</Text>
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

// ── Logs modal ────────────────────────────────────────────────────────────────

function LogsModal({ visible, logs, onClose }: { visible: boolean; logs: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.logsOverlay}>
        <View style={styles.logsSheet}>
          <View style={styles.logsHeader}>
            <View style={styles.logsHandle} />
            <Text style={styles.logsTitle}>{t("vpn_logs")}</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView style={styles.logsScroll} showsVerticalScrollIndicator={false}>
            {logs.length === 0 ? (
              <Text style={styles.logsEmpty}>{t("logs_waiting")}</Text>
            ) : logs.map((l, i) => (
              <Text key={i} style={[
                styles.logLine,
                l.startsWith("✅") && { color: Colors.connected },
                l.startsWith("❌") && { color: Colors.disconnected },
              ]}>{l}</Text>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── PIN modal ─────────────────────────────────────────────────────────────────

function PinModal({ visible, mode, onSuccess, onClose }: {
  visible: boolean; mode: "set" | "verify";
  onSuccess: (pin: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");

  const handleSubmit = () => {
    if (mode === "set") {
      if (pin.length < 4) { setErr(t("pin_lock_row")); return; }
      if (pin !== confirm) { setErr(t("pin_lock_row")); return; }
      onSuccess(pin);
    } else {
      onSuccess(pin);
    }
    setPin(""); setConfirm(""); setErr("");
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.pinSheet}>
          <Text style={styles.pinTitle}>{mode === "set" ? t("pin_lock_row") : t("pin_lock_row")}</Text>
          {err ? <Text style={styles.pinErr}>{err}</Text> : null}
          <TextInput
            style={styles.pinInput}
            value={pin} onChangeText={setPin}
            keyboardType="number-pad" secureTextEntry maxLength={8}
            placeholder="••••" placeholderTextColor={Colors.textMuted}
            autoFocus
          />
          {mode === "set" && (
            <TextInput
              style={styles.pinInput}
              value={confirm} onChangeText={setConfirm}
              keyboardType="number-pad" secureTextEntry maxLength={8}
              placeholder={t("confirm") + " ••••"} placeholderTextColor={Colors.textMuted}
            />
          )}
          <View style={styles.pinBtns}>
            <Pressable onPress={onClose} style={styles.pinBtnCancel}>
              <Text style={styles.pinBtnCancelText}>{t("cancel")}</Text>
            </Pressable>
            <Pressable onPress={handleSubmit} style={styles.pinBtnOk}>
              <Text style={styles.pinBtnOkText}>{t("confirm")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
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
  } = useVpnContext();
  const { language, setLanguage } = useLanguageContext();
  const { t } = useTranslation();

  // State
  const [notifPush,   setNotifPush]   = useState(true);
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
  const [diagnosticLogging, setDiagnosticLoggingState] = useState(false);

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
      setPinEnabled(!!storedPin);

      // auto reconnect + kill switch viennent du VpnContext (synchronisés avec le service natif)
      setAutoReconnect(arCtx);
      setKillSwitch(ksCtx);
      const diagnosticEnabled = await getDiagnosticLogging().catch(() => false);
      setDiagnosticLoggingState(diagnosticEnabled);

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
      Alert.alert(t("pin_lock_row"), t("clear_local_data_msg"), [
        { text: t("cancel"), style: "cancel" },
        {
          text: t("clear"), style: "destructive", onPress: async () => {
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
    Alert.alert(t("pin_lock_row"), t("active"));
  };

  const handleRefreshConfig = async () => {
    if (refreshingConfig) return;
    setRefreshingConfig(true);
    try {
      await refreshVpnConfig();
      Alert.alert("✅ " + t('refresh_config_success'), t('config_synced_title'));
    } catch {
      Alert.alert("❌ " + t('error_generic'), t('config_sync_error_msg'));
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
      Alert.alert(t('kill_switch_enabled_title'), t('kill_switch_enabled_msg'));
    }
  };

  const handleDiagnosticLogging = async (v: boolean) => {
    const applied = await setDiagnosticLogging(v).catch(() => false);
    setDiagnosticLoggingState(v && applied);
    if (v && applied) {
      Alert.alert(t('diagnostic_row'), t('diagnostic_warning'));
    }
  };

  const handleClearData = () => {
    Alert.alert(
      t('clear_local_data_title'),
      t('clear_local_data_msg'),
      [
        { text: t('cancel'), style: "cancel" },
        {
          text: t('clear'), style: "destructive", onPress: async () => {
            setClearing(true);
            const keys = ["@sxb_vpn_config","@sxb_vpn_connected","@sxb_vpn_protocol",
              "@sxb_connection_uri","@sxb_pin","@sxb_kill_switch","@sxb_auto_reconnect"];
            await AsyncStorage.multiRemove(keys);
            setClearing(false);
            Alert.alert(t('data_cleared'), t('data_cleared_msg'));
          }
        },
      ]
    );
  };

  const handleLogout = () => {
    Alert.alert(
      t('logout'),
      t('logout_confirm_local_short'),
      [
        { text: t('cancel'), style: "cancel" },
        {
          text: t('logout'), style: "destructive",
          onPress: () => logout().then(() => router.replace("/activate")),
        },
      ]
    );
  };

  const currentLang = LANGS.find(l => l.code === language) || LANGS[0];

  // Account state display
  const acctStatus = (accountState as any)?.state;
  const acctBadge: { text: string; color: string } = (({
    ready: { text: t('active'), color: Colors.connected },
    no_package: { text: t('status_no_package'), color: Colors.warning },
    expired: { text: t('expired'), color: Colors.disconnected },
    suspended: { text: t('suspended_status'), color: Colors.disconnected },
  } as Record<string, { text: string; color: string }>)[acctStatus || "no_package"]) || { text: t('status_unknown'), color: Colors.textMuted };

  const formatExpiry = () => {
    if (!accountState?.expireAt) return "—";
    const d = new Date(accountState.expireAt);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  };

  const derived = deriveQuota(accountState);
  const quotaUsed = accountState
    ? `${derived.formattedUsed} / ${derived.formattedTotal}`
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
          <Text style={styles.pageTitle}>{t("settings")}</Text>
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
          {/* V2Ray JSON editor removed — SXB VPN is a pure SaaS client; server config is managed by backend */}
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

        <Section title={t('diagnostic_section')} subtitle={t('diagnostic_subtitle')}>
          <Row
            icon="bug-outline"
            label={t('diagnostic_row')}
            toggle
            toggleValue={diagnosticLogging}
            onToggle={handleDiagnosticLogging}
            color={Colors.warning}
            badge={diagnosticLogging ? t('dev_badge') : undefined}
            badgeColor={Colors.warning}
          />
          {diagnosticLogging && (
            <Text style={styles.sectionSubtitle}>{t('diagnostic_warning')}</Text>
          )}
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
            icon="finger-print-outline" label="Authentification biométrique"
            toggle toggleValue={false} onToggle={() => Alert.alert("Bientôt disponible", "La biométrie sera activée dans la prochaine version.")}
            color={Colors.warning} disabled
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
            toggle toggleValue={true} onToggle={() => {}}
            color={Colors.primary} disabled
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
            toggle toggleValue={notifPush} onToggle={setNotifPush}
          />
          <View style={styles.divider} />
          <Row
            icon="warning-outline" label="Alertes expiration forfait"
            toggle toggleValue={notifPush} onToggle={setNotifPush}
            color={Colors.warning}
          />
        </Section>

        {/* Data */}
        <Section title="DONNÉES LOCALES">
          <Row
            icon="folder-outline" label="Données stockées"
            value={storageSize} color={Colors.textMuted}
          />
          <View style={styles.divider} />
          <Row
            icon="trash-outline" label="Effacer les données locales"
            onPress={handleClearData} destructive
          />
        </Section>

        {/* About */}
        <Section title="À PROPOS">
          <Row icon="information-circle-outline" label="Version" value={`v${Constants.expoConfig?.version ?? "1.0.0"}`} />
          <View style={styles.divider} />
          <Row icon="code-slash-outline" label="Build" value={Constants.expoConfig?.android?.versionCode?.toString() ?? "1"} />
          <View style={styles.divider} />
          <Row
            icon="headset-outline" label="Support"
            onPress={() => router.push("/support")} color={Colors.connected}
          />
          <View style={styles.divider} />
          <Row icon="document-text-outline" label="CGU / Politique de confidentialité"
            onPress={() => Alert.alert(
              "CGU & Politique de confidentialité",
              "Disponible sur https://sxbvpn.com/legal\n\nSXB VPN ne collecte aucune donnée de navigation ni log de connexion.",
              [{ text: "Fermer" }]
            )} />
        </Section>

        {/* Diagnostic VPN — accessible uniquement en mode développement */}
        {__DEV__ && (
          <Section title="DIAGNOSTIC" subtitle="Outils de débogage tunnel VPN (dev only)">
            <Row
              icon="bug-outline"
              label="Diagnostic VPN"
              badge="DEV"
              badgeColor="#7C5FFF"
              onPress={() => router.push("/vpn-debug" as any)}
              color="#7C5FFF"
            />
          </Section>
        )}

        {/* Logout */}
        {clearing ? (
          <ActivityIndicator color={Colors.primary} style={{ marginTop: 8 }} />
        ) : (
          <Pressable onPress={handleLogout} style={styles.logoutBtn}>
            <Ionicons name="log-out-outline" size={18} color={Colors.disconnected} />
            <Text style={styles.logoutText}>{t("logout")}</Text>
          </Pressable>
        )}

        <Text style={styles.footer}>{t("app_name")} — STUFF X BILAL</Text>
      </ScrollView>

      {/* Modals */}
      <LangModal
        visible={langModal} current={language}
        onSelect={(code) => setLanguage(code as any)} onClose={() => setLangModal(false)}
      />
      <LogsModal
        visible={logsModal} logs={logs}
        onClose={() => setLogsModal(false)}
      />
      {pinModal && (
        <PinModal
          visible={true} mode={pinModal}
          onSuccess={handlePinSet}
          onClose={() => setPinModal(null)}
        />
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 20 },
  pageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 18, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  accountCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 16 },
  accountAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.primaryDim, borderWidth: 1.5, borderColor: Colors.primary + "50", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  accountInitials: { fontSize: 20, fontWeight: "700", color: Colors.primary, fontFamily: "Inter_700Bold" },
  accountName: { fontSize: 16, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  accountEmail: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  accountDotWrap: { alignItems: "center", justifyContent: "center" },
  accountDot: { width: 10, height: 10, borderRadius: 5 },
  section: { gap: 6 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 4 },
  sectionLabel: { fontSize: 10, fontWeight: "700", color: Colors.textMuted, letterSpacing: 1.5, fontFamily: "Inter_700Bold" },
  sectionSubtitle: { fontSize: 10, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  sectionCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, fontSize: 14, color: "#FFF", fontFamily: "Inter_500Medium" },
  rowValue: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular", maxWidth: 120 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold" },
  divider: { height: 1, backgroundColor: Colors.border },
  logoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: Colors.disconnected + "40", backgroundColor: Colors.disconnectedDim },
  logoutText: { fontSize: 15, fontWeight: "600", color: Colors.disconnected, fontFamily: "Inter_600SemiBold" },
  footer: { textAlign: "center", fontSize: 10, color: Colors.textMuted, fontFamily: "Inter_400Regular", letterSpacing: 2 },
  // Lang modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", padding: 20 },
  langSheet: { backgroundColor: "#0A0F1C", borderRadius: 20, padding: 20, borderWidth: 1, borderColor: Colors.border },
  langSheetTitle: { fontSize: 16, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", marginBottom: 14, textAlign: "center" },
  langRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 12 },
  langRowActive: { backgroundColor: Colors.primaryDim },
  langFlag: { fontSize: 24 },
  langLabel: { flex: 1, fontSize: 15, color: "#FFF", fontFamily: "Inter_500Medium" },
  // Logs modal
  logsOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(6,9,20,0.8)" },
  logsSheet: { backgroundColor: "#0A0F1C", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: "65%", minHeight: 250 },
  logsHandle: { width: 36, height: 4, backgroundColor: Colors.border, borderRadius: 2, alignSelf: "center", marginBottom: 4 },
  logsHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 12 },
  logsTitle: { flex: 1, fontSize: 16, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  logsScroll: { flex: 1 },
  logsEmpty: { color: Colors.textMuted, fontFamily: "Inter_400Regular", fontSize: 13, textAlign: "center", paddingTop: 20 },
  logLine: { fontSize: 12, color: Colors.textSecondary, fontFamily: "Inter_400Regular", paddingVertical: 2 },
  // PIN modal
  pinSheet: { backgroundColor: "#0A0F1C", borderRadius: 20, padding: 24, borderWidth: 1, borderColor: Colors.border, gap: 14 },
  pinTitle: { fontSize: 16, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", textAlign: "center" },
  pinErr: { color: Colors.disconnected, fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center" },
  pinInput: { backgroundColor: "#060914", borderWidth: 1, borderColor: Colors.border, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, color: "#FFF", fontSize: 20, fontFamily: "Inter_700Bold", textAlign: "center", letterSpacing: 8 },
  pinBtns: { flexDirection: "row", gap: 10, marginTop: 4 },
  pinBtnCancel: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  pinBtnCancelText: { color: Colors.textMuted, fontFamily: "Inter_500Medium", fontSize: 14 },
  pinBtnOk: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: Colors.primaryDim, borderWidth: 1, borderColor: Colors.primary + "40", alignItems: "center" },
  pinBtnOkText: { color: Colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 },
});

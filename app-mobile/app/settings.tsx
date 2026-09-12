/**
 * SettingsScreen — SXB VPN Mobile
 * Paramètres enrichis : compte, sécurité fonctionnelle, langue, VPN, données
 */
import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  Alert, Linking, Pressable, ScrollView, StyleSheet,
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
import { useColors } from "@/hooks/useColors";
import { useThemeContext } from "@/contexts/ThemeContext";
import { getDiagnosticLogging, setDiagnosticLogging } from "@/modules/expo-sxb-vpn/src";
import {
  areAnnouncementNotificationsEnabled,
  setAnnouncementNotificationsEnabled,
} from "@/services/announcementNotifications";
import { useAppLock } from "@/contexts/AppLockContext";
import { DATA_DELETION_URL, isPlayDistribution } from "@/services/distribution";
import { usePrivacy } from "@/contexts/PrivacyContext";

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
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const c = destructive ? colors.disconnected : (color || colors.primary);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || (toggle && !onPress)}
      style={({ pressed }) => [styles.row, pressed && !disabled && { opacity: 0.7 }]}
    >
      <View style={[styles.rowIcon, { backgroundColor: c + "15" }]}>
        <Ionicons name={icon as any} size={18} color={c} />
      </View>
      <Text style={[styles.rowLabel, { color: destructive ? colors.disconnected : colors.textPrimary }, disabled && { color: colors.textMuted }]}>
        {label}
      </Text>
      {badge && (
        <View style={[styles.badge, { backgroundColor: (badgeColor || colors.primary) + "20", borderColor: (badgeColor || colors.primary) + "40" }]}>
          <Text style={[styles.badgeText, { color: badgeColor || colors.primary }]}>{badge}</Text>
        </View>
      )}
      {toggle ? (
        <Switch
          value={toggleValue}
          onValueChange={onToggle}
          trackColor={{ false: colors.border, true: c + "60" }}
          thumbColor={toggleValue ? c : colors.textMuted}
          disabled={disabled}
          accessibilityLabel={label}
          accessibilityRole="switch"
          accessibilityState={{ checked: toggleValue, disabled }}
        />
      ) : value ? (
        <Text style={[styles.rowValue, { color: colors.textMuted }]} numberOfLines={1}>{value}</Text>
      ) : onPress ? (
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      ) : null}
    </Pressable>
  );
}

function Section({ title, children, subtitle }: { title: string; children: React.ReactNode; subtitle?: string }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{title}</Text>
        {subtitle && <Text style={[styles.sectionSubtitle, { color: colors.textMuted }]}>{subtitle}</Text>}
      </View>
      <View style={[styles.sectionCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>{children}</View>
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
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
              <Text style={[styles.langLabel, current === l.code && { color: colors.primary }]}>{l.label}</Text>
              {current === l.code && <Ionicons name="checkmark" size={18} color={colors.primary} />}
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

// ── Logs modal ────────────────────────────────────────────────────────────────
// Supprimée : les journaux sont désormais réunis dans l'écran unique
// `app/diagnostics.tsx`. Ils apparaissaient auparavant ici, sur l'accueil, et en
// ligne pendant la connexion — trois vues partielles sans source de vérité.

// ── PIN modal ─────────────────────────────────────────────────────────────────

function PinModal({ visible, mode, onSubmit, onClose }: {
  visible: boolean; mode: "set" | "verify";
  onSubmit: (pin: string) => Promise<string | null>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (mode === "set") {
      if (!/^\d{4,8}$/.test(pin)) { setErr(t("pin_format_error")); return; }
      if (pin !== confirm) { setErr(t("pin_mismatch_error")); return; }
    }
    setSubmitting(true);
    try {
      const submissionError = await onSubmit(pin);
      if (submissionError) {
        setErr(submissionError);
        setPin("");
        return;
      }
      setPin("");
      setConfirm("");
      setErr("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.pinSheet}>
          <Text style={styles.pinTitle}>{mode === "set" ? t("pin_setup_title") : t("pin_verify_title")}</Text>
          <Text style={styles.pinHint}>{mode === "set" ? t("pin_setup_hint") : t("pin_verify_hint")}</Text>
          {err ? <Text style={styles.pinErr} accessibilityRole="alert">{err}</Text> : null}
          <TextInput
            style={styles.pinInput}
            value={pin} onChangeText={(value) => { setPin(value.replace(/\D/g, "")); setErr(""); }}
            keyboardType="number-pad" secureTextEntry maxLength={8}
            placeholder="••••" placeholderTextColor={colors.textMuted}
            accessibilityLabel={t("app_lock_pin_label")}
            autoComplete="off"
            autoFocus
          />
          {mode === "set" && (
            <TextInput
              style={styles.pinInput}
              value={confirm} onChangeText={(value) => { setConfirm(value.replace(/\D/g, "")); setErr(""); }}
              keyboardType="number-pad" secureTextEntry maxLength={8}
              placeholder={t("confirm") + " ••••"} placeholderTextColor={colors.textMuted}
              accessibilityLabel={t("pin_confirm_label")}
              autoComplete="off"
            />
          )}
          <View style={styles.pinBtns}>
            <Pressable onPress={onClose} disabled={submitting} style={styles.pinBtnCancel} accessibilityRole="button">
              <Text style={styles.pinBtnCancelText}>{t("cancel")}</Text>
            </Pressable>
            <Pressable
              onPress={() => { void handleSubmit(); }}
              disabled={submitting}
              style={[styles.pinBtnOk, submitting && { opacity: 0.5 }]}
              accessibilityRole="button"
              accessibilityState={{ busy: submitting }}
            >
              {submitting
                ? <ActivityIndicator color={colors.primary} />
                : <Text style={styles.pinBtnOkText}>{t("confirm")}</Text>}
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
  const { user, accountState, logout, deviceAccess, deviceId: boundDeviceId } = useAuthContext();
  const {
    logs, isConnected, selectedProtocol, availableProtocols, refreshVpnConfig,
    killSwitch: ksCtx, autoReconnect: arCtx,
    setKillSwitch: setKsCtx, setAutoReconnect: setArCtx,
    traffic, derivedQuota, activeConnection,
  } = useVpnContext();
  const { language, setLanguage } = useLanguageContext();
  const { consent } = usePrivacy();
  const { themePreference, setThemePreference } = useThemeContext();
  const {
    preferences: appLockPreferences,
    biometricCapability,
    isAuthenticating: appLockAuthenticating,
    setPin,
    removePin,
    enableBiometrics,
    disableBiometrics,
    unlockWithPin,
    clearAppLock,
  } = useAppLock();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { t } = useTranslation();

  // State
  const [notifPush,   setNotifPush]   = useState(true);
  const [pinModal,    setPinModal]    = useState<"set"|"verify"|null>(null);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [killSwitch,  setKillSwitch]  = useState(false);
  const [langModal,   setLangModal]   = useState(false);
  const [deviceId,    setDeviceId]    = useState<string | null>(null);
  const [storageSize,      setStorageSize]      = useState<string>("…");
  const [clearing,         setClearing]         = useState(false);
  const [refreshingConfig, setRefreshingConfig] = useState(false);
  const [diagnosticLogging, setDiagnosticLoggingState] = useState(false);

  useEffect(() => {
    (async () => {
      // Load device ID
      const did = boundDeviceId || await AsyncStorage.getItem("@sxb_device_id");
      setDeviceId(did);

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
      setNotifPush(await areAnnouncementNotificationsEnabled());
    })();
  }, []);

  const handleNotifications = async (enabled: boolean) => {
    if (isPlayDistribution) {
      router.push('/privacy');
      return;
    }
    setNotifPush(enabled);
    try {
      await setAnnouncementNotificationsEnabled(enabled);
    } catch {
      setNotifPush(!enabled);
      Alert.alert(t("network_error"));
    }
  };

  const handlePinToggle = (v: boolean) => {
    if (v) {
      setPinModal("set");
    } else {
      setPinModal("verify");
    }
  };

  const handlePinSubmit = async (pin: string): Promise<string | null> => {
    try {
      if (pinModal === "set") {
        await setPin(pin);
        setPinModal(null);
        Alert.alert(t("pin_lock_row"), t("pin_enabled_message"));
        return null;
      }

      const verification = await unlockWithPin(pin);
      if (!verification.success) {
        return verification.reason === "throttled"
          ? t("app_lock_pin_throttled")
          : t("app_lock_pin_invalid");
      }
      if (appLockPreferences.biometricsEnabled) await disableBiometrics();
      await removePin();
      setPinModal(null);
      Alert.alert(t("pin_lock_row"), t("pin_disabled_message"));
      return null;
    } catch {
      return t("app_lock_storage_error");
    }
  };

  const handleBiometricToggle = async (enabled: boolean) => {
    if (!enabled) {
      try {
        await disableBiometrics();
      } catch {
        Alert.alert(t("error_generic"), t("app_lock_storage_error"));
      }
      return;
    }

    const result = await enableBiometrics(t("biometric_enable_prompt"), t("cancel"))
      .catch(() => "authentication_failed" as const);
    const messages = {
      enabled: t("biometric_enabled_message"),
      pin_required: t("biometric_pin_required"),
      unavailable: t("biometric_unavailable"),
      not_enrolled: t("biometric_not_enrolled"),
      authentication_failed: t("biometric_auth_failed"),
    } as const;
    Alert.alert(t("biometrics_row"), messages[result]);
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
    if (isPlayDistribution && v && !consent.diagnostics) {
      router.push('/privacy');
      return;
    }
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
            try {
              const keys = ["@sxb_vpn_config","@sxb_vpn_connected","@sxb_vpn_protocol",
                "@sxb_connection_uri","@sxb_kill_switch","@sxb_auto_reconnect"];
              await Promise.all([AsyncStorage.multiRemove(keys), clearAppLock()]);
              Alert.alert(t('data_cleared'), t('data_cleared_msg'));
            } catch {
              Alert.alert(t("error_generic"), t("app_lock_storage_error"));
            } finally {
              setClearing(false);
            }
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
  const acctStatus = deviceAccess ? deviceAccess.status === 'active' ? 'ready' : deviceAccess.status : 'ready';
  const acctBadge: { text: string; color: string } = (({
    ready: { text: t('active'), color: colors.connected },
    no_package: { text: t('status_no_package'), color: colors.warning },
    expired: { text: t('expired'), color: colors.disconnected },
    suspended: { text: t('suspended_status'), color: colors.disconnected },
  } as Record<string, { text: string; color: string }>)[acctStatus || "no_package"]) || { text: t('status_unknown'), color: colors.textMuted };

  const effectiveExpiry = derivedQuota.expiryDate || activeConnection?.expiresAt || null;
  const formatExpiry = () => {
    if (!effectiveExpiry) return "—";
    const d = new Date(effectiveExpiry);
    return d.toLocaleDateString(language, { day: "2-digit", month: "short", year: "numeric" });
  };

  const quotaUsed = (derivedQuota.totalBytes > 0 || derivedQuota.usedBytes > 0)
    ? `${derivedQuota.formattedUsed} / ${derivedQuota.formattedTotal}`
    : "—";

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.pageHeader}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={20} color={colors.textSecondary} />
          </Pressable>
          <Text style={[styles.pageTitle, { color: colors.textPrimary }]}>{t("settings")}</Text>
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
            <View style={[styles.accountDot, { backgroundColor: isConnected ? colors.connected : colors.disconnected }]} />
          </View>
        </View>

        <Section title={t('access_device_title')}>
          <Row icon="phone-portrait-outline" label={t('access_device_expiry')}
            value={deviceAccess?.expireAt ? new Date(deviceAccess.expireAt).toLocaleDateString(language) : t('access_expiry_unknown')} />
          <Row icon="key-outline" label={t('access_enter_code')} onPress={() => router.push('/activate')} />
        </Section>
        <Section title={t('current_plan')}>
          <Row icon="data-usage-outline" label={t('quota_used')} value={quotaUsed} color={colors.primary} />
          <View style={styles.divider} />
          <Row icon="calendar-outline" label={t('access_config_expiry')} value={formatExpiry()} color={colors.warning} />
          <View style={styles.divider} />
          <Row
            icon="gift-outline" label={t('activate_plan')} disabled={!!deviceAccess && deviceAccess.status !== 'active'}
            onPress={() => router.push("/plan")} color={colors.purple}
          />
        </Section>

        {/* VPN */}
        <Section title="VPN">
          <Row
            icon="globe-outline" label="Protocole actif"
            value={selectedProtocol || "AUTO"} color={colors.primary}
          />
          {/* V2Ray JSON editor removed — SXB VPN is a pure SaaS client; server config is managed by backend */}
          <View style={styles.divider} />
          <Row
            icon="refresh-outline" label="Reconnexion automatique"
            toggle toggleValue={autoReconnect} onToggle={handleAutoReconnect}
            color={colors.primary}
          />
          <View style={styles.divider} />
          <Row
            icon="shield-outline" label="Kill Switch"
            toggle toggleValue={killSwitch} onToggle={handleKillSwitch}
            color={colors.warning}
            badge={killSwitch ? "ON" : undefined} badgeColor={colors.warning}
          />
          <View style={styles.divider} />
          <Row
            icon="cloud-download-outline"
            label={refreshingConfig ? "Synchronisation..." : "Actualiser la configuration"}
            onPress={handleRefreshConfig}
            color={colors.primary}
            disabled={refreshingConfig}
            badge={refreshingConfig ? "…" : undefined}
          />
          <View style={styles.divider} />
          <Row
            icon="pulse-outline" label={t('diagnostic_title')}
            onPress={() => router.push("/diagnostics")} color={colors.primary}
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
            color={colors.warning}
            badge={diagnosticLogging ? t('dev_badge') : undefined}
            badgeColor={colors.warning}
          />
          {diagnosticLogging && (
            <Text style={styles.sectionSubtitle}>{t('diagnostic_warning')}</Text>
          )}
        </Section>

        {/* Security */}
        <Section title="SÉCURITÉ">
          <Row
            icon="lock-closed-outline" label={t("pin_lock_row")}
            toggle toggleValue={appLockPreferences.pinEnabled} onToggle={handlePinToggle}
            color={colors.warning}
          />
          <View style={styles.divider} />
          <Row
            icon="finger-print-outline" label={t("biometrics_row")}
            toggle toggleValue={appLockPreferences.biometricsEnabled}
            onToggle={(value) => { void handleBiometricToggle(value); }}
            color={colors.warning}
            disabled={appLockAuthenticating}
            badge={!biometricCapability.hasHardware || !biometricCapability.isEnrolled ? t("unavailable_badge") : undefined}
            badgeColor={colors.textMuted}
          />
          <View style={styles.divider} />
          <Row
            icon="phone-portrait-outline" label="ID Appareil"
            value={deviceId ? deviceId.slice(0,14) + "…" : "…"}
            color={colors.textMuted}
          />
        </Section>

        {/* Appearance */}
        <Section title="APPARENCE & LANGUE">
          {/* Aperçu réel des deux surfaces principales : le choix ne ressemble
              plus à trois boutons abstraits, l'utilisateur voit immédiatement
              la hiérarchie, le contraste et la couleur d'état. */}
          <View style={styles.themePreview}>
            <View style={styles.themePreviewCopy}>
              <Text style={styles.themePreviewTitle}>{t("theme_light")} / {t("theme_dark")}</Text>
              <Text style={styles.themePreviewText}>{themePreference === "system" ? t("theme_system") : themePreference === "light" ? t("theme_light") : t("theme_dark")}</Text>
            </View>
            <View style={styles.themePreviewCards}>
              <View style={[styles.themeMiniCard, { backgroundColor: "#FFFFFF", borderColor: "#D7E2EE" }]}>
                <View style={{ width: 13, height: 13, borderRadius: 5, backgroundColor: "#1769E8" }} />
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={{ width: "72%", height: 5, borderRadius: 4, backgroundColor: "#102033" }} />
                  <View style={{ width: "50%", height: 4, borderRadius: 4, backgroundColor: "#71869D" }} />
                </View>
              </View>
              <View style={[styles.themeMiniCard, { backgroundColor: "#0C1526", borderColor: "#294059" }]}>
                <View style={{ width: 13, height: 13, borderRadius: 5, backgroundColor: "#41D8FF" }} />
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={{ width: "72%", height: 5, borderRadius: 4, backgroundColor: "#F6FAFF" }} />
                  <View style={{ width: "50%", height: 4, borderRadius: 4, backgroundColor: "#6B819F" }} />
                </View>
              </View>
            </View>
          </View>
          <View style={styles.divider} />
          <View style={styles.themePicker}>
            {([
              ["system", "phone-portrait-outline", t("theme_system")],
              ["light", "sunny-outline", t("theme_light")],
              ["dark", "moon-outline", t("theme_dark")],
            ] as const).map(([value, icon, label]) => {
              const active = themePreference === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => { void setThemePreference(value); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.themeChoice, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primaryDim : colors.bgCard2 }]}
                >
                  <Ionicons name={icon as any} size={17} color={active ? colors.primary : colors.textMuted} />
                  <Text style={[styles.themeChoiceText, { color: active ? colors.primary : colors.textSecondary }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.divider} />
          <Row
            icon="language-outline" label="Langue"
            value={`${currentLang.flag} ${currentLang.label}`}
            onPress={() => setLangModal(true)} color={colors.primary}
          />
          <View style={styles.divider} />
          <Row
            icon="school-outline"
            label={t("replay_tutorial")}
            value={t("replay_tutorial_hint")}
            onPress={() => router.push({ pathname: "/onboarding", params: { replay: "1" } })}
            color={colors.purple}
          />
        </Section>

        {/* Notifications */}
        <Section title="NOTIFICATIONS">
          <Row
            icon="notifications-outline" label={t("notification_alerts")}
            toggle toggleValue={isPlayDistribution ? consent.notifications : notifPush} onToggle={handleNotifications}
          />
        </Section>

        {/* Data */}
        <Section title="DONNÉES LOCALES">
          <Row
            icon="folder-outline" label="Données stockées"
            value={storageSize} color={colors.textMuted}
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
            onPress={() => router.push("/support")} color={colors.connected}
          />
          <View style={styles.divider} />
          <Row icon="document-text-outline" label={t("privacy_title")}
            onPress={() => router.push('/privacy')} />
          <View style={styles.divider} />
          <Row icon="trash-outline" label={t("privacy_delete_request")}
            onPress={() => {
              void Linking.openURL(`${DATA_DELETION_URL}?lang=${language}`)
                .catch(() => Alert.alert(t('privacy_title'), t('privacy_link_error')));
            }} />
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
          <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
        ) : (
          <Pressable onPress={handleLogout} style={styles.logoutBtn}>
            <Ionicons name="log-out-outline" size={18} color={colors.disconnected} />
            <Text style={styles.logoutText}>{t("logout")}</Text>
          </Pressable>
        )}

        <Text style={styles.footer}>{t("app_name")}</Text>
        <Text style={[styles.footer, { letterSpacing: 0 }]}>{t('created_by')}</Text>
      </ScrollView>

      {/* Modals */}
      <LangModal
        visible={langModal} current={language}
        onSelect={(code) => setLanguage(code as any)} onClose={() => setLangModal(false)}
      />
      {pinModal && (
        <PinModal
          visible={true} mode={pinModal}
          onSubmit={handlePinSubmit}
          onClose={() => setPinModal(null)}
        />
      )}
    </LinearGradient>
  );
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
 return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, gap: 20 },
  pageHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  pageTitle: { fontSize: 18, fontWeight: "700", color: colors.textPrimary, fontFamily: "Inter_700Bold" },
  accountCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: colors.border, padding: 16, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
  accountAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primaryDim, borderWidth: 1.5, borderColor: colors.primary + "50", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  accountInitials: { fontSize: 20, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold" },
  accountName: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, fontFamily: "Inter_700Bold" },
  accountEmail: { fontSize: 12, color: colors.textMuted, fontFamily: "Inter_400Regular" },
  accountDotWrap: { alignItems: "center", justifyContent: "center" },
  accountDot: { width: 10, height: 10, borderRadius: 5 },
  section: { gap: 6 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 4 },
  sectionLabel: { fontSize: 10, fontWeight: "700", color: colors.textMuted, letterSpacing: 1.5, fontFamily: "Inter_700Bold" },
  sectionSubtitle: { fontSize: 10, color: colors.textMuted, fontFamily: "Inter_400Regular" },
  sectionCard: { backgroundColor: colors.bgCard, borderRadius: 18, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, fontSize: 14, color: colors.textPrimary, fontFamily: "Inter_500Medium" },
  rowValue: { fontSize: 12, color: colors.textMuted, fontFamily: "Inter_400Regular", maxWidth: 140 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold" },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  themePreview: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  themePreviewCopy: { flex: 1, gap: 3 },
  themePreviewTitle: { color: colors.textPrimary, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  themePreviewText: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_400Regular" },
  themePreviewCards: { width: 108, gap: 5 },
  themeMiniCard: { height: 31, borderRadius: 9, borderWidth: 1, paddingHorizontal: 7, flexDirection: "row", alignItems: "center", gap: 6 },
  themePicker: { flexDirection: "row", gap: 8, paddingVertical: 13 },
  themeChoice: { flex: 1, minHeight: 54, borderRadius: 13, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: 5 },
  themeChoiceText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  logoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.disconnected + "40", backgroundColor: colors.disconnectedDim },
  logoutText: { fontSize: 15, fontWeight: "600", color: colors.disconnected, fontFamily: "Inter_600SemiBold" },
  footer: { textAlign: "center", fontSize: 10, color: colors.textMuted, fontFamily: "Inter_400Regular", letterSpacing: 2 },
  // Lang modal
  modalOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: 20 },
  langSheet: { backgroundColor: colors.bgCard, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: colors.border },
  langSheetTitle: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, fontFamily: "Inter_700Bold", marginBottom: 14, textAlign: "center" },
  langRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 12 },
  langRowActive: { backgroundColor: colors.primaryDim },
  langFlag: { fontSize: 24 },
  langLabel: { flex: 1, fontSize: 15, color: colors.textPrimary, fontFamily: "Inter_500Medium" },
  // PIN modal
  pinSheet: { backgroundColor: colors.bgCard, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: colors.border, gap: 14 },
  pinTitle: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, fontFamily: "Inter_700Bold", textAlign: "center" },
  pinHint: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, fontFamily: "Inter_400Regular", textAlign: "center" },
  pinErr: { color: colors.disconnected, fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center" },
  pinInput: { backgroundColor: colors.bgInput, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, color: colors.textPrimary, fontSize: 20, fontFamily: "Inter_700Bold", textAlign: "center", letterSpacing: 8 },
  pinBtns: { flexDirection: "row", gap: 10, marginTop: 4 },
  pinBtnCancel: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: "center" },
  pinBtnCancelText: { color: colors.textMuted, fontFamily: "Inter_500Medium", fontSize: 14 },
  pinBtnOk: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.primaryDim, borderWidth: 1, borderColor: colors.primary + "40", alignItems: "center" },
  pinBtnOkText: { color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 },
 });
}

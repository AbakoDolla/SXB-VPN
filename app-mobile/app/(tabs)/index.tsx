import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState, Image, Modal, Pressable,
  ScrollView, Share, StyleSheet, Text, View, ActivityIndicator,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import apiClient from "@/services/apiClient";
import { useAuthContext } from "@/contexts/AuthContext";
import { useVpnContext, formatBytes, formatSpeed } from "@/contexts/VpnContext";
import { deriveQuota } from "@/services/quotaState";
import { useColors } from "@/hooks/useColors";
import UpdatePrompt from "@/components/UpdatePrompt";
import AnnouncementModal from "@/components/AnnouncementModal";
import { useTranslation } from "@/localization";
import type { VpnConnection } from "@/types/api";
import { alpha, elevation, layout, radius, spacing, type } from "@/constants/theme";
import PowerButton from "@/components/ui/PowerButton";
import ConfigPicker from "@/components/ui/ConfigPicker";
import {
  EmptyState,
  IconButton,
  Pill,
  ProgressBar,
  SectionHeader,
  StatRow,
  StatTile,
  Surface,
} from "@/components/ui/Primitives";
import { useConnectionDuration } from "@/hooks/useConnectionDuration";
import AccessNotices from "@/components/AccessNotices";
import FreeTrialCard from "@/components/FreeTrialCard";
import { blocksDevice } from "@/services/accessPolicy";

const LOGO = require("../../assets/images/icon.png");

// ── VPN Button States ─────────────────────────────────────────────────────────
type BtnState = "no_account" | "no_package" | "connect" | "connecting" | "connected" | "exhausted" | "expired" | "blocked";

function getButtonState(
  authenticated: boolean,
  isConnected: boolean,
  isConnecting: boolean,
  hasValidConfig: boolean,
  activeConnection: import("@/types/api").VpnConnection | null,
  quotaExhausted: boolean = false,
): BtnState {
  if (!authenticated) return "no_account";
  if (isConnecting) return "connecting";
  if (isConnected) return "connected";

  // Quota/expiry are displayed separately; a valid offline profile remains usable.
  if (hasValidConfig) return "connect";
  if (activeConnection?.status === "suspended" || activeConnection?.status === 'revoked') return 'blocked';
  return "no_package";
}

// ── VPN Connection Card ───────────────────────────────────────────────────────
function VpnConnectionCard({ conn, isActive }: { conn: VpnConnection; isActive: boolean }) {
  const now = Date.now();
  const isExpired  = conn.status === "expired" || (conn.expiresAt ? new Date(conn.expiresAt).getTime() < now : false);
  const isExhausted = conn.status === "exhausted";
  const isRevoked  = conn.status === "revoked";
  const isSuspended = conn.status === "suspended";

  const totalBytes = conn.quota.totalBytes || (conn.quota.totalGB * 1024 ** 3);
  const usedBytes = conn.quota.usedBytes || (conn.quota.usedGB * 1024 ** 3);
  const remainingBytes = conn.quota.totalBytes !== undefined ? Math.max(0, totalBytes - usedBytes) : (conn.quota.remainingGB * 1024 ** 3);

  const pct = totalBytes > 0 ? Math.min((usedBytes / totalBytes) * 100, 100) : 0;

  const { t } = useTranslation();
  const colors = useColors();
  const statusColor = isExpired || isExhausted || isRevoked || isSuspended
    ? colors.disconnected
    : isActive
    ? colors.connected
    : colors.primary;
  const statusLabel = isExhausted ? t('friendly_quota_exhausted') : isExpired ? t('expired') : isRevoked ? t('connection_revoked') : isSuspended ? t('suspended_status') : isActive ? t('active') : t('active');

  return (
    <Surface
      tone={isActive ? colors.connected : undefined}
      style={{ marginTop: spacing.md }}
    >
      <View style={styles.connHeader}>
        <View style={{ flex: 1, gap: spacing.xs }}>
          <Text style={[type.h3, { color: colors.textPrimary }]} numberOfLines={1}>{conn.name}</Text>
          <View style={styles.connProtoRow}>
            <Pill label={conn.displayProtocol} tone={statusColor} />
            {conn.displayProtocol !== conn.technicalProtocol.toUpperCase() && (
              <Text style={[type.micro, { color: colors.textMuted }]}>
                {conn.technicalProtocol.toUpperCase()}
              </Text>
            )}
          </View>
        </View>
        <Pill label={statusLabel} tone={statusColor} dot />
      </View>

      <StatRow>
        <StatTile label={t('quota_remaining')} value={formatBytes(remainingBytes)} tone={colors.connected} monospace />
        <StatTile label={t('quota_used')} value={formatBytes(usedBytes)} monospace />
        <StatTile label={t('quota_total')} value={formatBytes(totalBytes)} monospace />
      </StatRow>

      <ProgressBar progress={pct / 100} tone={statusColor} warnTone={colors.disconnected} />

      {conn.expiresAt && (
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {t('expires_on')} {new Date(conn.expiresAt).toLocaleDateString("fr-FR", { dateStyle: "medium" })}
        </Text>
      )}
    </Surface>
  );
}

// ── Main Home Screen ──────────────────────────────────────────────────────────
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { user, accountState, refreshAccountState, deviceId, isAuthenticated, deviceAccess } = useAuthContext();
  const {
    isConnected, isConnecting, selectedProtocol, connectedProtocol,
    hasValidConfig, activeConnection,
    connect, disconnect, trafficStats: traffic,
    refreshVpnConfig, syncFromConnection,
    savedConfigs, activeConfigId, switchConfig, isSwitchingConfig, quotaData, revokedStatus, perAppTraffic,
    deleteConfig,
  } = useVpnContext();
  const { t } = useTranslation();
  const activeQuotaSnapshot = quotaData && (!activeConfigId || quotaData.configId === activeConfigId)
    ? quotaData
    : (activeConnection as any)?.quota || null;
  const derivedQuota = deriveQuota(activeQuotaSnapshot || (accountState as any), traffic as any, isConnected);
  const connectedSeconds = useConnectionDuration(isConnected, traffic.connectedSeconds);

  const [configPickerVisible, setConfigPickerVisible] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [ping, setPing] = useState<number | null>(null);
  const [connections, setConnections] = useState<VpnConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [activeAnnouncement, setActiveAnnouncement] = useState<any>(null);

  const checkAnnouncements = React.useCallback(async () => {
    try {
      const res = await apiClient.get('/mobile/notifications');
      const data = Array.isArray(res.data) ? res.data : [];
      const ann = data.find((n: any) => n.isAnnouncement && n.type === 'critical');
      if (ann) {
        const seenStr = await AsyncStorage.getItem('@sxb_seen_announcements');
        const seenIds = JSON.parse(seenStr || '[]');
        if (!seenIds.includes(ann.id)) {
          setActiveAnnouncement(ann);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval>;
    if (isConnected) {
      const measurePing = async () => {
        const start = Date.now();
        try {
          await apiClient.get("/health", { timeout: 4000 });
          setPing(Date.now() - start);
        } catch {
          setPing(null);
        }
      };
      measurePing();
      // B12 — La latence n'a de sens que si l'écran est visible : le tick est
      // ignoré en arrière-plan et une mesure est relancée au retour.
      timerId = setInterval(() => {
        if (AppState.currentState !== "active") return;
        void measurePing();
      }, 10_000);
    } else {
      setPing(null);
    }
    return () => clearInterval(timerId);
  }, [isConnected]);

  const fetchConnections = React.useCallback(async () => {
    try {
      setConnectionsLoading(true);
      const res = await apiClient.get("/mobile/connections");
      const conns: VpnConnection[] = res.data?.connections || [];
      setConnections(conns);

      // Le statut `active` est celui du serveur et peut concerner plusieurs
      // abonnements. La sélection locale (`activeConfigId`) est l’autorité UI.
      const activeConn = conns.find(c => c.id === activeConfigId) || null;
      if (activeConn) syncFromConnection(activeConn);
    } catch {
      // ignore
    } finally {
      setConnectionsLoading(false);
    }
  }, [syncFromConnection, activeConfigId]);

  useEffect(() => {
    fetchConnections();
    checkAnnouncements();
  }, [fetchConnections, checkAnnouncements]);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshVpnConfig();
      await Promise.all([refreshAccountState(activeConfigId), fetchConnections()]);
    } catch (_) {
    } finally {
      setIsRefreshing(false);
    }
  };

  // Les animations du bouton (anneaux, respiration, appui) sont désormais
  // encapsulées dans `PowerButton`. L'écran ne conserve que l'état métier.
  const btnState = blocksDevice(deviceAccess) || revokedStatus !== 'none' ? 'blocked' :
    getButtonState(isAuthenticated, isConnected, isConnecting, hasValidConfig, activeConnection, derivedQuota.isExhausted);

  const formatTimer = (s: number) => {
    const h = Math.floor(s / 3600).toString().padStart(2, "0");
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  const handleVpnButton = async () => {
    if (blocksDevice(deviceAccess)) { router.push('/access-blocked'); return; }
    if (btnState === 'blocked') { setConfigPickerVisible(true); return; }
    if (btnState === "no_account") { router.push("/activate"); return; }
    if (btnState === "no_package" || btnState === "expired" || btnState === "exhausted") { router.push("/plan"); return; }
    if (btnState === "connect") {
      // Ne pas attendre la résolution réseau : connect() met l’interface en état
      // « connexion » immédiatement, puis poursuit le tunnel en arrière-plan.
      void connect();
    } else if (btnState === "connecting" || btnState === "connected") {
      // Le même bouton devient immédiatement une annulation/déconnexion.
      void disconnect();
    }
  };

  const btnColor = {
    no_account:  colors.primary,
    no_package:  colors.purple,
    connect:     colors.primary,
    connecting:  colors.warning,
    connected:   colors.connected,
    exhausted:   colors.disconnected,
    expired:     colors.disconnected,
    blocked:     colors.warning,
  }[btnState];

  const btnLabel = {
    no_account:  t('activate_account'),
    no_package:  t('activate_plan'),
    connect:     t('connect'),
    connecting:  t('cancel'),
    connected:   t('disconnect'),
    exhausted:   t('quota_exhausted'),
    expired:     t('expired_plan'),
    blocked:     t('access_choose_config'),
  }[btnState];

  const btnIcon = {
    no_account:  "key",
    no_package:  "gift",
    connect:     "shield-checkmark",
    connecting:  "shield",
    connected:   "power",
    exhausted:   "warning",
    expired:     "warning",
    blocked:     "pause",
  }[btnState] as keyof typeof Ionicons.glyphMap;

  // Message sous le bouton : il doit répondre à « que se passe-t-il ? » sans
  // que l'utilisateur ait à interpréter une couleur.
  const heroCaption = isConnected
    ? t('protection_active')
    : isConnecting
    ? t('connecting_status')
    : btnState === 'connect'
    ? t('tap_to_connect')
    : btnLabel;

  const protocolLabel = connectedProtocol
    || (activeConnection ? activeConnection.displayProtocol : null)
    || selectedProtocol
    || "—";

  const activeConfig = savedConfigs.find((cfg) => cfg.id === activeConfigId) || savedConfigs[0] || null;

  // ── L'accès actif provient-il d'un ESSAI GRATUIT ? ────────────────────────
  //
  // La réponse vient du SERVEUR et de lui seul : `/mobile/connections` marque
  // le forfait né d'une demande d'essai DÉPLOYÉE. On ne lit jamais le nom du
  // forfait (« Essai gratuit — … » est un libellé modifiable, et un forfait
  // ordinaire peut le porter) — c'est précisément le défaut corrigé côté
  // tableau de bord.
  //
  // Deux lectures du MÊME marqueur, jamais deux mécanismes : la connexion
  // distante quand l'application vient de se synchroniser, le registre local
  // — qui recopie cette même réponse — pour rester juste hors ligne.
  const isTrialAccess = activeConnection?.isFreeTrial === true || activeConfig?.isFreeTrial === true;

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <AnnouncementModal
        announcement={activeAnnouncement}
        onClose={async () => {
          if (activeAnnouncement) {
            const seenStr = await AsyncStorage.getItem('@sxb_seen_announcements');
            const seenIds = JSON.parse(seenStr || '[]');
            seenIds.push(activeAnnouncement.id);
            await AsyncStorage.setItem('@sxb_seen_announcements', JSON.stringify(seenIds));
          }
          setActiveAnnouncement(null);
        }}
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + spacing.sm,
            // La barre d'onglets flotte au-dessus du contenu : cette marge
            // garantit que la dernière carte reste entièrement atteignable.
            paddingBottom: insets.bottom + layout.tabBarClearance,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* En-tête : identité à gauche, actions à droite. */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[type.caption, { color: colors.textMuted }]}>{t('greeting_default')}</Text>
            <Text style={[type.h1, { color: colors.textPrimary }]} numberOfLines={1}>
              {user?.name || t('user_default')}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <IconButton
              icon="refresh"
              onPress={handleRefresh}
              disabled={isRefreshing}
              accessibilityLabel={t('refresh_config')}
            >
              {isRefreshing ? <ActivityIndicator size="small" color={colors.primary} /> : undefined}
            </IconButton>
            <IconButton
              icon="settings-outline"
              onPress={() => router.push("/settings")}
              accessibilityLabel={t('settings')}
            />
          </View>
        </View>

        <AccessNotices />
        {/* Only the selected configuration is blocked here, never the identity. */}
        {revokedStatus !== 'none' && (
          <Surface tone={colors.disconnected}>
            <View style={styles.bannerRow}>
              <Ionicons name="warning" size={22} color={colors.disconnected} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.h3, { color: colors.disconnected }]}>
                  {revokedStatus === 'exhausted' ? t('quota_exhausted') : revokedStatus === 'revoked' ? t('connection_revoked') : revokedStatus === 'suspended' ? t('connection_suspended') : revokedStatus === 'expired' ? t('connection_expired') : t('connection_disabled')}
                </Text>
                <Text style={[type.caption, { color: colors.textSecondary }]}>
                  {revokedStatus === 'exhausted' ? t('friendly_quota_exhausted') : revokedStatus === 'revoked' ? t('revocation_msg_revoked') : revokedStatus === 'suspended' ? t('revocation_msg_suspended') : revokedStatus === 'expired' ? t('revocation_msg_expired') : t('revocation_msg_disabled')}
                </Text>
              </View>
            </View>
          </Surface>
        )}

        {/* ── PÉRIODE D'ESSAI ─────────────────────────────────────────────
            Carte réservée aux accès issus d'un essai gratuit. Elle est placée
            avant tout le reste : c'est l'information qui change le sens de
            l'écran. Un appareil à ACCÈS COMPLET ne la monte jamais — son écran
            reste rigoureusement celui d'avant.

            La consommation vient de `derivedQuota`, exactement la même source
            que la carte « Quota du forfait » plus bas : aucune requête
            supplémentaire, aucun risque de deux chiffres divergents. */}
        {isTrialAccess && (
          <FreeTrialCard
            usedBytes={derivedQuota.usedBytes}
            remainingBytes={derivedQuota.remainingBytes}
            totalBytes={derivedQuota.totalBytes}
            usedRatio={derivedQuota.usedRatio}
            endsAt={derivedQuota.expiryDate ?? activeConnection?.expiresAt ?? null}
          />
        )}

        {/* Sélecteur de profils. Les pastilles sur une ligne devenaient
            illisibles au-delà de deux profils et ne permettaient aucune
            suppression : l'accueil n'affiche plus que le profil courant et
            ouvre une feuille dédiée pour gérer l'ensemble. */}
        {savedConfigs.length > 0 && (
          <Surface>
            <SectionHeader
              title={t('config_switch')}
              icon="swap-horizontal-outline"
              trailing={isSwitchingConfig ? <ActivityIndicator size="small" color={colors.primary} /> : undefined}
            />
            <Pressable
              onPress={() => setConfigPickerVisible(true)}
              accessibilityRole="button"
              accessibilityLabel={t('config_manage')}
              style={({ pressed }) => [
                styles.configCurrent,
                { borderColor: colors.border, backgroundColor: colors.bgCard2 },
                pressed && { opacity: 0.75 },
              ]}
            >
              <View style={[styles.configIcon, { backgroundColor: colors.primaryDim }]}>
                <Ionicons name="shield-checkmark" size={19} color={colors.primary} />
              </View>
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text style={[type.h3, { color: colors.textPrimary }]} numberOfLines={1}>
                  {activeConfig?.name || t('config_switch')}
                </Text>
                <Text style={[type.micro, { color: colors.textMuted }]} numberOfLines={1}>
                  {activeConfig?.protocol || '—'}
                  {savedConfigs.length > 1 ? ` · ${savedConfigs.length} ${t('config_plural')}` : ''}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          </Surface>
        )}

        {/* ── ZONE HÉROS ──────────────────────────────────────────────────
            Statut, bouton et informations vives forment un bloc unique : c'est
            la seule partie de l'écran qui doit être lisible à bout de bras. */}
        <View style={styles.hero}>
          {/* Conservée : c'est le seul endroit qui dit « Protection inactive ».
              La légende du bouton, elle, donne l'instruction (« Appuyez pour
              vous connecter »), pas l'état. */}
          <Pill
            label={isConnected ? t('protection_active') : isConnecting ? t('connecting_status') : t('protection_inactive')}
            tone={btnColor}
            dot
          />

          <PowerButton
            tone={btnColor}
            icon={btnIcon}
            caption={heroCaption}
            // Le service natif possède l'horloge autoritaire. Cette durée
            // continue pendant que l'app est en arrière-plan ou que React est
            // recréé ; l'ancien compteur JS repartait alors de 00:00:00.
            timer={isConnected ? formatTimer(connectedSeconds) : null}
            active={isConnected}
            busy={isConnecting}
            onPress={handleVpnButton}
            accessibilityLabel={btnLabel}
          />

          <Pressable
            onPress={handleVpnButton}
            accessibilityRole="button"
            accessibilityLabel={btnLabel}
            style={({ pressed }) => [
              styles.cta,
              { backgroundColor: btnColor },
              pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] },
            ]}
          >
            <Ionicons name={btnIcon} size={18} color={colors.primaryForeground} />
            <Text style={[type.h3, { color: colors.primaryForeground }]}>{btnLabel}</Text>
          </Pressable>

          {/* Bandeau vif : protocole et latence côte à côte, comme sur les
              applications VPN de référence, plutôt que noyés dans une liste.

              L'adresse de sortie n'y figure plus et n'est même plus demandée :
              l'afficher revenait à exposer en clair, sur l'écran principal, la
              donnée qui identifie le serveur derrière le tunnel. La durée de
              session est déjà lisible dans l'en-tête. */}
          <Surface style={styles.liveStrip} padded={false}>
            <StatRow>
              <StatTile label={t('info_protocol')} value={protocolLabel} icon="git-branch-outline" />
              <StatTile
                label={t('info_ping')}
                value={ping ? `${ping} ms` : "—"}
                icon="pulse-outline"
                tone={colors.connected}
                monospace
              />
            </StatRow>
          </Surface>

          {/* Les étapes et le flux brut vivent désormais dans l'écran unique de
              diagnostic : l'accueil ne conserve qu'un lien, ce qui l'allège et
              supprime le troisième emplacement où les journaux apparaissaient. */}
          <Pressable
            onPress={() => router.push("/diagnostics")}
            accessibilityRole="button"
            accessibilityLabel={t('diagnostic_title')}
            style={styles.logsLink}
          >
            <Ionicons name="pulse-outline" size={14} color={colors.primary} />
            <Text style={[type.captionMedium, { color: colors.primary }]}>
              {isConnecting ? t('logs_in_progress') : t('diagnostic_title')}
            </Text>
          </Pressable>
        </View>

        {/* ── QUOTA — Consomme deriveQuota (B1/B4) ────────────────────────── */}
        {derivedQuota.totalBytes > 0 && (
          <Surface>
            <SectionHeader title={t('card_quota_plan')} icon="cellular-outline" />
            {derivedQuota.isExhausted ? (
              <EmptyState icon="warning-outline" title={t('quota_exhausted')} description={t('quota_reload')} />
            ) : (
              <>
                <StatRow>
                  <StatTile label={t('quota_total')} value={derivedQuota.formattedTotal} monospace />
                  <StatTile label={t('quota_used')} value={derivedQuota.formattedUsed} monospace />
                  <StatTile
                    label={t('quota_remaining')}
                    value={derivedQuota.formattedRemaining}
                    tone={colors.connected}
                    monospace
                  />
                </StatRow>

                <ProgressBar
                  progress={derivedQuota.usedRatio}
                  tone={colors.primary}
                  warnTone={colors.disconnected}
                />

                <View style={styles.metaRow}>
                  <Text style={[type.caption, { color: colors.textMuted }]}>
                    {(derivedQuota.usedRatio * 100).toFixed(0)}% {t('quota_used')}
                  </Text>
                  {derivedQuota.expiryDate && (
                    <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
                      {t('config_expires_at')} {new Date(derivedQuota.expiryDate).toLocaleDateString("fr-FR", { dateStyle: "medium" })}
                    </Text>
                  )}
                </View>
              </>
            )}
          </Surface>
        )}

        {/* Trafic temps réel — visible seulement quand il y a du trafic à montrer. */}
        {isConnected && (
          <Surface>
            <SectionHeader
              title={t('card_traffic_realtime')}
              icon="swap-vertical-outline"
              trailing={<Pill label={t('protection_active')} tone={colors.connected} dot />}
            />
            <StatRow>
              <StatTile
                label={t('traffic_sent')}
                value={formatBytes(traffic.uploadBytes)}
                icon="arrow-up-outline"
                tone={colors.primary}
                monospace
              />
              <StatTile
                label={t('traffic_received')}
                value={formatBytes(traffic.downloadBytes)}
                icon="arrow-down-outline"
                tone={colors.connected}
                monospace
              />
            </StatRow>
            {/* Les débits instantanés sont séparés des volumes cumulés : ce sont
                deux natures de mesure, les mêler nuisait à la lecture. */}
            <View style={[styles.speedRow, { borderTopColor: colors.border }]}>
              <View style={styles.speedItem}>
                <Ionicons name="arrow-up" size={13} color={colors.primary} />
                <Text style={[type.captionMedium, { color: colors.textSecondary, fontVariant: ['tabular-nums' as const] }]}>
                  {formatSpeed(traffic.uploadSpeed)}
                </Text>
              </View>
              <View style={styles.speedItem}>
                <Ionicons name="arrow-down" size={13} color={colors.connected} />
                <Text style={[type.captionMedium, { color: colors.textSecondary, fontVariant: ['tabular-nums' as const] }]}>
                  {formatSpeed(traffic.downloadSpeed)}
                </Text>
              </View>
              <Text style={[type.micro, { color: colors.textMuted }]}>{t('traffic_speed')}</Text>
            </View>
          </Surface>
        )}

        {/* Consommation par application.

            La carte n'apparaît QUE lorsque le moteur natif rapporte réellement
            quelque chose. Auparavant elle occupait une carte entière pour
            annoncer « Aucune donnée applicative disponible » : à chaque
            connexion avant le premier relevé (~30 s), et en permanence là où le
            module natif n'expose pas `getPerAppStats`. Un bloc qui ne dit que
            son propre vide n'apprend rien ; la mesure elle-même est conservée
            intacte dès qu'elle existe. */}
        {isConnected && perAppTraffic && perAppTraffic.length > 0 && (
          <Surface>
            <SectionHeader title={t('card_traffic_per_app')} icon="apps-outline" />
            {perAppTraffic.map((appStat, index) => (
              <View
                key={`${appStat.packageName}-${index}`}
                style={[
                  styles.appRow,
                  index < perAppTraffic.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                  },
                ]}
              >
                <View style={{ flex: 1, paddingRight: spacing.sm }}>
                  <Text style={[type.bodyMedium, { color: colors.textPrimary }]} numberOfLines={1}>
                    {appStat.appName || appStat.packageName}
                  </Text>
                  <Text style={[type.micro, { color: colors.textMuted }]} numberOfLines={1}>
                    {appStat.packageName}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[type.h3, { color: colors.textPrimary, fontVariant: ['tabular-nums' as const] }]}>
                    {formatBytes(appStat.totalBytes)}
                  </Text>
                  <Text style={[type.micro, { color: colors.textMuted }]}>
                    ↑ {formatBytes(appStat.uploadBytes)} · ↓ {formatBytes(appStat.downloadBytes)}
                  </Text>
                </View>
              </View>
            ))}
          </Surface>
        )}

        {/* ── Connexions VPN ──────────────────────────────────────────────── */}
        <Surface>
          <SectionHeader
            title={t('vpn_connections')}
            icon="server-outline"
            trailing={
              <Pressable onPress={fetchConnections} disabled={connectionsLoading} hitSlop={10}>
                {connectionsLoading
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="refresh" size={16} color={colors.primary} />}
              </Pressable>
            }
          />
          {connections.length === 0 ? (
            <EmptyState
              icon="shield-outline"
              title={connectionsLoading ? t('loading') : t('no_vpn_connections')}
              description={t('ask_admin_for_plan')}
            />
          ) : (
            connections.map((conn) => (
              <VpnConnectionCard
                key={conn.id}
                conn={conn}
                isActive={conn.id === activeConfigId}
              />
            ))
          )}
        </Surface>

        {/* Accès rapides. « Historique » n'y figure plus : c'est un onglet
            permanent de la barre du bas, donc déjà à une seule touche depuis
            n'importe quel écran. Ne restent ici que les destinations qui n'ont
            pas d'onglet. */}
        <View style={styles.quickRow}>
          {[
            { icon: "gift-outline", label: t('activate_plan'), action: () => router.push("/plan"), color: colors.purple },
            { icon: "headset-outline", label: t('support'), action: () => router.push("/support"), color: colors.connected },
          ].map((item) => (
            <Pressable
              key={item.label}
              onPress={item.action}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              style={({ pressed }) => [
                styles.quickItem,
                { borderColor: colors.border, backgroundColor: colors.bgCard },
                pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
              ]}
            >
              <View style={[styles.quickIcon, { backgroundColor: item.color + alpha.f12 }]}>
                <Ionicons name={item.icon as any} size={19} color={item.color} />
              </View>
              <Text style={[type.micro, { color: colors.textSecondary }]} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Mention développeur. Elle vivait au bas de la carte « Informations de
            connexion », retirée : elle reste donc ici, au pied de l'accueil, et
            reprend la forme employée partout ailleurs dans l'application
            (« Powered by AbakoDollar$ », traduite comme le reste). */}
        <Text style={[styles.signature, { color: colors.textMuted }]} accessibilityRole="text">
          {t('created_by')}
        </Text>
      </ScrollView>

      <UpdatePrompt />

      <ConfigPicker
        visible={configPickerVisible}
        onClose={() => setConfigPickerVisible(false)}
        configs={savedConfigs}
        activeConfigId={activeConfigId}
        connections={connections}
        switching={isSwitchingConfig}
        onSelect={(id) => { setConfigPickerVisible(false); void switchConfig(id); }}
        onDelete={deleteConfig}
      />

    </LinearGradient>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: layout.screenPadding, gap: spacing.lg },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerActions: { flexDirection: "row", gap: spacing.sm },

  bannerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },

  // ── Zone héros ─────────────────────────────────────────────────────────────
  // Le rythme vertical y est plus généreux qu'ailleurs : cet espace vide est ce
  // qui distingue une interface premium d'un empilement de composants.
  hero: {
    alignItems: "center",
    gap: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing['3xl'],
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    minWidth: 220,
    ...elevation.sm,
  },
  liveStrip: { width: "100%", paddingVertical: spacing.lg, paddingHorizontal: spacing.md },
  logsLink: { flexDirection: "row", alignItems: "center", gap: spacing.sm },

  // ── Profils ────────────────────────────────────────────────────────────────
  configCurrent: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  configIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Cartes de données ──────────────────────────────────────────────────────
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  speedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  speedItem: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  appRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
  },

  // Signature discrète de l'auteur, volontairement très effacée : présente
  // sans jamais concurrencer l'information utile de l'écran. La couleur est
  // appliquée à l'usage, comme partout ailleurs dans ce fichier (la feuille de
  // styles est définie hors du composant, où le thème n'est pas accessible).
  signature: {
    marginTop: spacing.md,
    textAlign: "center",
    fontSize: 9,
    letterSpacing: 1.2,
    opacity: 0.35,
  },

  // ── Carte de connexion ─────────────────────────────────────────────────────
  connHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  connProtoRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },

  // ── Accès rapides ──────────────────────────────────────────────────────────
  quickRow: { flexDirection: "row", gap: spacing.md },
  quickItem: {
    flex: 1,
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  quickIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});

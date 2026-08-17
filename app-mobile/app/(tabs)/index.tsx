import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated, Dimensions, Image, Modal, Pressable,
  ScrollView, Share, StyleSheet, Text, View, ActivityIndicator,
  PermissionsAndroid, Platform,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import apiClient from "@/services/apiClient";
import { useAuthContext } from "@/contexts/AuthContext";
import { useVpnContext, formatBytes, formatSpeed } from "@/contexts/VpnContext";
import { deriveQuota } from "@/services/quotaState";
import Colors from "@/constants/colors";
import StepLogs from "@/components/StepLogs";
import UpdatePrompt from "@/components/UpdatePrompt";
import InteractiveWalkthrough from "@/components/InteractiveWalkthrough";
import AnnouncementModal from "@/components/AnnouncementModal";
import { useTranslation } from "@/localization";
import type { VpnConnection } from "@/types/api";

const { width } = Dimensions.get("window");
const LOGO = require("../../assets/images/icon.png");

// ── VPN Button States ─────────────────────────────────────────────────────────
type BtnState = "no_account" | "no_package" | "connect" | "connecting" | "connected" | "exhausted" | "expired";

function getButtonState(
  accountState: any,
  isConnected: boolean,
  isConnecting: boolean,
  hasValidConfig: boolean,
  activeConnection: import("@/types/api").VpnConnection | null,
  quotaExhausted: boolean = false,
): BtnState {
  if (!accountState) return "no_account";
  if (isConnecting) return "connecting";
  if (isConnected) return "connected";
  // Un profil local chiffré reste connectable hors-ligne : les états de quota
  // servent d'avertissement mais ne transforment pas le bouton en blocage.
  if (activeConnection && activeConnection.status === "active") return "connect";
  if (hasValidConfig) return "connect";
  if (quotaExhausted || accountState.state === "exhausted") return "exhausted";
  if (accountState.state === "expired") return "expired";
  const s = accountState.state;
  if (s === "no_package") return "no_package";
  if (s === "expired") return "expired";
  if (s === "exhausted") return "exhausted";
  return "connect";
}

// ── VPN Logs Modal — VRAIS LOGS du moteur sing-box ───────────────────────────
function VpnLogsModal({
  visible, onClose,
}: {
  visible: boolean; onClose: () => void;
}) {
  const { vpnLogs: logs, isConnected, isConnecting, selectedProtocol } = useVpnContext();
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visible && logs.length > 0) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    }
  }, [logs, visible]);

  const copyAllLogs = async () => {
const header = [
	      "═══ SXB VPN — Logs de diagnostic ═══",
	      `Date      : ${new Date().toISOString()}`,
	      `Protocole : ${selectedProtocol ?? "-"}`,
	      `État      : ${isConnected ? t("active") : isConnecting ? t("connecting") : t("inactive")}`,
	      `Lignes    : ${logs.length}`,
	      "────────────────────────────────────────",
	    ].join("\n");
    try {
      await Share.share({ message: `${header}\n${logs.join("\n")}`, title: "Logs SXB VPN" });
    } catch { /* ignore */ }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={logStyles.overlay}>
        <View style={logStyles.sheet}>
          <View style={logStyles.handle} />
          <View style={logStyles.header}>
            <View style={[logStyles.statusDot, { backgroundColor: isConnected ? Colors.connected : isConnecting ? Colors.primary : Colors.textMuted }]} />
            <Text style={logStyles.title}>{t('logs_engine_title')}</Text>
            <Pressable onPress={copyAllLogs} style={logStyles.copyBtn} disabled={logs.length === 0} accessibilityLabel={t('logs_copy_a11y')}>
              <Ionicons name="copy-outline" size={15} color={logs.length === 0 ? Colors.textMuted : Colors.primary} />
              <Text style={[logStyles.copyBtnText, logs.length === 0 && { color: Colors.textMuted }]}>{t('logs_copy_all')}</Text>
            </Pressable>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={logStyles.hint}>{t('logs_copy_hint')}</Text>
          <ScrollView
            ref={scrollRef}
            style={logStyles.logScroll}
            showsVerticalScrollIndicator={false}
          >
            {logs.length === 0 ? (
              <View style={logStyles.logLine}>
                <Text style={logStyles.logText}>{t('logs_waiting')}</Text>
              </View>
            ) : logs.map((line, i) => (
              <View key={i} style={logStyles.logLine}>
                <Text style={logStyles.logPrefix}>›</Text>
                <Text selectable style={[
                  logStyles.logText,
                  line.startsWith("✅") && { color: Colors.connected },
                  line.startsWith("❌") && { color: "#FF4444" },
                  line.startsWith("[engine]") && { color: Colors.primary },
                ]}>
                  {line}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── VPN Connection Card ───────────────────────────────────────────────────────
function VpnConnectionCard({ conn, isActive }: { conn: VpnConnection; isActive: boolean }) {
  const now = Date.now();
  const isExpired  = conn.status === "expired" || (conn.expiresAt ? new Date(conn.expiresAt).getTime() < now : false);
  const isExhausted = conn.status === "exhausted";
  const isRevoked  = conn.status === "revoked";
  const isSuspended = conn.status === "suspended";

  const statusColor = isExpired || isExhausted || isRevoked || isSuspended
    ? Colors.disconnected
    : isActive
    ? Colors.connected
    : Colors.primary;

  const totalBytes = conn.quota.totalBytes || (conn.quota.totalGB * 1024 ** 3);
  const usedBytes = conn.quota.usedBytes || (conn.quota.usedGB * 1024 ** 3);
  const remainingBytes = conn.quota.totalBytes !== undefined ? Math.max(0, totalBytes - usedBytes) : (conn.quota.remainingGB * 1024 ** 3);

  const pct = totalBytes > 0 ? Math.min((usedBytes / totalBytes) * 100, 100) : 0;

  const { t } = useTranslation();
  const statusLabel = isExhausted ? t('friendly_quota_exhausted') : isExpired ? t('expired') : isRevoked ? t('connection_revoked') : isSuspended ? t('suspended_status') : isActive ? t('active') : t('active');

  return (
    <View style={[connStyles.card, isActive && connStyles.cardActive]}>
      {/* Header */}
      <View style={connStyles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={connStyles.connName} numberOfLines={1}>{conn.name}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
            <View style={[connStyles.protoBadge, { borderColor: statusColor + "40", backgroundColor: statusColor + "15" }]}>
              <Text style={[connStyles.protoText, { color: statusColor }]}>{conn.displayProtocol}</Text>
            </View>
            {conn.displayProtocol !== conn.technicalProtocol.toUpperCase() && (
              <Text style={connStyles.techProto}>{conn.technicalProtocol.toUpperCase()}</Text>
            )}
          </View>
        </View>
        <View style={[connStyles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={[connStyles.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
      </View>

      {/* Quota */}
      <View style={connStyles.quotaRow}>
        <View style={connStyles.quotaItem}>
          <Text style={connStyles.quotaVal}>{formatBytes(remainingBytes)}</Text>
          <Text style={connStyles.quotaLbl}>{t('quota_remaining')}</Text>
        </View>
        <View style={connStyles.quotaDivider} />
        <View style={connStyles.quotaItem}>
          <Text style={connStyles.quotaVal}>{formatBytes(usedBytes)}</Text>
          <Text style={connStyles.quotaLbl}>{t('quota_used')}</Text>
        </View>
        <View style={connStyles.quotaDivider} />
        <View style={connStyles.quotaItem}>
          <Text style={connStyles.quotaVal}>{formatBytes(totalBytes)}</Text>
          <Text style={connStyles.quotaLbl}>{t('quota_total')}</Text>
        </View>
      </View>

      {/* Progress */}
      <View style={connStyles.progressBg}>
        <View style={[connStyles.progressFill, { width: `${pct}%` as any, backgroundColor: pct > 80 ? Colors.disconnected : statusColor }]} />
      </View>

      {/* Expiration */}
      {conn.expiresAt && (
        <Text style={connStyles.expire}>
          {t('expires_on')} {new Date(conn.expiresAt).toLocaleString()}
        </Text>
      )}
    </View>
  );
}

// ── Main Home Screen ──────────────────────────────────────────────────────────
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user, accountState, refreshAccountState, deviceId } = useAuthContext();
  const {
    isConnected, isConnecting, selectedProtocol, connectedProtocol,
    hasValidConfig, activeConnection,
    connect, disconnect, trafficStats: traffic,
    refreshVpnConfig, syncFromConnection,
    stepLogs, savedConfigs, activeConfigId, switchConfig, isSwitchingConfig, quotaData, revokedStatus, perAppTraffic,
  } = useVpnContext();
  const { t } = useTranslation();
  const [walkthroughVisible, setWalkthroughVisible] = useState(false);

  useEffect(() => {
    const checkWalkthrough = async () => {
      const done = await AsyncStorage.getItem("@walkthrough_done");
      if (!done && accountState?.state === 'ready') {
        // Attendre un peu pour que l'écran soit bien chargé
        setTimeout(() => setWalkthroughVisible(true), 1500);
      }
    };
    checkWalkthrough();
  }, [accountState]);

  const finishWalkthrough = async () => {
    await AsyncStorage.setItem("@walkthrough_done", "true");
    setWalkthroughVisible(false);
  };

  const derivedQuota = deriveQuota(quotaData || (accountState as any), traffic as any, isConnected);

  useEffect(() => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
    }
  }, []);

  const [logsVisible, setLogsVisible] = useState(false);
  const [timer, setTimer] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [ping, setPing] = useState<number | null>(null);
  const [connectedIp, setConnectedIp] = useState<string>("—");
  const [lastConnection, setLastConnection] = useState<string>("—");
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
      timerId = setInterval(measurePing, 10_000);
    } else {
      setPing(null);
    }
    return () => clearInterval(timerId);
  }, [isConnected]);

  useEffect(() => {
    if (isConnected) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      fetch("https://api.ipify.org?format=json", { signal: controller.signal })
        .then(res => res.json())
        .then((data: any) => {
          clearTimeout(timeoutId);
          setConnectedIp(data?.ip || "—");
        })
        .catch(() => setConnectedIp("—"));
    } else {
      setConnectedIp("—");
    }
  }, [isConnected]);

  useEffect(() => {
    if (isConnected) {
      const nowStr = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      setLastConnection(nowStr);
      AsyncStorage.setItem("@last_conn_time", nowStr).catch(() => {});
    }
  }, [isConnected]);

  useEffect(() => {
    AsyncStorage.getItem("@last_conn_time").then(t => {
      if (t) setLastConnection(t);
    });
  }, []);

  const fetchConnections = React.useCallback(async () => {
    try {
      setConnectionsLoading(true);
      const res = await apiClient.get("/mobile/connections");
      const conns: VpnConnection[] = res.data?.connections || [];
      setConnections(conns);

      const activeConn = conns.find(c => c.status === "active");
      if (activeConn) {
        syncFromConnection(activeConn);
      }
    } catch {
      // ignore
    } finally {
      setConnectionsLoading(false);
    }
  }, [syncFromConnection]);

  useEffect(() => {
    fetchConnections();
    checkAnnouncements();
  }, [fetchConnections, checkAnnouncements]);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await Promise.all([refreshVpnConfig(), refreshAccountState(), fetchConnections()]);
    } catch (_) {
    } finally {
      setIsRefreshing(false);
    }
  };

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim  = useRef(new Animated.Value(0.5)).current;
  const ring1     = useRef(new Animated.Value(1)).current;
  const ring2     = useRef(new Animated.Value(1)).current;
  const pressAnim = useRef(new Animated.Value(1)).current;

  const btnState = getButtonState(accountState, isConnected, isConnecting, hasValidConfig, activeConnection, derivedQuota.isExhausted);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.06, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ])
    );
    if (isConnected || isConnecting) anim.start();
    else { anim.stop(); pulseAnim.setValue(1); }
    return () => anim.stop();
  }, [isConnected, isConnecting]);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(ring1, { toValue: 1.4, duration: 2000, useNativeDriver: true }),
          Animated.timing(ring1, { toValue: 1,   duration: 2000, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.delay(700),
          Animated.timing(ring2, { toValue: 1.65, duration: 2200, useNativeDriver: true }),
          Animated.timing(ring2, { toValue: 1,    duration: 2200, useNativeDriver: true }),
        ]),
      ])
    );
    if (isConnected) anim.start();
    else { anim.stop(); ring1.setValue(1); ring2.setValue(1); }
    return () => anim.stop();
  }, [isConnected]);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0.5, duration: 1500, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isConnected) {
      interval = setInterval(() => setTimer((t) => t + 1), 1000);
    } else {
      setTimer(0);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isConnected]);

  const formatTimer = (s: number) => {
    const h = Math.floor(s / 3600).toString().padStart(2, "0");
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  const handleVpnButton = async () => {
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
    no_account:  Colors.primary,
    no_package:  Colors.purple,
    connect:     Colors.primary,
    connecting:  Colors.warning,
    connected:   Colors.connected,
    exhausted:   Colors.disconnected,
    expired:     Colors.disconnected,
  }[btnState];

  const btnLabel = {
    no_account:  t('activate_account'),
    no_package:  t('activate_plan'),
    connect:     t('connect'),
    connecting:  t('cancel'),
    connected:   t('disconnect'),
    exhausted:   t('quota_exhausted'),
    expired:     t('expired_plan'),
  }[btnState];

  const btnIcon = {
    no_account:  "key",
    no_package:  "gift",
    connect:     "shield-checkmark",
    connecting:  "shield",
    connected:   "power",
    exhausted:   "warning",
    expired:     "warning",
  }[btnState];

  const ringColor = isConnected
    ? "rgba(0,229,160,"
    : isConnecting
    ? "rgba(245,158,11,"
    : "rgba(0,212,255,";

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
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
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>{t('greeting_default')}</Text>
            <Text style={styles.userName}>{user?.name || t('user_default')}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Pressable onPress={handleRefresh} style={styles.notifBtn} disabled={isRefreshing}>
              {isRefreshing ? (
                <ActivityIndicator size="small" color={Colors.primary} />
              ) : (
                <Ionicons name="refresh" size={20} color={Colors.textSecondary} />
              )}
            </Pressable>
            <Pressable onPress={() => router.push("/settings")} style={styles.notifBtn}>
              <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        {/* Revocation Warning Banner */}
        {revokedStatus !== 'none' && (
          <View style={[styles.statsCard, { borderColor: Colors.disconnected + '60', backgroundColor: Colors.disconnectedDim }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name="warning" size={24} color={Colors.disconnected} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: Colors.disconnected, fontFamily: 'Inter_700Bold' }}>
                  {revokedStatus === 'exhausted' ? t('quota_exhausted') : revokedStatus === 'revoked' ? t('connection_revoked') : revokedStatus === 'suspended' ? t('connection_suspended') : revokedStatus === 'expired' ? t('connection_expired') : t('connection_disabled')}
                </Text>
                <Text style={{ fontSize: 12, color: Colors.textSecondary, fontFamily: 'Inter_400Regular', marginTop: 2 }}>
                  {revokedStatus === 'exhausted' ? t('friendly_quota_exhausted') : revokedStatus === 'revoked' ? t('revocation_msg_revoked') : revokedStatus === 'suspended' ? t('revocation_msg_suspended') : revokedStatus === 'expired' ? t('revocation_msg_expired') : t('revocation_msg_disabled')}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Saved Configs Selector */}
        {savedConfigs.length > 1 && (
          <View style={styles.statsCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.cardLabel}>{t('config_switch')}</Text>
              {isSwitchingConfig && <ActivityIndicator size="small" color={Colors.primary} />}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              {savedConfigs.map((cfg) => {
                const isRevokedOrExpired = connections.find(c => c.id === cfg.id)?.status === 'revoked' ||
                  connections.find(c => c.id === cfg.id)?.status === 'expired' ||
                  connections.find(c => c.id === cfg.id)?.status === 'exhausted' ||
                  connections.find(c => c.id === cfg.id)?.status === 'suspended';
                const isActive = cfg.id === activeConfigId;
                const isDisabled = isRevokedOrExpired && !isActive;
                return (
                  <Pressable
                    key={cfg.id}
                    onPress={() => !isSwitchingConfig && !isDisabled && switchConfig(cfg.id)}
                    disabled={isSwitchingConfig || isDisabled}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      paddingHorizontal: 12,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: isActive ? Colors.primary + '60' : isDisabled ? Colors.disconnected + '30' : Colors.border,
                      backgroundColor: isActive ? Colors.primaryDim : isDisabled ? Colors.bgCard + '60' : Colors.bgCard,
                      alignItems: 'center',
                      gap: 4,
                      opacity: isDisabled ? 0.5 : 1,
                    }}
                  >
                    {isSwitchingConfig && isActive ? (
                      <ActivityIndicator size="small" color={Colors.primary} />
                    ) : (
                      <Ionicons
                        name={isActive ? 'shield-checkmark' : 'shield-outline'}
                        size={18}
                        color={isDisabled ? Colors.disconnected : isActive ? Colors.primary : Colors.textMuted}
                      />
                    )}
                    <Text style={{ fontSize: 12, fontWeight: '600', color: isDisabled ? Colors.disconnected : isActive ? Colors.primary : Colors.textSecondary, fontFamily: 'Inter_600SemiBold' }} numberOfLines={1}>
                      {cfg.name}
                    </Text>
                    <Text style={{ fontSize: 10, color: Colors.textMuted, fontFamily: 'Inter_400Regular' }}>
                      {cfg.protocol}
                    </Text>
                    <View style={{
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 6,
                      backgroundColor: isDisabled ? Colors.disconnected + '15' : isActive ? Colors.connected + '20' : Colors.textMuted + '15',
                    }}>
                      <Text style={{ fontSize: 9, color: isDisabled ? Colors.disconnected : isActive ? Colors.connected : Colors.textMuted, fontFamily: 'Inter_600SemiBold' }}>
                        {isDisabled ? t('config_expired') : isActive ? t('config_active') : t('config_inactive')}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {/* VPN Button Area */}
        <View style={styles.vpnSection}>
          <View style={[styles.statusBadge, { borderColor: btnColor + "50", backgroundColor: btnColor + "10" }]}>
            <View style={[styles.statusDot, { backgroundColor: btnColor }]} />
            <Text style={[styles.statusText, { color: btnColor }]}>
              {isConnected ? t('protection_active') : isConnecting ? t('connecting_status') : t('protection_inactive')}
            </Text>
          </View>

          <View style={styles.btnWrap}>
            {(isConnected || isConnecting) && (
              <>
                <Animated.View style={[styles.ring, { borderColor: ringColor + "0.15)", transform: [{ scale: ring1 }] }]} />
                <Animated.View style={[styles.ring, { borderColor: ringColor + "0.08)", transform: [{ scale: ring2 }], width: 240, height: 240 }]} />
              </>
            )}

            <Animated.View style={[styles.btnGlow, { backgroundColor: btnColor + "18", opacity: glowAnim }]} />

            <Pressable
              onPress={handleVpnButton}
              disabled={isConnecting}
              onPressIn={() => Animated.spring(pressAnim, { toValue: 0.96, useNativeDriver: true, speed: 40, bounciness: 6 }).start()}
              onPressOut={() => Animated.spring(pressAnim, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 8 }).start()}
              accessibilityRole="button"
              accessibilityLabel={btnLabel}
            >
              <Animated.View style={[styles.vpnBtn, { borderColor: btnColor + "60", transform: [{ scale: Animated.multiply(pulseAnim, pressAnim) }] }]}>
                <LinearGradient
                  colors={[btnColor + "30", btnColor + "10"]}
                  style={styles.vpnBtnInner}
                >
                  <Ionicons name={btnIcon as any} size={44} color={btnColor} />
                </LinearGradient>
              </Animated.View>
            </Pressable>
          </View>

          {isConnected && (
            <Text style={styles.timer}>{formatTimer(timer)}</Text>
          )}

          <Text style={styles.btnHint}>
            {isConnected
              ? t('protection_active')
              : isConnecting
              ? t('connecting_status')
              : t('tap_to_connect')}
          </Text>

          <Pressable onPress={handleVpnButton} style={[styles.actionBtn, { backgroundColor: btnColor }]}>
            <Ionicons name={btnIcon as any} size={18} color="#000" />
            <Text style={[styles.actionBtnText, { color: "#000" }]}>{btnLabel}</Text>
          </Pressable>

          {(isConnecting || isConnected) && stepLogs.length > 0 && (
            <View style={{ width: '100%', marginTop: 8 }}>
              <StepLogs steps={stepLogs} visible={true} />
            </View>
          )}

          {(isConnecting || isConnected) && (
            <Pressable onPress={() => setLogsVisible(true)} style={styles.logsLink}>
              <Ionicons name="terminal-outline" size={14} color={Colors.primary} />
              <Text style={styles.logsLinkText}>{isConnecting ? t('logs_in_progress') : t('view_connection_logs')}</Text>
            </Pressable>
          )}
        </View>

        {/* ── QUOTA CARD — Consomme deriveQuota (B1/B4) ─────────────────── */}
        {derivedQuota.totalBytes > 0 && (
          <View style={styles.statsCard}>
            <Text style={styles.cardLabel}>{t('card_quota_plan')}</Text>
            {derivedQuota.isExhausted ? (
              <View style={{ alignItems: "center", paddingVertical: 8 }}>
                <Ionicons name="warning-outline" size={24} color={Colors.disconnected} />
                <Text style={{ fontSize: 14, fontWeight: "700", color: Colors.disconnected, fontFamily: "Inter_700Bold", marginTop: 4 }}>
                  {t('quota_exhausted')}
                </Text>
                <Text style={{ fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                  {t('quota_reload')}
                </Text>
              </View>
            ) : (
              <>
                <View style={connStyles.quotaRow}>
                  <View style={connStyles.quotaItem}>
                    <Text style={connStyles.quotaVal}>{derivedQuota.formattedTotal}</Text>
                    <Text style={connStyles.quotaLbl}>{t('quota_total')}</Text>
                  </View>
                  <View style={connStyles.quotaDivider} />
                  <View style={connStyles.quotaItem}>
                    <Text style={connStyles.quotaVal}>{derivedQuota.formattedUsed}</Text>
                    <Text style={connStyles.quotaLbl}>{t('quota_used')}</Text>
                  </View>
                  <View style={connStyles.quotaDivider} />
                  <View style={connStyles.quotaItem}>
                    <Text style={connStyles.quotaVal}>{derivedQuota.formattedRemaining}</Text>
                    <Text style={connStyles.quotaLbl}>{t('quota_remaining')}</Text>
                  </View>
                </View>

                {/* Progress bar */}
                <View style={styles.progressBg}>
                  <View style={[styles.progressFill, {
                    width: `${Math.min(derivedQuota.usedRatio * 100, 100)}%` as any,
                    backgroundColor: derivedQuota.usedRatio > 0.8 ? Colors.disconnected : Colors.primary
                  }]} />
                </View>

                <Text style={{ fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", textAlign: "center" }}>
                  {(derivedQuota.usedRatio * 100).toFixed(0)}% {t('quota_used')}
                </Text>

                {derivedQuota.expiryDate && (
                  <Text style={{ fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 4 }}>
                    {t('config_expires_at')} {new Date(derivedQuota.expiryDate).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" })}
                  </Text>
                )}
              </>
            )}
          </View>
        )}

        {/* Traffic stats card — affiché uniquement quand connecté */}
        {isConnected && (
          <View style={styles.statsCard}>
            <Text style={styles.cardLabel}>{t('card_traffic_realtime')}</Text>
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{formatBytes(traffic.uploadBytes)}</Text>
                <Text style={styles.statLabel}>↑ {t('traffic_sent')}</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{formatBytes(traffic.downloadBytes)}</Text>
                <Text style={styles.statLabel}>↓ {t('traffic_received')}</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { fontSize: 14 }]}>
                  ↑{formatSpeed(traffic.uploadSpeed)}{"\n"}↓{formatSpeed(traffic.downloadSpeed)}
                </Text>
                <Text style={styles.statLabel}>{t('traffic_speed')}</Text>
              </View>
            </View>
          </View>
        )}

        {/* Consommation par application */}
        {isConnected && (
          <View style={styles.statsCard}>
            <Text style={styles.cardLabel}>{t('card_traffic_per_app')}</Text>
            {perAppTraffic && perAppTraffic.length > 0 ? (
              perAppTraffic.map((appStat, index) => (
                <View
                  key={`${appStat.packageName}-${index}`}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingVertical: 8,
                    borderBottomWidth: index < perAppTraffic.length - 1 ? StyleSheet.hairlineWidth : 0,
                    borderBottomColor: Colors.border,
                  }}
                >
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={{ fontSize: 14, color: Colors.textPrimary, fontFamily: 'Inter_500Medium' }} numberOfLines={1}>
                      {appStat.appName || appStat.packageName}
                    </Text>
                    <Text style={{ fontSize: 11, color: Colors.textMuted, fontFamily: 'Inter_400Regular' }} numberOfLines={1}>
                      {appStat.packageName}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontSize: 13, color: Colors.textPrimary, fontFamily: 'Inter_600SemiBold' }}>
                      {formatBytes(appStat.totalBytes)}
                    </Text>
                    <Text style={{ fontSize: 11, color: Colors.textSecondary, fontFamily: 'Inter_400Regular' }}>
                      ↑ {formatBytes(appStat.uploadBytes)} · ↓ {formatBytes(appStat.downloadBytes)}
                    </Text>
                  </View>
                </View>
              ))
            ) : (
              <Text style={{ fontSize: 13, color: Colors.textMuted, paddingVertical: 8, fontFamily: 'Inter_400Regular' }}>
                {t('no_app_data')}
              </Text>
            )}
          </View>
        )}

        {/* Infos Connexion & Système */}
        <View style={styles.statsCard}>
          <Text style={styles.cardLabel}>{t('card_connection_info')}</Text>
          <View style={styles.infoGrid}>
            <View style={styles.infoRow}>
              <Text style={styles.infoKey}>{t('info_ip_address')}</Text>
              <Text style={styles.infoVal}>{connectedIp}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoKey}>{t('info_protocol')}</Text>
              <Text style={styles.infoVal}>
                {connectedProtocol
                  || (activeConnection ? activeConnection.displayProtocol : null)
                  || selectedProtocol
                  || "—"}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoKey}>{t('info_ping')}</Text>
              <Text style={styles.infoVal}>{ping ? `${ping} ms` : "—"}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoKey}>{t('info_last_conn')}</Text>
              <Text style={styles.infoVal}>{lastConnection}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoKey}>{t('app_version')}</Text>
              <Text style={styles.infoVal}>v{Constants.expoConfig?.version ?? "1.0.0"}</Text>
            </View>
          </View>
        </View>

        {/* ── VPN Connections ─────────────────────────────────────────── */}
        <View style={styles.statsCard}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={styles.cardLabel}>{t('vpn_connections')}</Text>
            <Pressable onPress={fetchConnections} disabled={connectionsLoading} style={{ padding: 4 }}>
              {connectionsLoading
                ? <ActivityIndicator size="small" color={Colors.primary} />
                : <Ionicons name="refresh" size={16} color={Colors.primary} />
              }
            </Pressable>
          </View>

          {connections.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 16 }}>
              <Ionicons name="shield-outline" size={32} color={Colors.textMuted} style={{ marginBottom: 8 }} />
              <Text style={{ fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular" }}>
                {connectionsLoading ? t('loading') : t('no_vpn_connections')}
              </Text>
              <Text style={{ fontSize: 11, color: Colors.textMuted, marginTop: 4, fontFamily: "Inter_400Regular" }}>
                {t('ask_admin_for_plan')}
              </Text>
            </View>
          ) : (
            connections.map((conn) => (
              <VpnConnectionCard
                key={conn.id}
                conn={conn}
                isActive={conn.status === "active"}
              />
            ))
          )}
        </View>

        {/* Quick actions */}
        <View style={styles.quickRow}>
          {[
            { icon: "gift-outline", label: t('activate_plan'), action: () => router.push("/plan"), color: Colors.purple },
            { icon: "time-outline", label: t('history'), action: () => router.push("/(tabs)/history"), color: Colors.primary },
            { icon: "headset-outline", label: t('support'), action: () => router.push("/support"), color: Colors.connected },
          ].map((item) => (
            <Pressable key={item.label} onPress={item.action} style={styles.quickItem}>
              <View style={[styles.quickIcon, { backgroundColor: item.color + "15", borderColor: item.color + "30" }]}>
                <Ionicons name={item.icon as any} size={20} color={item.color} />
              </View>
              <Text style={styles.quickLabel}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {/* Logs Modal */}
      <VpnLogsModal
        visible={logsVisible}
        onClose={() => setLogsVisible(false)}
      />

      <UpdatePrompt />

      <InteractiveWalkthrough 
        visible={walkthroughVisible} 
        onFinish={finishWalkthrough} 
      />
    </LinearGradient>
  );
}

const logStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(6,9,20,0.7)" },
  sheet: { backgroundColor: "#0A0F1C", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: "60%", minHeight: 300 },
  handle: { width: 36, height: 4, backgroundColor: Colors.border, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.connected },
  title: { flex: 1, fontSize: 16, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  copyBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: Colors.primary + "40", backgroundColor: Colors.primary + "15" },
  copyBtnText: { fontSize: 12, color: Colors.primary, fontFamily: "Inter_600SemiBold" },
  hint: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", marginBottom: 10 },
  logScroll: { flex: 1 },
  logLine: { flexDirection: "row", gap: 8, paddingVertical: 3 },
  logPrefix: { color: Colors.primary, fontFamily: "Inter_700Bold", fontSize: 13 },
  logText: { fontSize: 13, color: Colors.textSecondary, fontFamily: "Inter_400Regular", flex: 1 },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 16 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
  greeting: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  userName: { fontSize: 20, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  notifBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  vpnSection: { alignItems: "center", paddingVertical: 24, gap: 16 },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 13, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  btnWrap: { width: 200, height: 200, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: 190, height: 190, borderRadius: 95, borderWidth: 1 },
  btnGlow: { position: "absolute", width: 170, height: 170, borderRadius: 85 },
  vpnBtn: { width: 150, height: 150, borderRadius: 75, borderWidth: 2, overflow: "hidden" },
  vpnBtnInner: { flex: 1, alignItems: "center", justifyContent: "center" },
  timer: { fontSize: 32, fontWeight: "700", color: Colors.connected, fontFamily: "Inter_700Bold", letterSpacing: 2 },
  btnHint: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular", textAlign: "center" },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 16 },
  actionBtnText: { fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" },
  logsLink: { flexDirection: "row", alignItems: "center", gap: 6 },
  logsLinkText: { fontSize: 12, color: Colors.primary, fontFamily: "Inter_500Medium" },
  statsCard: { backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 12 },
  cardLabel: { fontSize: 10, fontWeight: "700", color: Colors.textMuted, letterSpacing: 1.5, fontFamily: "Inter_700Bold" },
  infoGrid: { gap: 8, marginTop: 4 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  infoKey: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  infoVal: { fontSize: 13, color: "#FFF", fontFamily: "Inter_600SemiBold" },
  statsRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statItem: { flex: 1, alignItems: "center", gap: 4 },
  statDivider: { width: 1, height: 36, backgroundColor: Colors.border },
  statValue: { fontSize: 20, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  statLabel: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  progressBg: { height: 4, backgroundColor: Colors.border, borderRadius: 2 },
  progressFill: { height: 4, borderRadius: 2 },
  expireText: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  protoCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, padding: 14, gap: 10 },
  protoRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  protoLabel: { flex: 1, fontSize: 13, color: Colors.textSecondary, fontFamily: "Inter_400Regular" },
  protoBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: Colors.primaryDim, borderWidth: 1, borderColor: Colors.primary + "40" },
  protoBadgeText: { fontSize: 11, fontWeight: "700", color: Colors.primary, fontFamily: "Inter_700Bold" },
  quickRow: { flexDirection: "row", gap: 10 },
  quickItem: { flex: 1, alignItems: "center", gap: 8 },
  quickIcon: { width: 52, height: 52, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  quickLabel: { fontSize: 11, color: Colors.textSecondary, fontFamily: "Inter_500Medium", textAlign: "center" },
});

// ── VPN Connection Card Styles ────────────────────────────────────────────────
const connStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.bgCard,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    gap: 10,
    marginTop: 10,
  },
  cardActive: {
    borderColor: Colors.primary + "30",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  connName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#FFF",
    fontFamily: "Inter_600SemiBold",
    flex: 1,
  },
  protoBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  protoText: {
    fontSize: 10,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  techProto: {
    fontSize: 10,
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 6,
  },
  statusLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    marginTop: 4,
  },
  quotaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  quotaItem: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  quotaDivider: {
    width: 1,
    height: 28,
    backgroundColor: Colors.border,
  },
  quotaVal: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFF",
    fontFamily: "Inter_700Bold",
  },
  quotaLbl: {
    fontSize: 10,
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
  },
  progressBg: {
    height: 3,
    backgroundColor: Colors.border,
    borderRadius: 2,
  },
  progressFill: {
    height: 3,
    borderRadius: 2,
  },
  expire: {
    fontSize: 11,
    color: Colors.textMuted,
    fontFamily: "Inter_400Regular",
    textAlign: "right",
  },
});

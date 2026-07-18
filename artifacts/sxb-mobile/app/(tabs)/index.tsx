import React, { useEffect, useRef, useState } from "react";
import {
  Animated, Dimensions, Image, Modal, Pressable,
  ScrollView, StyleSheet, Text, View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuthContext } from "@/contexts/AuthContext";
import { useVpnContext } from "@/contexts/VpnContext";
import Colors from "@/constants/colors";

const { width } = Dimensions.get("window");
const LOGO = require("../../assets/images/icon.png");

// ── VPN Button States ─────────────────────────────────────────────────────────
type BtnState = "no_account" | "no_package" | "connect" | "connecting" | "connected" | "expired";

function getButtonState(
  accountState: any,
  isConnected: boolean,
  isConnecting: boolean,
  subscriptionUrl: string | null,
): BtnState {
  if (!accountState) return "no_account";
  if (isConnecting) return "connecting";
  if (isConnected) return "connected";
  // Si une configuration est déjà importée → connexion directe sans forfait obligatoire
  if (subscriptionUrl) return "connect";
  const s = accountState.state;
  if (s === "no_package") return "no_package";
  if (s === "expired") return "expired";
  return "connect";
}

// ── VPN Logs Modal ────────────────────────────────────────────────────────────
function VpnLogsModal({
  visible, onClose, isConnecting, isConnected, protocol,
}: {
  visible: boolean; onClose: () => void;
  isConnecting: boolean; isConnected: boolean; protocol: string | null;
}) {
  const [logs, setLogs] = useState<string[]>([]);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!visible) { setLogs([]); return; }

    const STEPS = isConnecting
      ? [
          "Initialisation du tunnel VPN...",
          "Vérification du compte...",
          "Validation du forfait...",
          "Récupération de la configuration sécurisée...",
          `Détection du protocole ${protocol || "VPN"}...`,
          "Préparation du moteur tunnel...",
          "Établissement de la connexion...",
          "Authentification...",
          isConnected ? "✅ Protection active" : "Connexion établie...",
        ]
      : ["✅ VPN connecté — trafic chiffré", `Protocole : ${protocol || "VPN"}`, "Votre identité est protégée."];

    let i = 0;
    const interval = setInterval(() => {
      if (i < STEPS.length) {
        setLogs((prev) => [...prev, STEPS[i]]);
        i++;
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
      } else {
        clearInterval(interval);
      }
    }, 420);
    return () => clearInterval(interval);
  }, [visible, isConnecting, isConnected, protocol]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={logStyles.overlay}>
        <View style={logStyles.sheet}>
          <View style={logStyles.handle} />
          <View style={logStyles.header}>
            <View style={logStyles.statusDot} />
            <Text style={logStyles.title}>Logs de connexion</Text>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </Pressable>
          </View>
          <ScrollView
            ref={scrollRef}
            style={logStyles.logScroll}
            showsVerticalScrollIndicator={false}
          >
            {logs.map((line, i) => (
              <View key={i} style={logStyles.logLine}>
                <Text style={logStyles.logPrefix}>›</Text>
                <Text style={[logStyles.logText, line.startsWith("✅") && { color: Colors.connected }]}>
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

// ── Main Home Screen ──────────────────────────────────────────────────────────
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user, accountState, refreshAccountState } = useAuthContext();
  const { isConnected, isConnecting, selectedProtocol, subscriptionUrl, connect, disconnect } = useVpnContext();

  const [logsVisible, setLogsVisible] = useState(false);
  const [timer, setTimer] = useState(0);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim  = useRef(new Animated.Value(0.5)).current;
  const ring1     = useRef(new Animated.Value(1)).current;
  const ring2     = useRef(new Animated.Value(1)).current;

  const btnState = getButtonState(accountState, isConnected, isConnecting, subscriptionUrl);

  // Pulse animation
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

  // Ring animation when connected
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

  // Glow
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

  // Timer when connected
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
    if (btnState === "no_package" || btnState === "expired") { router.push("/plan"); return; }
    if (btnState === "connect") {
      setLogsVisible(true);
      await connect();
      await refreshAccountState();
    } else if (btnState === "connected") {
      await disconnect();
      await refreshAccountState();
    }
  };

  // Button style based on state
  const btnColor = {
    no_account:  Colors.primary,
    no_package:  Colors.purple,
    connect:     Colors.primary,
    connecting:  Colors.warning,
    connected:   Colors.connected,
    expired:     Colors.disconnected,
  }[btnState];

  const btnLabel = {
    no_account:  "Activer mon compte",
    no_package:  "Activer un forfait",
    connect:     "Se connecter",
    connecting:  "Connexion...",
    connected:   "Déconnecter",
    expired:     "Forfait expiré",
  }[btnState];

  const btnIcon = {
    no_account:  "power",
    no_package:  "power",
    connect:     "power",
    connecting:  "power",
    connected:   "power",
    expired:     "power",
  }[btnState];

  const ringColor = isConnected
    ? "rgba(0,229,160,"
    : isConnecting
    ? "rgba(245,158,11,"
    : "rgba(0,212,255,";

  const quota = accountState
    ? {
        total:  Math.round(accountState.quotaTotalGb ?? 0),
        used:   Math.round(accountState.quotaUsedGb ?? 0),
        remain: Math.round(accountState.quotaRemainingGb ?? 0),
      }
    : null;

  const quotaPct = quota && quota.total > 0
    ? Math.min((quota.used / quota.total) * 100, 100)
    : 0;

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>Bonjour 👋</Text>
            <Text style={styles.userName}>{user?.name || "Utilisateur"}</Text>
          </View>
          <Pressable onPress={() => router.push("/settings")} style={styles.notifBtn}>
            <Ionicons name="settings-outline" size={20} color={Colors.textSecondary} />
          </Pressable>
        </View>

        {/* VPN Button Area */}
        <View style={styles.vpnSection}>
          {/* Status label */}
          <View style={[styles.statusBadge, { borderColor: btnColor + "50", backgroundColor: btnColor + "10" }]}>
            <View style={[styles.statusDot, { backgroundColor: btnColor }]} />
            <Text style={[styles.statusText, { color: btnColor }]}>
              {isConnected ? "Protection active" : isConnecting ? "Connexion en cours..." : "Protection inactive"}
            </Text>
          </View>

          {/* Big Button */}
          <View style={styles.btnWrap}>
            {/* Outer ambient ring — always visible */}
            <Animated.View style={[styles.ring, {
              borderColor: ringColor + "0.10)",
              width: 260, height: 260, borderRadius: 130,
              transform: [{ scale: isConnected ? ring2 : 1 }],
            }]} />

            {/* Inner pulse ring */}
            <Animated.View style={[styles.ring, {
              borderColor: ringColor + (isConnected ? "0.22)" : "0.13)"),
              transform: [{ scale: isConnected || isConnecting ? ring1 : 1 }],
            }]} />

            {/* Glow */}
            <Animated.View style={[styles.btnGlow, { backgroundColor: btnColor + "22", opacity: glowAnim }]} />

            {/* Main button */}
            <Pressable onPress={handleVpnButton} disabled={isConnecting}>
              <Animated.View style={[styles.vpnBtn, {
                borderColor: btnColor + (isConnected ? "90" : "55"),
                borderWidth: isConnected ? 3 : 2,
                transform: [{ scale: pulseAnim }],
                shadowColor: btnColor,
                shadowOpacity: isConnected ? 0.6 : 0.3,
                shadowRadius: isConnected ? 30 : 16,
                shadowOffset: { width: 0, height: 0 },
                elevation: isConnected ? 20 : 8,
              }]}>
                <LinearGradient
                  colors={[btnColor + "35", btnColor + "10", "transparent"]}
                  style={styles.vpnBtnInner}
                >
                  {/* Outer power ring inside button */}
                  <View style={[styles.powerRingOuter, { borderColor: btnColor + "40" }]} />
                  <Ionicons
                    name={isConnecting ? "hourglass-outline" : "power"}
                    size={52}
                    color={btnColor}
                  />
                </LinearGradient>
              </Animated.View>
            </Pressable>
          </View>

          {/* Timer */}
          {isConnected && (
            <Text style={styles.timer}>{formatTimer(timer)}</Text>
          )}

          {/* Subtitle */}
          <Text style={styles.btnHint}>
            {isConnected
              ? "Votre connexion est sécurisée"
              : isConnecting
              ? "Établissement du tunnel sécurisé..."
              : btnState === "no_account"
              ? "Appuyez pour activer votre compte"
              : btnState === "no_package"
              ? "Appuyez pour activer un forfait"
              : btnState === "expired"
              ? "Forfait expiré — appuyez pour renouveler"
              : "Appuyez pour activer la protection"}
          </Text>

          {/* Logs link */}
          {(isConnecting || isConnected) && (
            <Pressable onPress={() => setLogsVisible(true)} style={styles.logsLink}>
              <Ionicons name="terminal-outline" size={14} color={Colors.primary} />
              <Text style={styles.logsLinkText}>Voir les logs de connexion</Text>
            </Pressable>
          )}
        </View>

        {/* Stats Row */}
        {quota && quota.total > 0 && (
          <View style={styles.statsCard}>
            <Text style={styles.cardLabel}>QUOTA DU FORFAIT</Text>
            <View style={styles.statsRow}>
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{quota.remain} GB</Text>
                <Text style={styles.statLabel}>Restant</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{quota.used} GB</Text>
                <Text style={styles.statLabel}>Utilisé</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statItem}>
                <Text style={styles.statValue}>{quota.total} GB</Text>
                <Text style={styles.statLabel}>Total</Text>
              </View>
            </View>
            {/* Progress bar */}
            <View style={styles.progressBg}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${quotaPct}%` as any,
                    backgroundColor: quotaPct > 80 ? Colors.disconnected : Colors.primary,
                  },
                ]}
              />
            </View>
            {accountState?.expireAt && (
              <Text style={styles.expireText}>
                Expire le {new Date(accountState.expireAt).toLocaleDateString("fr-FR")}
              </Text>
            )}
          </View>
        )}

        {/* Protocol section */}
        {accountState && accountState.state === "ready" && (
          <View style={styles.protoCard}>
            <Text style={styles.cardLabel}>CONNEXION</Text>
            <View style={styles.protoRow}>
              <Ionicons name="globe-outline" size={16} color={Colors.textMuted} />
              <Text style={styles.protoLabel}>Protocole actif</Text>
              <View style={styles.protoBadge}>
                <Text style={styles.protoBadgeText}>{selectedProtocol || "AUTO"}</Text>
              </View>
            </View>
          </View>
        )}

        {/* Quick actions */}
        <View style={styles.quickRow}>
          {[
            { icon: "gift-outline", label: "Activer un forfait", action: () => router.push("/plan"), color: Colors.purple },
            { icon: "time-outline", label: "Historique", action: () => router.push("/(tabs)/history"), color: Colors.primary },
            { icon: "headset-outline", label: "Support", action: () => router.push("/support"), color: Colors.connected },
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
        isConnecting={isConnecting}
        isConnected={isConnected}
        protocol={selectedProtocol}
      />
    </LinearGradient>
  );
}

const logStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(6,9,20,0.7)" },
  sheet: { backgroundColor: "#0A0F1C", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: "60%", minHeight: 300 },
  handle: { width: 36, height: 4, backgroundColor: Colors.border, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.connected },
  title: { flex: 1, fontSize: 16, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
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
  btnWrap: { width: 280, height: 280, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: 210, height: 210, borderRadius: 105, borderWidth: 1 },
  btnGlow: { position: "absolute", width: 200, height: 200, borderRadius: 100 },
  vpnBtn: { width: 175, height: 175, borderRadius: 88, overflow: "hidden" },
  vpnBtnInner: { flex: 1, alignItems: "center", justifyContent: "center", position: "relative" },
  powerRingOuter: { position: "absolute", width: 155, height: 155, borderRadius: 78, borderWidth: 1 },
  timer: { fontSize: 30, fontWeight: "700", color: Colors.connected, fontFamily: "Inter_700Bold", letterSpacing: 2 },
  btnHint: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular", textAlign: "center", paddingHorizontal: 24 },
  logsLink: { flexDirection: "row", alignItems: "center", gap: 6 },
  logsLinkText: { fontSize: 12, color: Colors.primary, fontFamily: "Inter_500Medium" },
  statsCard: { backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 16, gap: 12 },
  cardLabel: { fontSize: 10, fontWeight: "700", color: Colors.textMuted, letterSpacing: 1.5, fontFamily: "Inter_700Bold" },
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

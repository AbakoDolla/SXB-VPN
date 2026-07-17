import React, { useRef, useState } from "react";
import {
  Animated, Image, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { useAuthContext } from "@/contexts/AuthContext";
import Colors from "@/constants/colors";

const LOGO = require("@/assets/images/icon.png");

export default function ActivateScreen() {
  const insets = useSafeAreaInsets();
  const { activateAccount, isAuthenticated, deviceId } = useAuthContext();

  const [token, setToken]       = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]       = useState("");
  const [success, setSuccess]   = useState(false);
  const [copied, setCopied]     = useState(false);

  const successScale = useRef(new Animated.Value(0)).current;
  const shakeAnim    = useRef(new Animated.Value(0)).current;

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const copyDeviceId = async () => {
    if (!deviceId) return;
    await Clipboard.setStringAsync(deviceId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleActivate = async () => {
    if (!token.trim()) { setError("Entrez votre token SXB-USER-XXXX"); shake(); return; }
    setError(""); setIsLoading(true);
    try {
      await activateAccount(token.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSuccess(true);
      Animated.spring(successScale, { toValue: 1, tension: 80, friction: 6, useNativeDriver: true }).start();
      setTimeout(() => router.replace("/(tabs)/"), 1500);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      shake();
      const status = err?.response?.status;
      if (status === 404) setError("Token introuvable. Vérifiez le code.");
      else if (status === 403) setError("Token expiré ou déjà utilisé.");
      else setError("Erreur réseau. Réessayez.");
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Animated.View style={[styles.successWrap, { transform: [{ scale: successScale }] }]}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark-circle" size={72} color={Colors.connected} />
          </View>
          <Text style={styles.successTitle}>Compte activé !</Text>
          <Text style={styles.successSub}>Bienvenue sur SXB VPN</Text>
        </Animated.View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: 40 }]} showsVerticalScrollIndicator={false}>
        {/* Back */}
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={Colors.textSecondary} />
        </Pressable>

        {/* Icon */}
        <View style={styles.iconWrap}>
          <View style={styles.iconCircle}>
            <Ionicons name="key" size={52} color={Colors.primary} />
          </View>
        </View>

        <Text style={styles.title}>Activer mon compte</Text>
        <Text style={styles.subtitle}>Entrez votre token utilisateur pour accéder à SXB VPN</Text>

        {/* Input */}
        <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
          <TextInput
            style={[styles.input, error && { borderColor: Colors.disconnected }]}
            placeholder="SXB-USER-XXXX-XXXX-XXXX"
            placeholderTextColor={Colors.textMuted}
            value={token}
            onChangeText={(t) => { setToken(t.toUpperCase()); setError(""); }}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleActivate}
          />
        </Animated.View>

        {error ? (
          <View style={styles.errorWrap}>
            <Ionicons name="alert-circle" size={14} color={Colors.disconnected} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Activate button */}
        <Pressable onPress={handleActivate} disabled={isLoading} style={[styles.activateBtn, isLoading && { opacity: 0.6 }]}>
          <LinearGradient colors={[Colors.primary, "#0080FF"]} style={styles.activateBtnGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
            {isLoading
              ? <Text style={styles.activateBtnText}>Activation...</Text>
              : <>
                  <Ionicons name="shield-checkmark" size={18} color="#000" />
                  <Text style={styles.activateBtnText}>Activer</Text>
                </>
            }
          </LinearGradient>
        </Pressable>

        {/* Device ID avec bouton copier */}
        {deviceId ? (
          <View style={styles.deviceBox}>
            <View style={styles.deviceBoxHeader}>
              <Ionicons name="phone-portrait-outline" size={13} color={Colors.primary} />
              <Text style={styles.deviceBoxLabel}>ID de votre appareil</Text>
              <Pressable onPress={copyDeviceId} style={styles.copyBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons
                  name={copied ? "checkmark" : "copy-outline"}
                  size={15}
                  color={copied ? Colors.connected : Colors.primary}
                />
                <Text style={[styles.copyText, copied && { color: Colors.connected }]}>
                  {copied ? "Copié !" : "Copier"}
                </Text>
              </Pressable>
            </View>
            <View style={styles.deviceIdRow}>
              <Text style={styles.deviceId} selectable>{deviceId}</Text>
            </View>
            <Text style={styles.deviceHint}>Communiquez cet ID à votre administrateur pour obtenir votre token.</Text>
          </View>
        ) : null}

        {/* Separator */}
        <View style={styles.sep}>
          <View style={styles.sepLine} />
          <Text style={styles.sepText}>ou</Text>
          <View style={styles.sepLine} />
        </View>

        {/* QR placeholder */}
        <Pressable style={styles.qrBtn}>
          <Ionicons name="qr-code-outline" size={20} color={Colors.textSecondary} />
          <Text style={styles.qrBtnText}>Scanner un QR Code</Text>
        </Pressable>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 24, gap: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  iconWrap: { alignItems: "center", paddingVertical: 16 },
  iconCircle: { width: 110, height: 110, borderRadius: 55, backgroundColor: Colors.primaryDim, borderWidth: 1, borderColor: Colors.primary + "40", alignItems: "center", justifyContent: "center" },
  title: { fontSize: 26, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", textAlign: "center" },
  subtitle: { fontSize: 14, color: Colors.textSecondary, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  input: { backgroundColor: Colors.bgInput, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 14, paddingHorizontal: 18, paddingVertical: 16, fontSize: 15, color: "#FFF", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textAlign: "center" },
  errorWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  errorText: { fontSize: 13, color: Colors.disconnected, fontFamily: "Inter_500Medium" },
  activateBtn: { borderRadius: 16, overflow: "hidden" },
  activateBtnGrad: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 16 },
  activateBtnText: { fontSize: 16, fontWeight: "700", color: "#000", fontFamily: "Inter_700Bold" },
  deviceBox: { backgroundColor: Colors.bgCard, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, padding: 14, gap: 8 },
  deviceBoxHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  deviceBoxLabel: { fontSize: 12, color: Colors.primary, fontFamily: "Inter_600SemiBold", flex: 1 },
  copyBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: Colors.primaryDim, borderWidth: 1, borderColor: Colors.primary + "40" },
  copyText: { fontSize: 11, color: Colors.primary, fontFamily: "Inter_600SemiBold" },
  deviceIdRow: { backgroundColor: Colors.bgInput, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  deviceId: { fontSize: 13, color: "#FFF", fontFamily: "Inter_700Bold", letterSpacing: 1 },
  deviceHint: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", lineHeight: 17 },
  sep: { flexDirection: "row", alignItems: "center", gap: 10 },
  sepLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  sepText: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
  qrBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard },
  qrBtnText: { fontSize: 14, color: Colors.textSecondary, fontFamily: "Inter_500Medium" },
  successWrap: { alignItems: "center", gap: 16 },
  successIcon: { width: 120, height: 120, borderRadius: 60, backgroundColor: Colors.connectedDim, borderWidth: 1, borderColor: Colors.connected + "40", alignItems: "center", justifyContent: "center" },
  successTitle: { fontSize: 28, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  successSub: { fontSize: 15, color: Colors.textSecondary, fontFamily: "Inter_400Regular" },
});

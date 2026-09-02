import React, { useMemo, useRef, useState } from "react";
import {
  Alert, Animated, Image, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

const LOGO = require("../assets/images/icon.png");

export default function ActivateScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { activateAccount, deviceId } = useAuthContext();

  const [token, setToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const successScale = useRef(new Animated.Value(0.86)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const shake = () => Animated.sequence([
    Animated.timing(shakeAnim, { toValue: 10, duration: 55, useNativeDriver: true }),
    Animated.timing(shakeAnim, { toValue: -10, duration: 55, useNativeDriver: true }),
    Animated.timing(shakeAnim, { toValue: 5, duration: 55, useNativeDriver: true }),
    Animated.timing(shakeAnim, { toValue: 0, duration: 55, useNativeDriver: true }),
  ]).start();

  const handleActivate = async () => {
    const normalized = token.trim();
    if (!normalized) {
      setError(t("error_invalid_token"));
      shake();
      return;
    }
    setError("");
    setIsLoading(true);
    try {
      await activateAccount(normalized);
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSuccess(true);
      Animated.timing(successScale, { toValue: 1, duration: 280, useNativeDriver: true }).start();
      setTimeout(() => router.replace("/(tabs)/" as any), 1100);
    } catch (err: any) {
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      shake();
      const status = err?.response?.status;
      if (status === 404) setError(t("token_not_found"));
      else if (status === 403) setError(t("error_expired_token"));
      else setError(t("network_error"));
    } finally {
      setIsLoading(false);
    }
  };

  const copyDeviceId = async () => {
    if (!deviceId) return;
    const { setStringAsync } = await import("expo-clipboard");
    await setStringAsync(deviceId);
    if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Copié", "L’identifiant de cet appareil est maintenant dans le presse-papiers.");
  };

  if (success) {
    return (
      <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
        <View style={styles.successScreen}>
          <Animated.View style={[styles.successOrb, { transform: [{ scale: successScale }] }]}>
            <Ionicons name="shield-checkmark" size={58} color={colors.connected} />
          </Animated.View>
          <Text style={styles.successTitle}>{t("activation_success")}</Text>
          <Text style={styles.successSub}>{t("onboarding_title_1")}</Text>
          <View style={styles.successPill}>
            <View style={[styles.successDot, { backgroundColor: colors.connected }]} />
            <Text style={styles.successPillText}>Session sécurisée</Text>
          </View>
        </View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 28 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.topBar}>
            <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]} accessibilityLabel={t("back")}>
              <Ionicons name="arrow-back" size={20} color={colors.textSecondary} />
            </Pressable>
            <Text style={styles.topBarLabel}>SXB VPN</Text>
            <View style={styles.iconButtonPlaceholder} />
          </View>

          <View style={styles.brandBlock}>
            <View style={styles.logoHalo}>
              <Image source={LOGO} style={styles.logo} resizeMode="contain" />
            </View>
            <Text style={styles.eyebrow}>{t("activate_secure_badge")}</Text>
            <Text style={styles.title}>{t("activate_account_title")}</Text>
            <Text style={styles.subtitle}>{t("activate_account_desc")}</Text>
          </View>

          <View style={styles.formCard}>
            <View style={styles.formHeader}>
              <View style={styles.formIcon}><Ionicons name="key-outline" size={19} color={colors.primary} /></View>
              <View style={styles.formHeaderCopy}>
                <Text style={styles.formTitle}>{t("activate_token_title")}</Text>
                <Text style={styles.formHint}>{t("activate_token_hint")}</Text>
              </View>
            </View>

            <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
              <TextInput
                style={[styles.input, error && { borderColor: colors.disconnected }]}
                placeholder={t("token_user_placeholder")}
                placeholderTextColor={colors.textMuted}
                value={token}
                onChangeText={(value) => { setToken(value.toUpperCase()); setError(""); }}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleActivate}
                accessibilityLabel="Token d’activation"
              />
            </Animated.View>

            {error ? (
              <View style={styles.errorWrap}>
                <Ionicons name="alert-circle" size={16} color={colors.disconnected} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : (
              <Text style={styles.secureHint}><Ionicons name="lock-closed-outline" size={12} color={colors.textMuted} />  {t("activate_token_secure")}</Text>
            )}

            <Pressable
              onPress={handleActivate}
              disabled={isLoading}
              style={({ pressed }) => [styles.primaryButton, isLoading && styles.disabled, pressed && !isLoading && styles.pressedLarge]}
            >
              <LinearGradient colors={colors.gradients.primary as [string, string]} style={styles.primaryButtonInner}>
                <Ionicons name={isLoading ? "sync" : "shield-checkmark-outline"} size={19} color={colors.primaryForeground} />
                <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>{isLoading ? t("activating") : t("activate_btn")}</Text>
              </LinearGradient>
            </Pressable>
          </View>

          {deviceId ? (
            <View style={styles.deviceCard}>
              <View style={styles.deviceIcon}><Ionicons name="phone-portrait-outline" size={18} color={colors.primary} /></View>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceLabel}>{t("device_id")}</Text>
                <Text style={styles.deviceValue} numberOfLines={1} ellipsizeMode="middle">{deviceId}</Text>
              </View>
              <Pressable onPress={copyDeviceId} style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]} accessibilityLabel={t("device_id")}>
                <Ionicons name="copy-outline" size={17} color={colors.primary} />
                <Text style={styles.copyText}>{t("copy")}</Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={styles.footer}>{t("activate_footer")}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({
    container: { flex: 1 },
    content: { paddingHorizontal: 20, gap: 16 },
    topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    topBarLabel: { color: colors.textMuted, fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 1.4 },
    iconButton: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.bgCard + "D9", borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    iconButtonPlaceholder: { width: 40 },
    pressed: { opacity: 0.68, transform: [{ scale: 0.97 }] },
    pressedLarge: { transform: [{ scale: 0.985 }] },
    brandBlock: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
    logoHalo: { width: 82, height: 82, borderRadius: 28, backgroundColor: colors.primaryDim, borderWidth: 1, borderColor: colors.primary + "45", alignItems: "center", justifyContent: "center", marginBottom: 18, shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
    logo: { width: 62, height: 62, borderRadius: 18 },
    eyebrow: { color: colors.primary, fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.8, marginBottom: 8 },
    title: { color: colors.textPrimary, fontSize: 28, lineHeight: 34, fontFamily: "Inter_700Bold", textAlign: "center" },
    subtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8, maxWidth: 340 },
    formCard: { backgroundColor: colors.bgCard + "F2", borderWidth: 1, borderColor: colors.border, borderRadius: 24, padding: 18, gap: 14, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 7 },
    formHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
    formIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" },
    formHeaderCopy: { flex: 1, gap: 2 },
    formTitle: { color: colors.textPrimary, fontSize: 15, fontFamily: "Inter_700Bold" },
    formHint: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular" },
    input: { backgroundColor: colors.bgInput, borderWidth: 1, borderColor: colors.border2, borderRadius: 15, paddingHorizontal: 15, paddingVertical: 16, color: colors.textPrimary, fontSize: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 1.2, textAlign: "center" },
    errorWrap: { flexDirection: "row", alignItems: "center", gap: 7 },
    errorText: { color: colors.disconnected, fontSize: 12, flex: 1, fontFamily: "Inter_500Medium" },
    secureHint: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular", textAlign: "center" },
    primaryButton: { borderRadius: 15, overflow: "hidden" },
    primaryButtonInner: { minHeight: 53, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, paddingHorizontal: 15 },
    primaryButtonText: { fontSize: 15, fontFamily: "Inter_700Bold" },
    disabled: { opacity: 0.6 },
    deviceCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.bgCard + "CC", borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 13 },
    deviceIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" },
    deviceCopy: { flex: 1, gap: 3 },
    deviceLabel: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.8 },
    deviceValue: { color: colors.textPrimary, fontSize: 12, fontFamily: "Inter_600SemiBold" },
    copyButton: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.primaryDim, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 8 },
    copyText: { color: colors.primary, fontSize: 11, fontFamily: "Inter_700Bold" },
    footer: { color: colors.textMuted, textAlign: "center", fontSize: 10, fontFamily: "Inter_400Regular", letterSpacing: 0.8, paddingVertical: 4 },
    successScreen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 },
    successOrb: { width: 136, height: 136, borderRadius: 46, backgroundColor: colors.connectedDim, borderWidth: 1, borderColor: colors.connected + "55", alignItems: "center", justifyContent: "center", shadowColor: colors.connected, shadowOpacity: 0.28, shadowRadius: 30, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
    successTitle: { color: colors.textPrimary, fontSize: 25, fontFamily: "Inter_700Bold", textAlign: "center" },
    successSub: { color: colors.textSecondary, fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
    successPill: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: colors.connectedDim, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8, marginTop: 6 },
    successDot: { width: 7, height: 7, borderRadius: 4 },
    successPillText: { color: colors.connected, fontSize: 11, fontFamily: "Inter_600SemiBold" },
  });
}

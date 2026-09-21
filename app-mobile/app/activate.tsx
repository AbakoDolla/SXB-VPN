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
import { useResponsive } from "@/hooks/useResponsive";
import { useTranslation, type TranslationKey } from "@/localization";
import { activationErrorKey, normalizeActivationToken } from "@/services/activationError";
import SupportTelegramButton from "@/components/SupportTelegramButton";
import LanguageToggle from "@/components/ui/LanguageToggle";
import { alpha, elevation, radius, responsiveLayout, spacing, type } from "@/constants/theme";

const LOGO = require("../assets/images/icon.png");

export default function ActivateScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const responsive = useResponsive();
  const styles = useMemo(() => makeStyles(colors, responsive), [colors, responsive]);
  const insets = useSafeAreaInsets();
  const { activateAccount, deviceId, hasSeenOnboarding } = useAuthContext();

  const [token, setToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | "">("");
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
    const normalized = normalizeActivationToken(token);
    if (!normalized) {
      setErrorKey("error_invalid_token");
      shake();
      return;
    }
    setErrorKey("");
    setIsLoading(true);
    try {
      await activateAccount(normalized);
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSuccess(true);
      Animated.timing(successScale, { toValue: 1, duration: 280, useNativeDriver: true }).start();
      // Le guide a besoin d'un compte activé pour présenter les vraies notions
      // de configuration, quota et connexion. Il est donc la première étape
      // post-activation, et non un écran promotionnel avant le token.
      setTimeout(
        () => router.replace((hasSeenOnboarding ? "/(tabs)/" : "/onboarding") as any),
        1100,
      );
    } catch (err: any) {
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      shake();
      setErrorKey(activationErrorKey(err));
    } finally {
      setIsLoading(false);
    }
  };

  const copyDeviceId = async () => {
    if (!deviceId) return;
    const { setStringAsync } = await import("expo-clipboard");
    await setStringAsync(deviceId);
    if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert(t("logs_copied"), t("device_id_copied_body"));
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
            <Text style={styles.topBarLabel}>{t("app_name")}</Text>
            <LanguageToggle />
          </View>

          <View style={styles.brandBlock}>
            <View style={styles.logoHalo}>
              <Image source={LOGO} style={styles.logo} resizeMode="contain" />
            </View>
            <Text style={styles.eyebrow}>{t("activate_secure_badge")}</Text>
            <Text style={styles.title}>{t("activate_account_title")}</Text>
            <Text style={styles.subtitle}>{t("activate_account_desc")}</Text>
            <Pressable accessibilityRole="link" onPress={() => router.push('/privacy')}>
              <Text style={{ color: colors.primary }}>{t('privacy_title')}</Text>
            </Pressable>
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
                style={[styles.input, errorKey && { borderColor: colors.disconnected }]}
                placeholder={t("token_user_placeholder")}
                placeholderTextColor={colors.textMuted}
                value={token}
                onChangeText={(value) => { setToken(value.toUpperCase()); setErrorKey(""); }}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleActivate}
                accessibilityLabel="Token d’activation"
              />
            </Animated.View>

            {errorKey ? (
              <View style={styles.errorWrap}>
                <Ionicons name="alert-circle" size={16} color={colors.disconnected} />
                <Text style={styles.errorText}>{t(errorKey)}</Text>
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

          {/* Section distincte « ESSAI GRATUIT » : un jeton d'essai n'est pas un
              token d'activation et ne doit jamais être saisi dans le champ
              ci-dessus, qui attend un compte déjà provisionné. */}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/free-trial' as any)}
            style={({ pressed }) => [styles.trialCard, pressed && styles.pressed]}
          >
            <View style={styles.trialIcon}><Ionicons name="gift-outline" size={18} color={colors.primary} /></View>
            <View style={styles.trialCopy}>
              <Text style={styles.trialLabel}>{t("free_trial_badge")}</Text>
              <Text style={styles.trialText}>{t("free_trial_entry")}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </Pressable>

          {/* L'utilisateur bloqué ici n'a pas encore de compte : le canal
              Telegram est son seul recours immédiat, avant tout ticket. */}
          <SupportTelegramButton />

          <Text style={styles.footer}>{t("activate_footer")}</Text>
          <Text style={styles.footer}>{t("created_by")}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>, responsive: ReturnType<typeof useResponsive>) {
  return StyleSheet.create({
    container: { flex: 1 },
    content: { paddingHorizontal: responsive.screenPadding, gap: responsive.gap + 4, width: "100%", maxWidth: responsiveLayout.contentMaxWidth, alignSelf: "center" },
    topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    topBarLabel: { color: colors.textMuted, fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 1.4 },
    iconButton: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: colors.bgCard + "D9", borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    iconButtonPlaceholder: { width: 40 },
    pressed: { opacity: 0.68, transform: [{ scale: 0.97 }] },
    pressedLarge: { transform: [{ scale: 0.985 }] },
    brandBlock: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
    logoHalo: { width: 82, height: 82, borderRadius: radius.xl, backgroundColor: colors.primaryDim, borderWidth: 1, borderColor: colors.primary + "45", alignItems: "center", justifyContent: "center", marginBottom: 18, shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
    logo: { width: 62, height: 62, borderRadius: radius.lg },
    eyebrow: { color: colors.primary, fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.8, marginBottom: 8 },
    title: { color: colors.textPrimary, ...type.h1, fontSize: 28, lineHeight: 34, textAlign: "center" },
    subtitle: { color: colors.textSecondary, ...type.body, lineHeight: 21, textAlign: "center", marginTop: 8, maxWidth: 340 },
    formCard: { backgroundColor: colors.bgCard + "F2", borderWidth: 1, borderColor: colors.border, borderRadius: radius.xl, padding: responsive.cardPadding, gap: spacing.md, ...elevation.md },
    formHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
    formIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" },
    formHeaderCopy: { flex: 1, gap: 2 },
    formTitle: { color: colors.textPrimary, ...type.h3, fontFamily: "Inter_700Bold" },
    formHint: { color: colors.textMuted, ...type.caption, fontSize: 11 },
    input: { backgroundColor: colors.bgInput, borderWidth: 1, borderColor: colors.border2, borderRadius: radius.md, paddingHorizontal: 15, paddingVertical: 16, color: colors.textPrimary, fontSize: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 1.2, textAlign: "center" },
    errorWrap: { flexDirection: "row", alignItems: "center", gap: 7 },
    errorText: { color: colors.disconnected, fontSize: 12, flex: 1, fontFamily: "Inter_500Medium" },
    secureHint: { color: colors.textMuted, ...type.caption, fontSize: 11, textAlign: "center" },
    primaryButton: { borderRadius: radius.md, overflow: "hidden" },
    primaryButtonInner: { minHeight: 53, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: 15 },
    primaryButtonText: { ...type.h3, fontFamily: "Inter_700Bold" },
    disabled: { opacity: 0.6 },
    deviceCard: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm, backgroundColor: colors.bgCard + "CC", borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 13 },
    deviceIcon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" },
    deviceCopy: { flex: 1, gap: 3 },
    deviceLabel: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.8 },
    deviceValue: { color: colors.textPrimary, fontSize: 12, fontFamily: "Inter_600SemiBold" },
    copyButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.xs, backgroundColor: colors.primaryDim, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8 },
    copyText: { color: colors.primary, ...type.overline, fontFamily: "Inter_700Bold" },
    trialCard: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.bgCard + "CC", borderWidth: 1, borderColor: colors.primary + "45", borderRadius: radius.lg, padding: 13 },
    trialIcon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" },
    trialCopy: { flex: 1, gap: 2 },
    trialLabel: { color: colors.primary, fontSize: 9, fontFamily: "Inter_700Bold", letterSpacing: 1.4 },
    trialText: { color: colors.textPrimary, ...type.bodyMedium, fontSize: 13, fontFamily: "Inter_600SemiBold" },
    footer: { color: colors.textMuted, textAlign: "center", fontSize: 10, fontFamily: "Inter_400Regular", letterSpacing: 0.8, paddingVertical: 4 },
    successScreen: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing["2xl"], gap: 14 },
    successOrb: { width: 136, height: 136, borderRadius: radius["2xl"], backgroundColor: colors.connectedDim, borderWidth: 1, borderColor: colors.connected + "55", alignItems: "center", justifyContent: "center", shadowColor: colors.connected, shadowOpacity: 0.28, shadowRadius: 30, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
    successTitle: { color: colors.textPrimary, ...type.h1, textAlign: "center" },
    successSub: { color: colors.textSecondary, ...type.body, textAlign: "center" },
    successPill: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.connectedDim, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 8, marginTop: 6 },
    successDot: { width: 7, height: 7, borderRadius: radius.full },
    successPillText: { color: colors.connected, ...type.overline, letterSpacing: 0 },
  });
}

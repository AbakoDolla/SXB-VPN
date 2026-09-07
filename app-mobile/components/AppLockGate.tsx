import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppLock } from "@/contexts/AppLockContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

export function AppLockGate({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const {
    isReady,
    isLocked,
    isAuthenticating,
    preferences,
    unlockWithBiometrics,
    unlockWithPin,
  } = useAppLock();
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const promptedForCurrentLock = useRef(false);
  const gateVisible = !isReady || isLocked;

  const authenticate = useCallback(async () => {
    setMessage("");
    const unlocked = await unlockWithBiometrics(
      t("app_lock_biometric_prompt"),
      t("cancel"),
    ).catch(() => false);
    if (!unlocked) setMessage(t("app_lock_biometric_failed"));
  }, [t, unlockWithBiometrics]);

  useEffect(() => {
    if (!isLocked) {
      promptedForCurrentLock.current = false;
      setPin("");
      setMessage("");
      return;
    }
    if (
      isReady
      && preferences.biometricsEnabled
      && AppState.currentState === "active"
      && !promptedForCurrentLock.current
    ) {
      promptedForCurrentLock.current = true;
      void authenticate();
    }
  }, [authenticate, isLocked, isReady, preferences.biometricsEnabled]);

  useEffect(() => {
    if (!isLocked) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [isLocked]);

  const submitPin = async () => {
    try {
      const result = await unlockWithPin(pin);
      if (result.success) return;
      setPin("");
      setMessage(
        result.reason === "throttled"
          ? t("app_lock_pin_throttled")
          : t("app_lock_pin_invalid"),
      );
    } catch {
      setMessage(t("app_lock_storage_error"));
    }
  };

  return (
    <View style={styles.root}>
      <View
        style={styles.root}
        importantForAccessibility={gateVisible ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={gateVisible}
      >
        {children}
      </View>
      {gateVisible && (
        <LinearGradient
          colors={colors.gradients.bg as [string, string, string]}
          style={[
            styles.overlay,
            { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
          ]}
          accessibilityViewIsModal
          accessibilityLabel={t("app_lock_title")}
        >
          {!isReady ? (
            <ActivityIndicator
              color={colors.primary}
              size="large"
              accessibilityLabel={t("app_lock_loading")}
            />
          ) : (
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              style={styles.content}
            >
              <View style={styles.iconWrap}>
                <Ionicons name="shield-checkmark" size={42} color={colors.primary} />
              </View>
              <Text style={styles.title} accessibilityRole="header">
                {t("app_lock_title")}
              </Text>
              <Text style={styles.subtitle}>{t("app_lock_subtitle")}</Text>

              <View style={styles.card}>
                {message ? (
                  <Text style={styles.error} accessibilityRole="alert">
                    {message}
                  </Text>
                ) : null}
                <Text style={styles.inputLabel}>{t("app_lock_pin_label")}</Text>
                <TextInput
                  value={pin}
                  onChangeText={(value) => {
                    setPin(value.replace(/\D/g, ""));
                    setMessage("");
                  }}
                  onSubmitEditing={() => { void submitPin(); }}
                  style={styles.input}
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={8}
                  placeholder="••••"
                  placeholderTextColor={colors.textMuted}
                  accessibilityLabel={t("app_lock_pin_label")}
                  autoComplete="off"
                />
                <Pressable
                  onPress={() => { void submitPin(); }}
                  disabled={pin.length < 4}
                  accessibilityRole="button"
                  accessibilityLabel={t("app_lock_unlock")}
                  accessibilityState={{ disabled: pin.length < 4 }}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pin.length < 4 && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>{t("app_lock_unlock")}</Text>
                </Pressable>
                {preferences.biometricsEnabled && (
                  <Pressable
                    onPress={() => { void authenticate(); }}
                    disabled={isAuthenticating}
                    accessibilityRole="button"
                    accessibilityLabel={t("app_lock_use_biometrics")}
                    accessibilityState={{ busy: isAuthenticating }}
                    style={({ pressed }) => [
                      styles.biometricButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    {isAuthenticating ? (
                      <ActivityIndicator color={colors.primary} />
                    ) : (
                      <Ionicons name="finger-print" size={22} color={colors.primary} />
                    )}
                    <Text style={styles.biometricButtonText}>
                      {t("app_lock_use_biometrics")}
                    </Text>
                  </Pressable>
                )}
              </View>
              <Text style={styles.notice}>{t("app_lock_vpn_notice")}</Text>
            </KeyboardAvoidingView>
          )}
        </LinearGradient>
      )}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({
    root: { flex: 1 },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 10_000,
      elevation: 10_000,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      backgroundColor: colors.bg,
    },
    content: { width: "100%", maxWidth: 440, alignItems: "center" },
    iconWrap: {
      width: 82,
      height: 82,
      borderRadius: 28,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primaryDim,
      borderWidth: 1,
      borderColor: colors.primary + "55",
      marginBottom: 20,
    },
    title: {
      color: colors.textPrimary,
      fontFamily: "Inter_700Bold",
      fontSize: 25,
      textAlign: "center",
    },
    subtitle: {
      color: colors.textSecondary,
      fontFamily: "Inter_400Regular",
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
      marginTop: 8,
      marginBottom: 24,
    },
    card: {
      width: "100%",
      padding: 20,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bgCard,
      gap: 12,
    },
    error: {
      color: colors.disconnected,
      fontFamily: "Inter_500Medium",
      fontSize: 13,
      lineHeight: 18,
      textAlign: "center",
    },
    inputLabel: {
      color: colors.textSecondary,
      fontFamily: "Inter_600SemiBold",
      fontSize: 12,
    },
    input: {
      minHeight: 54,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border2,
      backgroundColor: colors.bgInput,
      color: colors.textPrimary,
      fontFamily: "Inter_700Bold",
      fontSize: 22,
      letterSpacing: 10,
      textAlign: "center",
      paddingHorizontal: 16,
    },
    primaryButton: {
      minHeight: 52,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primary,
    },
    primaryButtonText: {
      color: colors.bg,
      fontFamily: "Inter_700Bold",
      fontSize: 15,
    },
    biometricButton: {
      minHeight: 50,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.primary + "55",
      backgroundColor: colors.primaryDim,
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "row",
      gap: 9,
    },
    biometricButtonText: {
      color: colors.primary,
      fontFamily: "Inter_600SemiBold",
      fontSize: 14,
    },
    notice: {
      color: colors.textMuted,
      fontFamily: "Inter_400Regular",
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
      marginTop: 18,
      maxWidth: 360,
    },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.72 },
  });
}

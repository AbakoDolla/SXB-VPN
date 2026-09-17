import React, { useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useResponsive } from "@/hooks/useResponsive";
import { useTranslation } from "@/localization";
import { activationErrorKey } from "@/services/activationError";
import { radius, responsiveLayout, spacing } from "@/constants/theme";

export default function PlanScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { activatePlan } = useAuthContext();
  // Cet écran importait le module statique `Colors` : il restait sombre même
  // quand l'utilisateur avait choisi le thème clair — le seul de l'application
  // à se comporter ainsi, et la règle est déjà épinglée par un test ailleurs.
  const colors = useColors();
  const responsive = useResponsive();
  const styles = useMemo(() => makeStyles(colors, responsive), [colors, responsive]);

  const [token, setToken]       = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]       = useState("");
  const [success, setSuccess]   = useState(false);

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

  const handleActivate = async () => {
    if (!token.trim()) { setError(t("token_data_placeholder")); shake(); return; }
    setError(""); setIsLoading(true);
    try {
      await activatePlan(token.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSuccess(true);
      Animated.spring(successScale, { toValue: 1, tension: 80, friction: 6, useNativeDriver: true }).start();
      setTimeout(() => router.replace("/(tabs)/" as any), 1600);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      shake();
      setError(t(activationErrorKey(err)));
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Animated.View style={[{ alignItems: "center", gap: spacing.lg }, { transform: [{ scale: successScale }] }]}>
          <View style={[styles.iconCircle, { backgroundColor: colors.connectedDim, borderColor: colors.connected + "40" }]}>
            <Ionicons name="checkmark-circle" size={72} color={colors.connected} />
          </View>
          <Text style={{ fontSize: 26, fontWeight: "700", color: colors.textPrimary, fontFamily: "Inter_700Bold" }}>{t("plan_success")}</Text>
          <Text style={{ fontSize: 14, color: colors.textSecondary, fontFamily: "Inter_400Regular" }}>{t("quota_added")}</Text>
        </Animated.View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Back */}
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.textSecondary} />
        </Pressable>

        {/* Icon */}
        <View style={{ alignItems: "center", paddingVertical: 16 }}>
          <View style={[styles.iconCircle, { backgroundColor: colors.accents.violet + "1F", borderColor: colors.accents.violet + "40" }]}>
            <Ionicons name="gift" size={52} color={colors.accents.violet} />
          </View>
        </View>

        <Text style={styles.title}>{t("activate_plan_title")}</Text>
        <Text style={styles.subtitle}>{t("activate_plan_desc")}</Text>

        {/* Input */}
        <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
          <TextInput
            style={[styles.input, error && { borderColor: colors.disconnected }]}
            placeholder="SXB-DATA-XXXX-XXXX-XXXX"
            placeholderTextColor={colors.textMuted}
            value={token}
            onChangeText={(t) => { setToken(t.toUpperCase()); setError(""); }}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleActivate}
          />
        </Animated.View>

        {error ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={14} color={colors.disconnected} />
            <Text style={{ fontSize: 13, color: colors.disconnected, fontFamily: "Inter_500Medium" }}>{error}</Text>
          </View>
        ) : null}

        {/* Activate button */}
        <Pressable onPress={handleActivate} disabled={isLoading} style={[styles.btn, isLoading && { opacity: 0.6 }]}>
          <LinearGradient colors={[colors.accents.violet, colors.accents.indigo]} style={styles.btnGrad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
            {isLoading
? <Text style={styles.btnText}>{t("plan_activating")}</Text>
	              : <>
	                  <Ionicons name="gift" size={18} color="#FFF" />
	                  <Text style={styles.btnText}>{t("activate_plan")}</Text>
	                </>
            }
          </LinearGradient>
        </Pressable>

        {/* Info card */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle-outline" size={18} color={colors.accents.cyan} />
<Text style={styles.infoText}>{t("faq_a2")}</Text>
        </View>


      </ScrollView>
    </LinearGradient>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, responsive: ReturnType<typeof useResponsive>) {
  return StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: responsive.screenPadding, gap: responsive.gap + 2, width: "100%", maxWidth: responsiveLayout.contentMaxWidth, alignSelf: "center" },
  backBtn: { width: 44, height: 44, borderRadius: radius.lg, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  iconCircle: { width: 110, height: 110, borderRadius: 55, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 26, fontWeight: "700", color: colors.textPrimary, fontFamily: "Inter_700Bold", textAlign: "center" },
  subtitle: { fontSize: 14, color: colors.textSecondary, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22 },
  input: { backgroundColor: colors.bgInput, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 18, paddingVertical: 16, fontSize: 15, color: colors.textPrimary, fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textAlign: "center" },
  btn: { borderRadius: radius.md, overflow: "hidden" },
  btnGrad: { minHeight: responsive.touchTarget, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingVertical: 16 },
  // Blanc assumé : ce libellé est posé sur un dégradé violet saturé, identique
  // dans les deux thèmes, où seul un blanc garde un contraste suffisant.
  btnText: { fontSize: 16, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },  infoCard: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, backgroundColor: colors.bgCard, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, padding: 14 },
  infoText: { flex: 1, fontSize: 12, color: colors.textSecondary, fontFamily: "Inter_400Regular", lineHeight: 18 },
  });
}

import React, { useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

const { width } = Dimensions.get("window");
const LOGO = require("../assets/images/icon.png");

export default function OnboardingScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { markOnboardingDone } = useAuthContext();
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const introScale = useRef(new Animated.Value(0.94)).current;
  const slides = [
    { icon: "shield-checkmark" as const, color: colors.primary, title: t("onboarding_security_title"), subtitle: t("onboarding_security_desc") },
    { icon: "flash" as const, color: colors.connected, title: t("onboarding_oneclick_title"), subtitle: t("onboarding_desc_2") },
    { icon: "lock-closed" as const, color: colors.purple, title: t("section_security_conn"), subtitle: t("onboarding_desc_4") },
  ];

  React.useEffect(() => {
    Animated.timing(introScale, { toValue: 1, duration: 420, useNativeDriver: true }).start();
  }, [introScale]);
  const handleStart = async () => { await markOnboardingDone(); router.replace("/activate"); };
  const goNext = () => {
    if (activeIndex < slides.length - 1) { const next = activeIndex + 1; scrollRef.current?.scrollTo({ x: next * width, animated: true }); setActiveIndex(next); if (Haptics) void Haptics.selectionAsync(); }
    else void handleStart();
  };
  const isLast = activeIndex === slides.length - 1;

  return <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}><View style={styles.header}><View style={styles.logoWrap}><Image source={LOGO} style={styles.logo} resizeMode="contain" /></View><View><Text style={styles.brand}>SXB VPN</Text><Text style={styles.brandSub}>{t("tagline")}</Text></View></View><Animated.View style={[styles.slidesArea, { transform: [{ scale: introScale }] }]}><ScrollView ref={scrollRef} horizontal pagingEnabled showsHorizontalScrollIndicator={false} scrollEnabled={false}>{slides.map((slide, index) => <View key={index} style={[styles.slide, { width }]}><View style={[styles.iconCircle, { borderColor: slide.color + "55", backgroundColor: slide.color + "14" }]}><View style={[styles.iconInner, { backgroundColor: slide.color + "18" }]}><Ionicons name={slide.icon} size={58} color={slide.color} /></View></View><Text style={styles.slideTitle}>{slide.title}</Text><Text style={styles.slideSubtitle}>{slide.subtitle}</Text></View>)}</ScrollView></Animated.View><View style={styles.dots}>{slides.map((_, index) => <View key={index} style={[styles.dot, { backgroundColor: index === activeIndex ? colors.primary : colors.border }, index === activeIndex && styles.dotActive]} />)}</View><View style={styles.footer}><Pressable onPress={goNext} style={({ pressed }) => [styles.primaryButton, isLast && { backgroundColor: colors.connected }, pressed && styles.pressed]}><Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>{isLast ? t("start") : t("next")}</Text><Ionicons name={isLast ? "checkmark" : "arrow-forward"} size={18} color={colors.primaryForeground} /></Pressable>{!isLast && <Pressable onPress={handleStart} style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}><Text style={styles.skipText}>{t("skip")}</Text></Pressable>}</View><View style={styles.featureRow}>{[{ icon: "lock-closed", label: "AES-256" }, { icon: "eye-off", label: "No-Logs" }, { icon: "shield-checkmark", label: "Secure" }].map((feature) => <View key={feature.label} style={styles.featureChip}><Ionicons name={feature.icon as any} size={13} color={colors.primary} /><Text style={styles.featureText}>{feature.label}</Text></View>)}</View></LinearGradient>;
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({
    container: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 60, paddingBottom: 12 }, logoWrap: { width: 42, height: 42, borderRadius: 14, backgroundColor: colors.primaryDim, borderWidth: 1, borderColor: colors.primary + "45", alignItems: "center", justifyContent: "center" }, logo: { width: 34, height: 34, borderRadius: 10 }, brand: { color: colors.textPrimary, fontSize: 18, fontFamily: "Inter_700Bold", letterSpacing: 1 }, brandSub: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_400Regular", marginTop: 2 }, slidesArea: { flex: 1 }, slide: { alignItems: "center", justifyContent: "center", paddingHorizontal: 34, gap: 19 }, iconCircle: { width: 174, height: 174, borderRadius: 58, borderWidth: 1, alignItems: "center", justifyContent: "center" }, iconInner: { width: 120, height: 120, borderRadius: 40, alignItems: "center", justifyContent: "center" }, slideTitle: { color: colors.textPrimary, fontSize: 27, lineHeight: 33, fontFamily: "Inter_700Bold", textAlign: "center" }, slideSubtitle: { color: colors.textSecondary, fontSize: 15, lineHeight: 23, fontFamily: "Inter_400Regular", textAlign: "center" }, dots: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingBottom: 22 }, dot: { width: 7, height: 5, borderRadius: 4 }, dotActive: { width: 27 }, footer: { paddingHorizontal: 24, gap: 8, paddingBottom: 17 }, primaryButton: { minHeight: 54, borderRadius: 16, backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 }, primaryButtonText: { fontSize: 15, fontFamily: "Inter_700Bold" }, skipButton: { minHeight: 38, alignItems: "center", justifyContent: "center" }, skipText: { color: colors.textMuted, fontSize: 13, fontFamily: "Inter_500Medium" }, featureRow: { flexDirection: "row", justifyContent: "center", gap: 8, paddingBottom: 31 }, featureChip: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard + "B8", borderRadius: 99, paddingHorizontal: 10, paddingVertical: 6 }, featureText: { color: colors.textSecondary, fontSize: 10, fontFamily: "Inter_600SemiBold" }, pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  });
}

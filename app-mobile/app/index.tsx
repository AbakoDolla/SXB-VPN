import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Dimensions, Image, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

const { width } = Dimensions.get("window");
const LOGO = require("../assets/images/icon.png");

export default function SplashScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { isLoading, isAuthenticated, hasSeenOnboarding } = useAuthContext();
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.76)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(0.7)).current;
  const ring2 = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    const first = Animated.parallel([
      Animated.timing(logoOpacity, { toValue: 1, duration: 520, useNativeDriver: true }),
      Animated.timing(logoScale, { toValue: 1, duration: 520, useNativeDriver: true }),
      Animated.timing(glowOpacity, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]);
    const second = Animated.parallel([
      Animated.timing(textOpacity, { toValue: 1, duration: 360, useNativeDriver: true }),
      Animated.loop(Animated.sequence([Animated.timing(ring1, { toValue: 1.08, duration: 1800, useNativeDriver: true }), Animated.timing(ring1, { toValue: 0.7, duration: 1800, useNativeDriver: true })])),
      Animated.loop(Animated.sequence([Animated.delay(520), Animated.timing(ring2, { toValue: 1.2, duration: 2100, useNativeDriver: true }), Animated.timing(ring2, { toValue: 0.7, duration: 2100, useNativeDriver: true })])),
    ]);
    Animated.sequence([first, second]).start();
    return () => { first.stop(); second.stop(); };
  }, [glowOpacity, logoOpacity, logoScale, ring1, ring2, textOpacity]);

  useEffect(() => {
    if (isLoading) return;
    const timer = setTimeout(() => router.replace(!isAuthenticated ? (hasSeenOnboarding ? "/activate" : "/onboarding") : "/(tabs)/" as any), 1800);
    return () => clearTimeout(timer);
  }, [isLoading, isAuthenticated, hasSeenOnboarding]);

  return <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}><Animated.View style={[styles.ring, styles.ringOne, { borderColor: colors.primary + "28", transform: [{ scale: ring1 }], opacity: glowOpacity }]} /><Animated.View style={[styles.ring, styles.ringTwo, { borderColor: colors.primary + "14", transform: [{ scale: ring2 }], opacity: glowOpacity }]} /><Animated.View style={[styles.logoWrap, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}><Animated.View style={[styles.glowBall, { backgroundColor: colors.primaryDim, opacity: glowOpacity }]} /><Image source={LOGO} style={styles.logo} resizeMode="contain" /></Animated.View><Animated.View style={[styles.textWrap, { opacity: textOpacity }]}><Text style={styles.brand}>{t("app_name")}</Text><Text style={styles.tagline}>STUFF X BILAL</Text><View style={[styles.badge, { backgroundColor: colors.bgCard, borderColor: colors.border }]}><View style={[styles.badgeDot, { backgroundColor: colors.connected }]} /><Text style={styles.badgeText}>{t("protection_active")}</Text></View></Animated.View></LinearGradient>;
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({ container: { flex: 1, alignItems: "center", justifyContent: "center" }, ring: { position: "absolute", borderRadius: 999, borderWidth: 1 }, ringOne: { width: width * 0.72, height: width * 0.72 }, ringTwo: { width: width * 0.98, height: width * 0.98 }, logoWrap: { alignItems: "center", justifyContent: "center", marginBottom: 28 }, glowBall: { position: "absolute", width: 170, height: 170, borderRadius: 85 }, logo: { width: 120, height: 120, zIndex: 1 }, textWrap: { alignItems: "center", gap: 5 }, brand: { color: colors.textPrimary, fontSize: 29, fontFamily: "Inter_700Bold", letterSpacing: 2 }, tagline: { color: colors.primary, fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 3.5 }, badge: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, paddingHorizontal: 13, paddingVertical: 7, borderRadius: 99, borderWidth: 1 }, badgeDot: { width: 6, height: 6, borderRadius: 3 }, badgeText: { color: colors.textSecondary, fontSize: 11, fontFamily: "Inter_500Medium" } });
}

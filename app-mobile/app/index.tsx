import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Image, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

const LOGO = require("../assets/images/icon.png");

export default function SplashScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  // `Dimensions.get()` était lu une seule fois au chargement du module : les
  // anneaux gardaient la largeur du premier rendu et ne suivaient ni la
  // rotation, ni un écran partagé, ni une fenêtre redimensionnée.
  const { width, height } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors, width, height), [colors, width, height]);
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
    // Le tutoriel présente des fonctions qui n'existent qu'après activation
    // (configuration attribuée, quota, notifications et tunnel). Le montrer
    // avant la saisie du token produisait une visite abstraite, puis une seconde
    // visite en surimpression sur l'accueil. Désormais : activation d'abord,
    // tutoriel une seule fois ensuite.
    const destination = !isAuthenticated
      ? "/activate"
      : hasSeenOnboarding
        ? "/(tabs)/"
        : "/onboarding";
    const timer = setTimeout(() => router.replace(destination as any), 1800);
    return () => clearTimeout(timer);
  }, [isLoading, isAuthenticated, hasSeenOnboarding]);

  return <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}><Animated.View style={[styles.ring, styles.ringOne, { borderColor: colors.primary + "28", transform: [{ scale: ring1 }], opacity: glowOpacity }]} /><Animated.View style={[styles.ring, styles.ringTwo, { borderColor: colors.primary + "14", transform: [{ scale: ring2 }], opacity: glowOpacity }]} /><Animated.View style={[styles.logoWrap, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}><Animated.View style={[styles.glowBall, { backgroundColor: colors.primaryDim, opacity: glowOpacity }]} /><Image source={LOGO} style={styles.logo} resizeMode="contain" /></Animated.View><Animated.View style={[styles.textWrap, { opacity: textOpacity }]}><Text style={styles.brand}>{t("app_name")}</Text><Text style={styles.tagline}>{t("created_by")}</Text><View style={[styles.badge, { backgroundColor: colors.bgCard, borderColor: colors.border }]}><View style={[styles.badgeDot, { backgroundColor: colors.connected }]} /><Text style={styles.badgeText}>{t("protection_active")}</Text></View></Animated.View></LinearGradient>;
}

function makeStyles(
  colors: ReturnType<typeof import("@/hooks/useColors").useColors>,
  width: number,
  height: number,
) {
  // Les anneaux se mesurent sur le PLUS PETIT côté : en paysage, se fier à la
  // largeur les faisait déborder verticalement. Le plafond garde un ordre de
  // grandeur crédible sur tablette, où 98 % de la largeur donnerait un halo
  // démesuré autour d'un logo resté à sa taille.
  const base = Math.min(width, height);
  const anneau = (facteur: number) => Math.min(base * facteur, 520);
  const logo = Math.min(Math.max(base * 0.3, 96), 148);
  return StyleSheet.create({ container: { flex: 1, alignItems: "center", justifyContent: "center" }, ring: { position: "absolute", borderRadius: 999, borderWidth: 1 }, ringOne: { width: anneau(0.72), height: anneau(0.72) }, ringTwo: { width: anneau(0.98), height: anneau(0.98) }, logoWrap: { alignItems: "center", justifyContent: "center", marginBottom: 28 }, glowBall: { position: "absolute", width: logo * 1.42, height: logo * 1.42, borderRadius: logo * 0.71 }, logo: { width: logo, height: logo, zIndex: 1 }, textWrap: { alignItems: "center", gap: 5 }, brand: { color: colors.textPrimary, fontSize: 29, fontFamily: "Inter_700Bold", letterSpacing: 2 }, tagline: { color: colors.primary, fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 3.5 }, badge: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, paddingHorizontal: 13, paddingVertical: 7, borderRadius: 99, borderWidth: 1 }, badgeDot: { width: 6, height: 6, borderRadius: 3 }, badgeText: { color: colors.textSecondary, fontSize: 11, fontFamily: "Inter_500Medium" } });
}

import React, { useEffect, useRef } from "react";
import { Animated, Dimensions, Image, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useAuthContext } from "@/contexts/AuthContext";
import Colors from "@/constants/colors";

const { width, height } = Dimensions.get("window");
const LOGO = require("@/assets/images/icon.png");

export default function SplashScreen() {
  const { isLoading, isAuthenticated, hasSeenOnboarding } = useAuthContext();

  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale   = useRef(new Animated.Value(0.7)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const ring1       = useRef(new Animated.Value(0.6)).current;
  const ring2       = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.spring(logoScale,   { toValue: 1, tension: 80, friction: 7, useNativeDriver: true }),
        Animated.timing(glowOpacity, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(textOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.loop(
          Animated.sequence([
            Animated.timing(ring1, { toValue: 1.15, duration: 1800, useNativeDriver: true }),
            Animated.timing(ring1, { toValue: 0.6,  duration: 1800, useNativeDriver: true }),
          ])
        ),
        Animated.loop(
          Animated.sequence([
            Animated.delay(600),
            Animated.timing(ring2, { toValue: 1.3, duration: 2000, useNativeDriver: true }),
            Animated.timing(ring2, { toValue: 0.6, duration: 2000, useNativeDriver: true }),
          ])
        ),
      ]),
    ]).start();
  }, []);

  useEffect(() => {
    if (!isLoading) {
      const timer = setTimeout(() => {
        if (!isAuthenticated) {
          router.replace(hasSeenOnboarding ? "/activate" : "/onboarding");
        } else {
          router.replace("/(tabs)/");
        }
      }, 2200);
      return () => clearTimeout(timer);
    }
  }, [isLoading, isAuthenticated, hasSeenOnboarding]);

  return (
    <LinearGradient colors={["#060914", "#0A1530", "#060914"]} style={styles.container}>
      {/* Rings */}
      <Animated.View style={[styles.ring, styles.ring1, { transform: [{ scale: ring1 }], opacity: glowOpacity }]} />
      <Animated.View style={[styles.ring, styles.ring2, { transform: [{ scale: ring2 }], opacity: glowOpacity }]} />

      {/* Logo */}
      <Animated.View style={[styles.logoWrap, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}>
        <Animated.View style={[styles.glowBall, { opacity: glowOpacity }]} />
        <Image source={LOGO} style={styles.logo} resizeMode="contain" />
      </Animated.View>

      {/* Text */}
      <Animated.View style={[styles.textWrap, { opacity: textOpacity }]}>
        <Text style={styles.brand}>SXB VPN</Text>
        <Text style={styles.tagline}>STUFF X BILAL</Text>
        <View style={styles.badge}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>Connexion sécurisée</Text>
        </View>
      </Animated.View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
  ring: {
    position: "absolute",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(0,212,255,0.15)",
  },
  ring1: { width: 280, height: 280 },
  ring2: { width: 380, height: 380, borderColor: "rgba(0,212,255,0.08)" },
  logoWrap: { alignItems: "center", justifyContent: "center", marginBottom: 32 },
  glowBall: {
    position: "absolute",
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: "rgba(0,212,255,0.12)",
  },
  logo: { width: 120, height: 120, zIndex: 1 },
  textWrap: { alignItems: "center", gap: 6 },
  brand: { fontSize: 28, fontWeight: "700", color: "#FFFFFF", fontFamily: "Inter_700Bold", letterSpacing: 2 },
  tagline: { fontSize: 11, color: Colors.primary, fontFamily: "Inter_600SemiBold", letterSpacing: 4 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard },
  badgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Colors.connected },
  badgeText: { fontSize: 12, color: Colors.textSecondary, fontFamily: "Inter_500Medium" },
});

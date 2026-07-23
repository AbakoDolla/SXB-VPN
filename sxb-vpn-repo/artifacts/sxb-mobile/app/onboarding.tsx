import React, { useRef, useState } from "react";
import {
  Animated, Dimensions, Image, Pressable,
  ScrollView, StyleSheet, Text, View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthContext } from "@/contexts/AuthContext";
import Colors from "@/constants/colors";

const { width } = Dimensions.get("window");
const LOGO = require("../assets/images/icon.png");

const SLIDES = [
  {
    icon: "shield-checkmark" as const,
    color: Colors.primary,
    title: "Sécurité totale",
    subtitle: "Votre connexion chiffrée, votre identité protégée. Partout. Toujours.",
    bg: "rgba(0,212,255,0.08)",
  },
  {
    icon: "flash" as const,
    color: Colors.connected,
    title: "Un clic suffit",
    subtitle: "Activez la protection VPN en une seconde. Aucune configuration technique nécessaire.",
    bg: "rgba(0,229,160,0.08)",
  },
  {
    icon: "lock-closed" as const,
    color: Colors.purple,
    title: "Données 100% privées",
    subtitle: "Zero-log policy. Vos données ne sont jamais conservées ni partagées.",
    bg: "rgba(139,92,246,0.08)",
  },
];

export default function OnboardingScreen() {
  const { markOnboardingDone } = useAuthContext();
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollX = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);

  const goNext = () => {
    if (activeIndex < SLIDES.length - 1) {
      const next = activeIndex + 1;
      scrollRef.current?.scrollTo({ x: next * width, animated: true });
      setActiveIndex(next);
    } else {
      handleStart();
    }
  };

  const handleStart = async () => {
    await markOnboardingDone();
    router.replace("/activate");
  };

  const isLast = activeIndex === SLIDES.length - 1;

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      {/* Logo */}
      <View style={styles.header}>
        <Image source={LOGO} style={styles.headerLogo} resizeMode="contain" />
        <Text style={styles.headerBrand}>SXB VPN</Text>
      </View>

      {/* Slides */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        style={{ flex: 1 }}
      >
        {SLIDES.map((slide, i) => (
          <View key={i} style={[styles.slide, { width }]}>
            <View style={[styles.iconCircle, { backgroundColor: slide.bg, borderColor: slide.color + "40" }]}>
              <View style={[styles.iconCircleInner, { backgroundColor: slide.bg }]}>
                <Ionicons name={slide.icon} size={56} color={slide.color} />
              </View>
            </View>
            <Text style={styles.slideTitle}>{slide.title}</Text>
            <Text style={styles.slideSubtitle}>{slide.subtitle}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Dots */}
      <View style={styles.dots}>
        {SLIDES.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === activeIndex
                ? { width: 24, backgroundColor: Colors.primary }
                : { backgroundColor: Colors.border },
            ]}
          />
        ))}
      </View>

      {/* Buttons */}
      <View style={styles.footer}>
        <Pressable
          onPress={goNext}
          style={[styles.btnPrimary, isLast && { backgroundColor: Colors.connected }]}
        >
          <Text style={styles.btnPrimaryText}>{isLast ? "Commencer" : "Suivant"}</Text>
          <Ionicons name={isLast ? "checkmark" : "arrow-forward"} size={18} color="#000" />
        </Pressable>
        {!isLast && (
          <Pressable onPress={handleStart} style={styles.btnSkip}>
            <Text style={styles.btnSkipText}>Passer</Text>
          </Pressable>
        )}
      </View>

      {/* Features row */}
      <View style={styles.featuresRow}>
        {[
          { icon: "lock-closed", label: "AES-256" },
          { icon: "eye-off",     label: "No-Logs" },
          { icon: "shield",      label: "Secure" },
        ].map((f) => (
          <View key={f.label} style={styles.featureChip}>
            <Ionicons name={f.icon as any} size={12} color={Colors.primary} />
            <Text style={styles.featureText}>{f.label}</Text>
          </View>
        ))}
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 60, paddingBottom: 20 },
  headerLogo: { width: 36, height: 36 },
  headerBrand: { fontSize: 18, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", letterSpacing: 1 },
  slide: { alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 20 },
  iconCircle: { width: 160, height: 160, borderRadius: 80, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  iconCircleInner: { width: 110, height: 110, borderRadius: 55, alignItems: "center", justifyContent: "center" },
  slideTitle: { fontSize: 28, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold", textAlign: "center" },
  slideSubtitle: { fontSize: 15, color: Colors.textSecondary, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 24 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 8, paddingBottom: 24 },
  dot: { height: 4, width: 8, borderRadius: 2 },
  footer: { paddingHorizontal: 24, gap: 12, paddingBottom: 20 },
  btnPrimary: { backgroundColor: Colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 16, borderRadius: 16 },
  btnPrimaryText: { fontSize: 16, fontWeight: "700", color: "#000", fontFamily: "Inter_700Bold" },
  btnSkip: { alignItems: "center", paddingVertical: 10 },
  btnSkipText: { fontSize: 14, color: Colors.textMuted, fontFamily: "Inter_500Medium" },
  featuresRow: { flexDirection: "row", justifyContent: "center", gap: 12, paddingBottom: 32 },
  featureChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard },
  featureText: { fontSize: 11, color: Colors.textSecondary, fontFamily: "Inter_600SemiBold" },
});

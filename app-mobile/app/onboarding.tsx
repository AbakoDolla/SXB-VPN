import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";
import { alpha, elevation, radius, spacing, type } from "@/constants/theme";

const LOGO = require("../assets/images/icon.png");
const LEGACY_WALKTHROUGH_KEY = "@walkthrough_done";

type PreviewKind =
  | "welcome"
  | "connection"
  | "profiles"
  | "quota"
  | "navigation"
  | "theme"
  | "background";

type Slide = {
  id: PreviewKind;
  eyebrow: string;
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bullets: Array<{ icon: keyof typeof Ionicons.glyphMap; text: string }>;
};

function MiniPill({ icon, label, color }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
}) {
  return (
    <View style={[styles.miniPill, { borderColor: color + alpha.f40, backgroundColor: color + alpha.f12 }]}>
      <Ionicons name={icon} size={12} color={color} />
      <Text style={[type.micro, { color }]}>{label}</Text>
    </View>
  );
}

function Preview({ kind, accent }: { kind: PreviewKind; accent: string }) {
  const colors = useColors();

  if (kind === "welcome") {
    return (
      <View style={styles.previewCentered}>
        <View style={[styles.previewShield, { backgroundColor: colors.connectedDim, borderColor: colors.connected + alpha.f40 }]}>
          <Ionicons name="shield-checkmark" size={42} color={colors.connected} />
        </View>
        <MiniPill icon="checkmark-circle" label="Compte activé" color={colors.connected} />
      </View>
    );
  }

  if (kind === "connection") {
    return (
      <View style={styles.previewCentered}>
        <MiniPill icon="radio-button-on" label="Protection active" color={colors.connected} />
        <View style={[styles.previewPowerOuter, { borderColor: colors.connected + alpha.f40, backgroundColor: colors.connectedDim }]}>
          <View style={[styles.previewPower, { backgroundColor: colors.bgCard, borderColor: colors.connected }]}>
            <Ionicons name="power" size={30} color={colors.connected} />
            <Text style={[type.captionMedium, { color: colors.textPrimary, fontVariant: ["tabular-nums"] }]}>00:42:18</Text>
          </View>
        </View>
        <Text style={[type.micro, { color: colors.textMuted }]}>Touchez pour vous déconnecter</Text>
      </View>
    );
  }

  if (kind === "profiles") {
    return (
      <View style={styles.previewStack}>
        {[
          { icon: "shield-checkmark" as const, title: "MTN Protocol", meta: "SSH + TLS", active: true },
          { icon: "layers-outline" as const, title: "Orange Secure", meta: "VLESS", active: false },
        ].map((row) => (
          <View
            key={row.title}
            style={[
              styles.previewRow,
              {
                backgroundColor: row.active ? accent + alpha.f08 : colors.bgCard2,
                borderColor: row.active ? accent + alpha.f40 : colors.border,
              },
            ]}
          >
            <View style={[styles.previewRowIcon, { backgroundColor: accent + alpha.f12 }]}>
              <Ionicons name={row.icon} size={16} color={accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[type.captionMedium, { color: colors.textPrimary }]}>{row.title}</Text>
              <Text style={[type.micro, { color: colors.textMuted }]}>{row.meta}</Text>
            </View>
            {row.active && <Ionicons name="checkmark-circle" size={18} color={accent} />}
          </View>
        ))}
      </View>
    );
  }

  if (kind === "quota") {
    return (
      <View style={styles.previewStack}>
        <View style={styles.previewMetricRow}>
          <View>
            <Text style={[type.h2, { color: colors.textPrimary }]}>7.4 Go</Text>
            <Text style={[type.micro, { color: colors.textMuted }]}>restants</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[type.captionMedium, { color: colors.textSecondary }]}>2.6 / 10 Go</Text>
            <Text style={[type.micro, { color: colors.textMuted }]}>utilisés</Text>
          </View>
        </View>
        <View style={[styles.previewTrack, { backgroundColor: colors.bgInput }]}>
          <LinearGradient
            colors={colors.gradients.primary as [string, string]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.previewProgress, { width: "26%" }]}
          />
        </View>
        <View style={styles.previewMetricRow}>
          <MiniPill icon="arrow-up" label="124 Ko/s" color={colors.primary} />
          <MiniPill icon="arrow-down" label="1,8 Mo/s" color={colors.connected} />
        </View>
      </View>
    );
  }

  if (kind === "navigation") {
    const tabs = [
      ["home", "Accueil"],
      ["time-outline", "Historique"],
      ["person-outline", "Profil"],
      ["notifications-outline", "Alertes"],
    ] as const;
    return (
      <View style={[styles.previewTabs, { backgroundColor: colors.bgCard2, borderColor: colors.border }]}>
        {tabs.map(([icon, label], index) => (
          <View key={label} style={styles.previewTab}>
            <View style={[styles.previewTabIcon, index === 0 && { backgroundColor: accent + alpha.f12 }]}>
              <Ionicons name={icon} size={18} color={index === 0 ? accent : colors.textMuted} />
            </View>
            <Text style={[type.micro, { color: index === 0 ? accent : colors.textMuted }]}>{label}</Text>
          </View>
        ))}
      </View>
    );
  }

  if (kind === "theme") {
    return (
      <View style={styles.previewThemeRow}>
        <View style={[styles.previewTheme, { backgroundColor: "#F7FAFE", borderColor: "#D3E0EE" }]}>
          <View style={[styles.previewThemeSun, { backgroundColor: "#1769E8" }]} />
          <View style={{ flex: 1, gap: 5 }}>
            <View style={{ height: 7, width: "72%", borderRadius: 5, backgroundColor: "#1B2E45" }} />
            <View style={{ height: 5, width: "48%", borderRadius: 5, backgroundColor: "#91A5BA" }} />
          </View>
          <Ionicons name="sunny" size={18} color="#1769E8" />
        </View>
        <View style={[styles.previewTheme, { backgroundColor: "#081323", borderColor: "#294059" }]}>
          <View style={[styles.previewThemeSun, { backgroundColor: "#41D8FF" }]} />
          <View style={{ flex: 1, gap: 5 }}>
            <View style={{ height: 7, width: "72%", borderRadius: 5, backgroundColor: "#F6FAFF" }} />
            <View style={{ height: 5, width: "48%", borderRadius: 5, backgroundColor: "#6B819F" }} />
          </View>
          <Ionicons name="moon" size={18} color="#41D8FF" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.previewStack}>
      <View style={[styles.previewNotification, { backgroundColor: colors.bgCard2, borderColor: colors.border }]}>
        <View style={[styles.previewRowIcon, { backgroundColor: colors.connectedDim }]}>
          <Ionicons name="shield-checkmark" size={17} color={colors.connected} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[type.captionMedium, { color: colors.textPrimary }]}>SXB VPN • Protection active</Text>
          <Text style={[type.micro, { color: colors.textMuted }]}>00:42:18 · ↑ 124 Ko/s · ↓ 1,8 Mo/s</Text>
        </View>
      </View>
      <View style={styles.previewMetricRow}>
        <MiniPill icon="battery-half-outline" label="Faible consommation" color={colors.connected} />
        <MiniPill icon="refresh-outline" label="Reconnexion auto" color={colors.primary} />
      </View>
    </View>
  );
}

export default function OnboardingScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user, isAuthenticated, isLoading, markOnboardingDone } = useAuthContext();
  const params = useLocalSearchParams<{ replay?: string }>();
  const isReplay = params.replay === "1";
  const [activeIndex, setActiveIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const appear = useRef(new Animated.Value(0)).current;

  const pageWidth = Math.max(280, width - spacing["2xl"] * 2);
  const slides = useMemo<Slide[]>(() => [
    {
      id: "welcome",
      eyebrow: t("tour_activation_eyebrow"),
      title: t("tour_activation_title"),
      description: t("tour_activation_desc"),
      icon: "sparkles",
      color: colors.connected,
      bullets: [
        { icon: "lock-closed-outline", text: t("tour_activation_bullet_1") },
        { icon: "phone-portrait-outline", text: t("tour_activation_bullet_2") },
      ],
    },
    {
      id: "connection",
      eyebrow: t("tour_home_eyebrow"),
      title: t("tour_home_title"),
      description: t("tour_home_desc"),
      icon: "power",
      color: colors.primary,
      bullets: [
        { icon: "timer-outline", text: t("tour_home_bullet_1") },
        { icon: "pulse-outline", text: t("tour_home_bullet_2") },
      ],
    },
    {
      id: "profiles",
      eyebrow: t("tour_profiles_eyebrow"),
      title: t("tour_profiles_title"),
      description: t("tour_profiles_desc"),
      icon: "layers-outline",
      color: colors.purple,
      bullets: [
        { icon: "swap-horizontal-outline", text: t("tour_profiles_bullet_1") },
        { icon: "eye-off-outline", text: t("tour_profiles_bullet_2") },
      ],
    },
    {
      id: "quota",
      eyebrow: t("tour_quota_eyebrow"),
      title: t("tour_quota_title"),
      description: t("tour_quota_desc"),
      icon: "cellular-outline",
      color: colors.connected,
      bullets: [
        { icon: "pie-chart-outline", text: t("tour_quota_bullet_1") },
        { icon: "speedometer-outline", text: t("tour_quota_bullet_2") },
      ],
    },
    {
      id: "navigation",
      eyebrow: t("tour_sections_eyebrow"),
      title: t("tour_sections_title"),
      description: t("tour_sections_desc"),
      icon: "grid-outline",
      color: colors.primary,
      bullets: [
        { icon: "time-outline", text: t("tour_sections_bullet_1") },
        { icon: "notifications-outline", text: t("tour_sections_bullet_2") },
      ],
    },
    {
      id: "theme",
      eyebrow: t("tour_theme_eyebrow"),
      title: t("tour_theme_title"),
      description: t("tour_theme_desc"),
      icon: "color-palette-outline",
      color: colors.warning,
      bullets: [
        { icon: "contrast-outline", text: t("tour_theme_bullet_1") },
        { icon: "settings-outline", text: t("tour_theme_bullet_2") },
      ],
    },
    {
      id: "background",
      eyebrow: t("tour_background_eyebrow"),
      title: t("tour_background_title"),
      description: t("tour_background_desc"),
      icon: "notifications-circle-outline",
      color: colors.connected,
      bullets: [
        { icon: "battery-half-outline", text: t("tour_background_bullet_1") },
        { icon: "shield-checkmark-outline", text: t("tour_background_bullet_2") },
      ],
    },
  ], [colors, t]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/activate");
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 420, useNativeDriver: true }).start();
  }, [appear]);

  const select = (index: number) => {
    const safe = Math.max(0, Math.min(slides.length - 1, index));
    setActiveIndex(safe);
    scrollRef.current?.scrollTo({ x: safe * pageWidth, animated: true });
    void Haptics.selectionAsync().catch(() => {});
  };

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await Promise.all([
        markOnboardingDone(),
        // Empêche une ancienne version de réafficher son ancien tutoriel modal
        // si l'utilisateur revient temporairement à une APK précédente.
        AsyncStorage.setItem(LEGACY_WALKTHROUGH_KEY, "true"),
      ]);
      if (isReplay && router.canGoBack()) router.back();
      else router.replace("/(tabs)/" as any);
    } finally {
      setFinishing(false);
    }
  };

  const current = slides[activeIndex];
  const isLast = activeIndex === slides.length - 1;

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <View style={[styles.top, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.brandRow}>
          <View style={[styles.logoWrap, { backgroundColor: colors.primaryDim, borderColor: colors.primary + alpha.f40 }]}>
            <Image source={LOGO} style={styles.logo} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.h3, { color: colors.textPrimary }]}>SXB VPN</Text>
            <Text style={[type.micro, { color: colors.textMuted }]}>
              {user?.name ? `${t("tour_for")} ${user.name}` : t("tour_getting_started")}
            </Text>
          </View>
          <View style={[styles.counter, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
            <Text style={[type.captionMedium, { color: colors.textSecondary }]}>
              {activeIndex + 1}/{slides.length}
            </Text>
          </View>
        </View>
        <View style={[styles.progressTrack, { backgroundColor: colors.bgInput }]}>
          <Animated.View
            style={[
              styles.progressFill,
              { backgroundColor: current.color, width: `${((activeIndex + 1) / slides.length) * 100}%` },
            ]}
          />
        </View>
      </View>

      <Animated.View style={{ flex: 1, opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] }}>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={pageWidth}
          contentContainerStyle={{ paddingHorizontal: spacing["2xl"] }}
          onMomentumScrollEnd={(event) => {
            setActiveIndex(Math.round(event.nativeEvent.contentOffset.x / pageWidth));
          }}
        >
          {slides.map((slide) => (
            <View key={slide.id} style={{ width: pageWidth, justifyContent: "center", paddingVertical: spacing.lg }}>
              <View
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.bgCard,
                    borderColor: slide.color + alpha.f40,
                    shadowColor: slide.color,
                  },
                  elevation.md,
                ]}
              >
                <View style={styles.cardHeader}>
                  <View style={[styles.heroIcon, { backgroundColor: slide.color + alpha.f12, borderColor: slide.color + alpha.f40 }]}>
                    <Ionicons name={slide.icon} size={28} color={slide.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[type.overline, { color: slide.color }]}>{slide.eyebrow}</Text>
                    <Text style={[type.h1, { color: colors.textPrimary, marginTop: spacing.xs }]}>{slide.title}</Text>
                  </View>
                </View>

                <View style={[styles.preview, { backgroundColor: colors.bgCard2, borderColor: colors.border }]}>
                  <Preview kind={slide.id} accent={slide.color} />
                </View>

                <Text style={[type.body, { color: colors.textSecondary }]}>{slide.description}</Text>

                <View style={styles.bullets}>
                  {slide.bullets.map((bullet) => (
                    <View key={bullet.text} style={styles.bullet}>
                      <View style={[styles.bulletIcon, { backgroundColor: slide.color + alpha.f12 }]}>
                        <Ionicons name={bullet.icon} size={15} color={slide.color} />
                      </View>
                      <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>{bullet.text}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          ))}
        </ScrollView>
      </Animated.View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.dots}>
          {slides.map((slide, index) => (
            <Pressable
              key={slide.id}
              onPress={() => select(index)}
              hitSlop={8}
              style={[
                styles.dot,
                { backgroundColor: index === activeIndex ? current.color : colors.border },
                index === activeIndex && styles.dotActive,
              ]}
            />
          ))}
        </View>

        <View style={styles.actions}>
          {activeIndex > 0 ? (
            <Pressable
              onPress={() => select(activeIndex - 1)}
              style={({ pressed }) => [
                styles.secondaryButton,
                { backgroundColor: colors.bgCard, borderColor: colors.border },
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="arrow-back" size={18} color={colors.textSecondary} />
              <Text style={[type.bodyMedium, { color: colors.textSecondary }]}>{t("back")}</Text>
            </Pressable>
          ) : (
            <Pressable onPress={finish} disabled={finishing} style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}>
              <Text style={[type.bodyMedium, { color: colors.textMuted }]}>{t("skip")}</Text>
            </Pressable>
          )}

          <Pressable
            onPress={() => isLast ? void finish() : select(activeIndex + 1)}
            disabled={finishing}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: current.color },
              pressed && styles.pressed,
              finishing && { opacity: 0.55 },
            ]}
          >
            <Text style={[type.bodyMedium, { color: colors.primaryForeground }]}>
              {isLast ? t("walkthrough_finish") : t("next")}
            </Text>
            <Ionicons name={isLast ? "checkmark" : "arrow-forward"} size={18} color={colors.primaryForeground} />
          </Pressable>
        </View>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  top: { paddingHorizontal: spacing["2xl"], gap: spacing.md },
  brandRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  logoWrap: { width: 44, height: 44, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  logo: { width: 34, height: 34, borderRadius: radius.sm },
  counter: { minWidth: 48, height: 34, borderRadius: radius.full, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  progressTrack: { height: 4, borderRadius: radius.full, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: radius.full },
  card: { borderRadius: radius.xl, borderWidth: 1, padding: spacing.xl, gap: spacing.lg },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  heroIcon: { width: 58, height: 58, borderRadius: radius.lg, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  preview: { minHeight: 155, borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, justifyContent: "center" },
  previewCentered: { alignItems: "center", justifyContent: "center", gap: spacing.md },
  previewShield: { width: 76, height: 76, borderRadius: radius.xl, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  miniPill: { flexDirection: "row", alignItems: "center", gap: spacing.xs, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  previewPowerOuter: { width: 96, height: 96, borderRadius: 48, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  previewPower: { width: 76, height: 76, borderRadius: 38, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: 2 },
  previewStack: { gap: spacing.sm },
  previewRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm },
  previewRowIcon: { width: 34, height: 34, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  previewMetricRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  previewTrack: { height: 8, borderRadius: radius.full, overflow: "hidden" },
  previewProgress: { height: "100%", borderRadius: radius.full },
  previewTabs: { flexDirection: "row", borderRadius: radius.lg, borderWidth: 1, padding: spacing.sm },
  previewTab: { flex: 1, alignItems: "center", gap: spacing.xs },
  previewTabIcon: { width: 36, height: 28, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  previewThemeRow: { gap: spacing.sm },
  previewTheme: { flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  previewThemeSun: { width: 28, height: 28, borderRadius: radius.sm },
  previewNotification: { flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  bullets: { gap: spacing.sm },
  bullet: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  bulletIcon: { width: 30, height: 30, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  footer: { paddingHorizontal: spacing["2xl"], gap: spacing.lg },
  dots: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm },
  dot: { width: 7, height: 7, borderRadius: radius.full },
  dotActive: { width: 24 },
  actions: { flexDirection: "row", gap: spacing.md },
  secondaryButton: { minHeight: 52, minWidth: 112, borderRadius: radius.md, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm },
  skipButton: { minHeight: 52, minWidth: 90, alignItems: "center", justifyContent: "center" },
  primaryButton: { flex: 1, minHeight: 52, borderRadius: radius.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});

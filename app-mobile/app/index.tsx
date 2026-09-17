import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Image, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";
import { radius, spacing } from "@/constants/theme";

const LOGO = require("../assets/images/icon.png");

/**
 * Écran de lancement — « le tunnel se scelle ».
 *
 * L'ancienne version montrait deux anneaux qui respiraient autour du logo.
 * Correct, mais interchangeable : rien n'y disait ce que fait ce produit, et la
 * boucle tournait sans jamais aboutir — l'écran avait l'air d'attendre plutôt
 * que de préparer quelque chose.
 *
 * CE QUE RACONTE CELUI-CI. Quatre temps qui se suivent et se terminent :
 *
 *  1. Des balayages partent du centre et s'éloignent — le réseau est ouvert,
 *     exposé.
 *  2. Un arc tourne autour du logo, comme une clé qu'on engage.
 *  3. Le logo se pose avec un éclat bref : le tunnel est scellé.
 *  4. Le nom, la signature et une barre de chargement qui va jusqu'au bout.
 *
 * La séquence dure exactement le temps de la redirection : elle n'est jamais
 * coupée au milieu, et ne boucle pas non plus une fois finie.
 *
 * TOUT EST EN PILOTE NATIF. Chaque valeur animée ne touche que `opacity` ou
 * `transform`, les deux seules propriétés que React Native sait confier au
 * thread d'interface. Une animation de lancement qui saccade donne le ton de
 * toute l'application ; celle-ci ne dépend pas du fil JavaScript, occupé au
 * même instant à charger les polices, l'état d'authentification et le stockage.
 */

/** Durée totale, calée sur la redirection. */
const DUREE_TOTALE_MS = 2100;

export default function SplashScreen() {
  const { t } = useTranslation();
  const colors = useColors();
  // `Dimensions.get()` était lu une seule fois au chargement du module : les
  // anneaux gardaient la largeur du premier rendu et ne suivaient ni la
  // rotation, ni un écran partagé, ni une fenêtre redimensionnée.
  const { width, height } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors, width, height), [colors, width, height]);
  const { isLoading, isAuthenticated, hasSeenOnboarding } = useAuthContext();

  // ── Valeurs animées ────────────────────────────────────────────────────────
  // Une par rôle visuel, jamais partagée : une valeur réutilisée pour deux
  // effets les rend indissociables dès qu'on veut en ajuster un seul.
  const ondeUne = useRef(new Animated.Value(0)).current;
  const ondeDeux = useRef(new Animated.Value(0)).current;
  const ondeTrois = useRef(new Animated.Value(0)).current;
  const rotationArc = useRef(new Animated.Value(0)).current;
  const opaciteArc = useRef(new Animated.Value(0)).current;
  const logoOpacite = useRef(new Animated.Value(0)).current;
  const logoEchelle = useRef(new Animated.Value(0.62)).current;
  const eclat = useRef(new Animated.Value(0)).current;
  const halo = useRef(new Animated.Value(0)).current;
  const texteOpacite = useRef(new Animated.Value(0)).current;
  const texteMontee = useRef(new Animated.Value(14)).current;
  const progression = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    /** Une onde qui part du centre et se dissipe en s'éloignant. */
    const onde = (valeur: Animated.Value, retard: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(retard),
          Animated.timing(valeur, {
            toValue: 1,
            duration: 1600,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(valeur, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
        { iterations: 2 },
      );

    const sequence = Animated.parallel([
      // 1. Le réseau ouvert : trois ondes décalées.
      onde(ondeUne, 0),
      onde(ondeDeux, 260),
      onde(ondeTrois, 520),

      // 2. L'arc qui s'engage, puis s'efface quand le sceau est posé.
      Animated.sequence([
        Animated.timing(opaciteArc, { toValue: 1, duration: 280, useNativeDriver: true }),
        Animated.delay(900),
        Animated.timing(opaciteArc, { toValue: 0, duration: 420, useNativeDriver: true }),
      ]),
      Animated.loop(
        Animated.timing(rotationArc, {
          toValue: 1,
          duration: 1400,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ),

      // 3. Le logo se pose. Le ressort donne l'impression d'un objet qui
      //    s'emboîte, là où une interpolation linéaire le ferait glisser.
      Animated.sequence([
        Animated.delay(320),
        Animated.parallel([
          Animated.timing(logoOpacite, { toValue: 1, duration: 420, useNativeDriver: true }),
          Animated.spring(logoEchelle, {
            toValue: 1,
            // Dépassement volontairement DISCRET. Un ressort marqué donnerait
            // un rebond de gadget ; ici le logo doit s'emboîter — juste assez
            // de dépassement pour qu'on sente la butée, pas assez pour qu'on
            // voie l'effet.
            friction: 9,
            tension: 62,
            useNativeDriver: true,
          }),
        ]),
        // L'éclat du scellement : bref, sinon il devient un clignotement.
        Animated.parallel([
          Animated.sequence([
            Animated.timing(eclat, { toValue: 1, duration: 160, useNativeDriver: true }),
            Animated.timing(eclat, { toValue: 0, duration: 520, useNativeDriver: true }),
          ]),
          Animated.timing(halo, { toValue: 1, duration: 700, useNativeDriver: true }),
        ]),
      ]),

      // 4. Le texte monte légèrement en apparaissant — il arrive, il ne
      //    surgit pas.
      Animated.sequence([
        Animated.delay(760),
        Animated.parallel([
          Animated.timing(texteOpacite, { toValue: 1, duration: 460, useNativeDriver: true }),
          Animated.timing(texteMontee, {
            toValue: 0,
            duration: 460,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ]),

      // 5. La barre va jusqu'au bout : l'écran se termine, il n'attend pas.
      Animated.sequence([
        Animated.delay(520),
        Animated.timing(progression, {
          toValue: 1,
          duration: DUREE_TOTALE_MS - 620,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]);

    sequence.start();
    return () => sequence.stop();
  }, [eclat, halo, logoEchelle, logoOpacite, ondeDeux, ondeTrois, ondeUne, opaciteArc, progression, rotationArc, texteMontee, texteOpacite]);

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
    const timer = setTimeout(() => router.replace(destination as any), DUREE_TOTALE_MS);
    return () => clearTimeout(timer);
  }, [isLoading, isAuthenticated, hasSeenOnboarding]);

  /** Une onde : elle grandit et s'efface en même temps. */
  const styleOnde = (valeur: Animated.Value) => ({
    opacity: valeur.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 0] }),
    transform: [{ scale: valeur.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1.9] }) }],
  });

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      {/* Les ondes : le réseau avant qu'il ne soit protégé. */}
      <Animated.View style={[styles.onde, { borderColor: colors.primary + "3A" }, styleOnde(ondeUne)]} />
      <Animated.View style={[styles.onde, { borderColor: colors.accents.cyan + "30" }, styleOnde(ondeDeux)]} />
      <Animated.View style={[styles.onde, { borderColor: colors.accents.violet + "26" }, styleOnde(ondeTrois)]} />

      {/* L'arc qui tourne : la clé qu'on engage. Deux bordures colorées sur
          quatre suffisent à lire la rotation ; un cercle complet tournerait
          sans qu'on le voie. */}
      <Animated.View
        style={[
          styles.arc,
          {
            borderTopColor: colors.primary,
            borderRightColor: colors.accents.cyan + "80",
            opacity: opaciteArc,
            transform: [
              {
                rotate: rotationArc.interpolate({
                  inputRange: [0, 1],
                  outputRange: ["0deg", "360deg"],
                }),
              },
            ],
          },
        ]}
      />

      {/* Le halo du sceau, posé sous le logo. */}
      <Animated.View
        style={[
          styles.halo,
          {
            backgroundColor: colors.primaryDim,
            opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0, 0.85] }),
            transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
          },
        ]}
      />

      {/* L'éclat du scellement. */}
      <Animated.View
        style={[
          styles.eclat,
          {
            backgroundColor: colors.primary,
            opacity: eclat.interpolate({ inputRange: [0, 1], outputRange: [0, 0.32] }),
            transform: [{ scale: eclat.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.5] }) }],
          },
        ]}
      />

      <Animated.View style={[styles.logoWrap, { opacity: logoOpacite, transform: [{ scale: logoEchelle }] }]}>
        <Image source={LOGO} style={styles.logo} resizeMode="contain" />
      </Animated.View>

      <Animated.View style={[styles.textWrap, { opacity: texteOpacite, transform: [{ translateY: texteMontee }] }]}>
        <Text style={styles.brand}>{t("app_name")}</Text>
        <Text style={styles.tagline}>{t("created_by")}</Text>

        {/* Barre de chargement. `scaleX` plutôt que `width` : la largeur
            animée passe par le fil JavaScript à chaque image, et saccade
            précisément au moment où celui-ci est le plus occupé. */}
        <View style={[styles.pisteBarre, { backgroundColor: colors.border }]}>
          <Animated.View
            style={[
              styles.barre,
              {
                backgroundColor: colors.primary,
                transform: [
                  { translateX: -BARRE_LARGEUR / 2 },
                  { scaleX: progression },
                  { translateX: BARRE_LARGEUR / 2 },
                ],
              },
            ]}
          />
        </View>
      </Animated.View>
    </LinearGradient>
  );
}

const BARRE_LARGEUR = 132;

function makeStyles(
  colors: ReturnType<typeof import("@/hooks/useColors").useColors>,
  width: number,
  height: number,
) {
  // Les cercles se mesurent sur le PLUS PETIT côté : en paysage, se fier à la
  // largeur les faisait déborder verticalement. Le plafond garde un ordre de
  // grandeur crédible sur tablette, où une fraction de la largeur donnerait un
  // halo démesuré autour d'un logo resté à sa taille.
  const base = Math.min(width, height);
  const cercle = (facteur: number) => Math.min(base * facteur, 460);
  const logo = Math.min(Math.max(base * 0.3, 96), 148);

  return StyleSheet.create({
    container: { flex: 1, alignItems: "center", justifyContent: "center" },
    onde: {
      position: "absolute",
      width: cercle(0.62),
      height: cercle(0.62),
      borderRadius: radius.full,
      borderWidth: 1,
    },
    arc: {
      position: "absolute",
      width: logo * 1.85,
      height: logo * 1.85,
      borderRadius: radius.full,
      borderWidth: 2,
      borderBottomColor: "transparent",
      borderLeftColor: "transparent",
    },
    halo: {
      position: "absolute",
      width: logo * 1.5,
      height: logo * 1.5,
      borderRadius: radius.full,
    },
    eclat: {
      position: "absolute",
      width: logo * 1.2,
      height: logo * 1.2,
      borderRadius: radius.full,
    },
    logoWrap: { alignItems: "center", justifyContent: "center", marginBottom: spacing["3xl"] },
    logo: { width: logo, height: logo, zIndex: 1 },
    textWrap: { alignItems: "center", gap: spacing.xs },
    brand: {
      color: colors.textPrimary,
      fontSize: 29,
      fontFamily: "Inter_700Bold",
      letterSpacing: 2,
    },
    tagline: {
      color: colors.primary,
      fontSize: 10,
      fontFamily: "Inter_600SemiBold",
      letterSpacing: 3.5,
    },
    pisteBarre: {
      width: BARRE_LARGEUR,
      height: 3,
      borderRadius: radius.full,
      overflow: "hidden",
      marginTop: spacing.lg,
    },
    barre: { width: BARRE_LARGEUR, height: 3, borderRadius: radius.full },
  });
}

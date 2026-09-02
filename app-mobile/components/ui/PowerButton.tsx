/**
 * Bouton d'alimentation 3D — pièce maîtresse de l'écran d'accueil.
 *
 * Le relief est obtenu par empilement de dégradés plutôt que par une
 * bibliothèque 3D : aucune dépendance supplémentaire, et un rendu fluide même
 * sur les appareils d'entrée de gamme, ce qui compte pour une application qui
 * doit rester réactive pendant que le tunnel chiffre le trafic.
 *
 * Le relief repose sur une règle unique : UNE SEULE SOURCE DE LUMIÈRE, en haut
 * à gauche. Tout ce qui est en relief s'éclaire en haut à gauche et s'assombrit
 * en bas à droite ; tout ce qui est creusé fait l'inverse. C'est la cohérence de
 * cette convention — et non le nombre de couches — qui produit la profondeur.
 *
 * Empilement, du fond vers la surface :
 *   1. halo ambiant teinté par l'état
 *   2. ondes concentriques (tunnel actif)
 *   3. embase creusée, dans laquelle le bouton semble encastré
 *   4. couronne en relief
 *   5. dôme du bouton
 *   6. reflet spéculaire, qui donne l'aspect verre
 *
 * Composant purement présentationnel : il ne décide de rien. L'état affiché et
 * l'action déclenchée restent la responsabilité de l'écran, de sorte qu'une
 * évolution visuelle ne puisse jamais altérer la logique VPN.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { alpha, glow, radius, spacing, type } from '@/constants/theme';

const CORE = 150;          // dôme central
const BEZEL = CORE + 26;   // couronne en relief
const WELL = CORE + 58;    // embase creusée
const STAGE = CORE + 130;  // zone de propagation des ondes

interface PowerButtonProps {
  tone: string;
  icon: keyof typeof Ionicons.glyphMap;
  caption: string;
  timer?: string | null;
  active: boolean;
  busy: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}

export default function PowerButton({
  tone,
  icon,
  caption,
  timer,
  active,
  busy,
  onPress,
  accessibilityLabel,
}: PowerButtonProps) {
  const colors = useColors();

  const ripple = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const depth = useRef(new Animated.Value(0)).current;

  // Ondes concentriques : uniquement quand le tunnel transporte réellement.
  useEffect(() => {
    if (!active) {
      ripple.stopAnimation();
      ripple.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(ripple, {
        toValue: 1,
        duration: 2800,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, ripple]);

  // Balayage lumineux continu : c'est lui qui donne l'impression d'une surface
  // vitrée, en faisant glisser un reflet sur la couronne.
  useEffect(() => {
    if (!active && !busy) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: busy ? 1600 : 5200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, busy, spin]);

  // Respiration pendant l'établissement — volontairement différente des ondes,
  // pour que « en cours » et « connecté » ne se confondent jamais.
  useEffect(() => {
    if (!busy) {
      breathe.stopAnimation();
      breathe.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 850, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 850, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, breathe]);

  const breatheScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] });
  // À l'appui, le dôme s'enfonce dans son embase : l'échelle diminue pendant que
  // le reflet s'atténue, ce qui simule un vrai déplacement vertical.
  const pressScale = depth.interpolate({ inputRange: [0, 1], outputRange: [1, 0.955] });
  const glossOpacity = depth.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] });
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const ringStyle = (offset: number) => {
    const phase = Animated.modulo(Animated.add(ripple, offset), 1);
    return {
      transform: [{ scale: phase.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.7] }) }],
      opacity: phase.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.35, 0] }),
    };
  };

  const setDepth = (to: number) =>
    Animated.spring(depth, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 3 }).start();

  return (
    <View style={styles.wrap}>
      <View style={styles.stage}>
        {/* 1. Halo ambiant : seule source de couleur de la zone haute. */}
        <View
          style={[
            styles.halo,
            { backgroundColor: tone, opacity: active ? 0.18 : busy ? 0.11 : 0.05 },
          ]}
        />

        {/* 2. Ondes concentriques. */}
        {active && (
          <>
            <Animated.View style={[styles.ripple, { borderColor: tone }, ringStyle(0)]} />
            <Animated.View style={[styles.ripple, { borderColor: tone }, ringStyle(0.33)]} />
            <Animated.View style={[styles.ripple, { borderColor: tone }, ringStyle(0.66)]} />
          </>
        )}

        {/* 3. Embase creusée : dégradé sombre en haut, clair en bas — l'inverse
               d'une surface en relief, ce qui creuse visuellement le logement. */}
        <View style={styles.well}>
          <LinearGradient
            colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0.12)', 'rgba(255,255,255,0.05)']}
            start={{ x: 0.25, y: 0 }}
            end={{ x: 0.75, y: 1 }}
            style={styles.fill}
          />
        </View>

        {/* 4. Couronne en relief + balayage lumineux. */}
        <View style={[styles.bezel, { borderColor: tone + alpha.f24 }]}>
          <LinearGradient
            colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.02)', 'rgba(0,0,0,0.35)']}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={styles.fill}
          />
          <Animated.View style={[styles.fill, { transform: [{ rotate }] }]}>
            <LinearGradient
              colors={['transparent', tone + alpha.f40, 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.fill}
            />
          </Animated.View>
        </View>

        <Pressable
          onPress={onPress}
          onPressIn={() => setDepth(1)}
          onPressOut={() => setDepth(0)}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ busy, selected: active }}
        >
          {/* 5. Dôme : ombre portée teintée + dégradé éclairé en haut à gauche. */}
          <Animated.View
            style={[
              styles.core,
              { borderColor: tone + alpha.f60 },
              glow(tone, active ? 'lg' : busy ? 'md' : 'sm'),
              { transform: [{ scale: Animated.multiply(pressScale, breatheScale) }] },
            ]}
          >
            <LinearGradient
              colors={[tone + alpha.f40, tone + alpha.f16, 'rgba(0,0,0,0.30)']}
              start={{ x: 0.15, y: 0 }}
              end={{ x: 0.85, y: 1 }}
              style={styles.coreFill}
            >
              {/* 6. Reflet spéculaire : cantonné à la moitié haute, il donne
                     l'aspect verre. Son atténuation à l'appui renforce
                     l'impression d'enfoncement. */}
              <Animated.View style={[styles.gloss, { opacity: glossOpacity }]} pointerEvents="none">
                <LinearGradient
                  colors={['rgba(255,255,255,0.30)', 'rgba(255,255,255,0.05)', 'transparent']}
                  start={{ x: 0.3, y: 0 }}
                  end={{ x: 0.7, y: 1 }}
                  style={styles.fill}
                />
              </Animated.View>

              <View style={styles.coreContent}>
                {timer ? (
                  <>
                    <Ionicons name={icon} size={20} color={tone} />
                    <Text
                      style={[
                        type.h1,
                        {
                          color: colors.textPrimary,
                          fontVariant: ['tabular-nums' as const],
                          marginTop: spacing.xs,
                        },
                      ]}
                    >
                      {timer}
                    </Text>
                  </>
                ) : (
                  <Ionicons name={icon} size={52} color={tone} />
                )}
              </View>
            </LinearGradient>
          </Animated.View>
        </Pressable>
      </View>

      <Text style={[type.bodyMedium, { color: colors.textSecondary, textAlign: 'center' }]}>
        {caption}
      </Text>
    </View>
  );
}

const circle = (size: number) => ({
  width: size,
  height: size,
  borderRadius: size / 2,
});

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.lg },
  stage: { ...circle(STAGE), alignItems: 'center', justifyContent: 'center' },

  halo: { position: 'absolute', ...circle(STAGE) },
  ripple: { position: 'absolute', ...circle(CORE), borderWidth: 1.5 },

  well: { position: 'absolute', ...circle(WELL), overflow: 'hidden' },
  bezel: { position: 'absolute', ...circle(BEZEL), overflow: 'hidden', borderWidth: 1 },

  core: { ...circle(CORE), borderWidth: 1.5, overflow: 'hidden' },
  coreFill: { flex: 1, borderRadius: radius.full },
  coreContent: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  gloss: { position: 'absolute', left: 0, right: 0, top: 0, height: CORE * 0.55 },

  fill: { ...StyleSheet.absoluteFillObject },
});

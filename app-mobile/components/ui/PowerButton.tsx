/**
 * Bouton de connexion — élément central de l'écran d'accueil.
 *
 * Les applications VPN de référence font toutes reposer leur écran principal
 * sur une grande cible circulaire dont l'état est lisible d'un coup d'œil, à
 * distance de bras. C'est ce que reproduit ce composant :
 *
 *   • trois anneaux concentriques qui se propagent vers l'extérieur tant que
 *     la connexion est active — le mouvement traduit un tunnel « vivant » ;
 *   • une respiration lente pendant la connexion, distincte de la propagation,
 *     pour que « en cours » et « connecté » ne se confondent jamais ;
 *   • un halo teinté par l'état, seule source de lumière de l'écran.
 *
 * Le composant est purement présentationnel : il ne décide de rien. L'état
 * affiché et l'action déclenchée restent la responsabilité de l'écran, ce qui
 * garantit qu'une refonte visuelle ne peut pas altérer la logique VPN.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { alpha, glow, radius, spacing, type } from '@/constants/theme';

const CORE = 168;
const HALO = CORE + 96;

interface PowerButtonProps {
  /** Teinte de l'état courant, calculée par l'écran. */
  tone: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Libellé sous le bouton (« Appuyez pour vous connecter »…). */
  caption: string;
  /** Durée de session formatée, affichée à la place de l'icône une fois connecté. */
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
  const breathe = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;

  // Propagation des anneaux — uniquement lorsque le tunnel est réellement actif.
  useEffect(() => {
    if (!active) {
      ripple.stopAnimation();
      ripple.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(ripple, {
        toValue: 1,
        duration: 2600,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, ripple]);

  // Respiration pendant l'établissement de la connexion.
  useEffect(() => {
    if (!busy) {
      breathe.stopAnimation();
      breathe.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, breathe]);

  const breatheScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.045] });

  /** Anneau décalé dans le temps : les trois se suivent au lieu de pulser ensemble. */
  const ringStyle = (offset: number) => {
    const shifted = Animated.add(ripple, offset);
    // `modulo` ramène la valeur dans [0,1[ pour boucler sans discontinuité.
    const phase = Animated.modulo(shifted, 1);
    return {
      transform: [
        {
          scale: phase.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.55] }),
        },
      ],
      opacity: phase.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.4, 0] }),
    };
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.stage}>
        {/* Halo diffus : donne sa couleur à toute la zone haute de l'écran. */}
        <View
          style={[
            styles.halo,
            { backgroundColor: tone, opacity: active ? 0.16 : busy ? 0.1 : 0.05 },
          ]}
        />

        {active && (
          <>
            <Animated.View style={[styles.ring, { borderColor: tone }, ringStyle(0)]} />
            <Animated.View style={[styles.ring, { borderColor: tone }, ringStyle(0.33)]} />
            <Animated.View style={[styles.ring, { borderColor: tone }, ringStyle(0.66)]} />
          </>
        )}

        {/* Piste fixe : ancre le bouton même à l'arrêt, pour éviter l'effet « flottant ». */}
        <View style={[styles.track, { borderColor: colors.border }]} />

        <Pressable
          onPress={onPress}
          onPressIn={() =>
            Animated.spring(press, { toValue: 0.95, useNativeDriver: true, speed: 40, bounciness: 4 }).start()
          }
          onPressOut={() =>
            Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 28, bounciness: 8 }).start()
          }
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ busy, selected: active }}
        >
          <Animated.View
            style={[
              styles.core,
              { borderColor: tone + alpha.f60 },
              glow(tone, active ? 'lg' : 'md'),
              { transform: [{ scale: Animated.multiply(press, breatheScale) }] },
            ]}
          >
            <LinearGradient
              colors={[tone + alpha.f40, tone + alpha.f08]}
              start={{ x: 0.2, y: 0 }}
              end={{ x: 0.8, y: 1 }}
              style={styles.coreInner}
            >
              {timer ? (
                <>
                  <Ionicons name={icon} size={22} color={tone} />
                  <Text
                    style={[
                      type.h1,
                      { color: colors.textPrimary, fontVariant: ['tabular-nums' as const], marginTop: spacing.xs },
                    ]}
                  >
                    {timer}
                  </Text>
                </>
              ) : (
                <Ionicons name={icon} size={54} color={tone} />
              )}
            </LinearGradient>
          </Animated.View>
        </Pressable>
      </View>

      <Text style={[type.bodyMedium, { color: colors.textSecondary, textAlign: 'center' }]}>{caption}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.lg },
  stage: {
    width: HALO,
    height: HALO,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
    // Un flou natif coûterait cher en performance sur l'entrée de gamme ;
    // un disque très transparent produit un halo équivalent à coût nul.
    ...Platform.select({ ios: {}, android: {}, default: {} }),
  },
  ring: {
    position: 'absolute',
    width: CORE,
    height: CORE,
    borderRadius: CORE / 2,
    borderWidth: 1.5,
  },
  track: {
    position: 'absolute',
    width: CORE + 22,
    height: CORE + 22,
    borderRadius: (CORE + 22) / 2,
    borderWidth: 1,
  },
  core: {
    width: CORE,
    height: CORE,
    borderRadius: CORE / 2,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  coreInner: {
    flex: 1,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

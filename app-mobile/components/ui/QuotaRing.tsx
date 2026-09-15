/**
 * Anneau de progression du quota.
 *
 * POURQUOI un anneau plutôt qu'une barre : la carte de quota affichait trois
 * tuiles de POIDS ÉGAL — total, consommé, restant — puis une barre. Or la seule
 * question que l'utilisateur se pose est « combien me reste-t-il ? ». Donner à
 * cette réponse la même taille qu'aux deux autres l'obligeait à lire les trois
 * pour trouver celle qui l'intéresse.
 *
 * L'anneau porte la part consommée et libère le centre pour le pourcentage ;
 * la valeur restante peut alors devenir le chiffre principal de la carte.
 *
 * Rendu statique : aucune animation, aucune boucle. Il ne se redessine que
 * lorsque le quota change réellement, ce qui le rend négligeable même sur un
 * appareil d'entrée de gamme.
 */
import React from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { duration, type } from '@/constants/theme';

const CercleAnime = Animated.createAnimatedComponent(Circle);

interface QuotaRingProps {
  /** Part CONSOMMÉE, entre 0 et 1. Les valeurs hors bornes sont ramenées. */
  progress: number;
  size?: number;
  stroke?: number;
  /** Teinte normale. Au-delà de 80 %, `warnTone` prend le relais. */
  tone?: string;
  warnTone?: string;
  /** Libellé sous le pourcentage. */
  label?: string;
}

export default function QuotaRing({
  progress,
  size = 76,
  stroke = 7,
  tone,
  warnTone,
  label,
}: QuotaRingProps) {
  const colors = useColors();
  const part = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const teinte = part > 0.8 && warnTone ? warnTone : tone || colors.primary;

  const rayon = (size - stroke) / 2;
  const circonference = 2 * Math.PI * rayon;

  // L'anneau se REMPLIT à l'ouverture plutôt que d'apparaître complet.
  //
  // Ce n'est pas décoratif : le mouvement dit que la valeur vient d'être
  // mesurée, là où un arc figé pourrait passer pour une image. Il part de zéro
  // et rejoint la valeur réelle, puis suit chaque changement de quota.
  //
  // `useNativeDriver` est impossible ici — `strokeDashoffset` n'est pas une
  // propriété de transformation, elle traverse donc le pont JS. C'est
  // acceptable pour une animation qui ne joue qu'à l'ouverture et sur un seul
  // élément ; c'est aussi la raison pour laquelle on ne la boucle pas.
  const avance = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const anim = Animated.timing(avance, {
      toValue: part,
      duration: duration.slow,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [avance, part]);

  const offset = avance.interpolate({
    inputRange: [0, 1],
    outputRange: [circonference, 0],
  });

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={rayon}
          stroke={colors.bgInput}
          strokeWidth={stroke}
          fill="none"
        />
        <CercleAnime
          cx={size / 2}
          cy={size / 2}
          r={rayon}
          stroke={teinte}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={circonference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          // L'origine d'un cercle SVG est à 3 heures : sans cette rotation, le
          // remplissage démarrerait sur la droite au lieu du sommet.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.center} pointerEvents="none">
        <Text style={[type.h3, { color: colors.textPrimary }]}>
          {Math.round(part * 100)}%
        </Text>
        {label && (
          <Text style={[type.micro, { color: colors.textMuted }]} numberOfLines={1}>
            {label}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});

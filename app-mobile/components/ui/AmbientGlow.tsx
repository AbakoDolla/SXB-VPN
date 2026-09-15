/**
 * Halo d'ambiance — la couleur de fond répond à l'état de la liaison.
 *
 * POURQUOI : l'écran d'accueil gardait exactement la même teinte qu'on soit
 * protégé, en train de se connecter, ou connecté à un tunnel qui ne transporte
 * rien. L'information la plus importante de l'application — « est-ce que ça
 * marche » — ne se lisait que dans un libellé.
 *
 * Ce halo la porte en périphérie du regard : on sait avant d'avoir lu.
 *
 * CE QU'IL N'EST PAS : une décoration. Il ne s'allume que pour un état qui
 * mérite d'être signalé, et reste absent au repos — un fond qui change en
 * permanence n'informe plus de rien.
 *
 * COÛT : une seule vue, qui n'anime que son `opacity`. `useNativeDriver` la
 * confie au GPU, donc aucun travail sur le fil JavaScript pendant que le
 * tunnel chiffre le trafic.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { duration } from '@/constants/theme';

interface AmbientGlowProps {
  /** Teinte à diffuser, ou `null` pour n'en diffuser aucune. */
  tone: string | null;
  visible: boolean;
}

export default function AmbientGlow({ tone, visible }: AmbientGlowProps) {
  const opacite = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Le fondu est plus long à l'allumage qu'à l'extinction : une couleur qui
    // surgit d'un coup se lit comme une alerte, alors qu'elle décrit le plus
    // souvent un état normal.
    const anim = Animated.timing(opacite, {
      toValue: visible && tone ? 1 : 0,
      duration: visible ? duration.slow : duration.base,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [opacite, visible, tone]);

  // Pas de teinte : rien à rendre du tout, pas même une vue transparente.
  if (!tone) return null;

  return (
    <Animated.View style={[styles.wrap, { opacity: opacite }]} pointerEvents="none">
      <LinearGradient
        // Le halo part du HAUT, là où se trouve le bouton de connexion : c'est
        // lui que la couleur doit accompagner, pas le bas de la liste.
        colors={[tone + '26', tone + '0A', 'transparent']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Hauteur bornée : au-delà, le dégradé passerait derrière le texte des
  // cartes basses et en abaisserait le contraste.
  wrap: { position: 'absolute', left: 0, right: 0, top: 0, height: 420 },
});

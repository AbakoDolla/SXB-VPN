/**
 * VipBadge.tsx — marque d'un accès PAYANT, en métal frappé.
 *
 * POURQUOI IL EXISTE : un appareil en essai gratuit monte `FreeTrialCard`,
 * violette, impossible à manquer. Un appareil à accès payant n'avait rien —
 * son écran était exactement celui d'avant, et rien ne disait que la personne
 * était passée cliente. Ce badge est cette différence, vue en un regard.
 *
 * POURQUOI DE L'OR, ET PAS DE L'AMBRE DU THÈME : `accents.ambre` porte déjà un
 * sens dans ce produit — l'avertissement du journal, la vérification de relais,
 * la couleur des notifications. Reprendre cet aplat ferait lire « attention »
 * là où il faut lire « merci ». L'or d'ici n'est donc PAS un aplat teinté mais
 * une SURFACE : elle a une arête éclairée, un ventre lumineux et une ombre
 * portée. C'est ce relief, et non la teinte seule, qui la sépare d'une pastille.
 *
 * LA LUMIÈRE VIENT DU HAUT À GAUCHE, comme sur le bouton d'alimentation et sur
 * la carte d'essai. Une seconde source d'éclairage sur le même écran se
 * remarque immédiatement, même sans savoir pourquoi.
 *
 * CE QUE COÛTE L'ANIMATION : un seul passage de lumière à l'apparition, puis
 * plus rien. Aucune boucle, aucun `setInterval`, aucun réveil périodique — la
 * carte d'essai porte déjà le geste animé de cet écran, et deux mouvements
 * permanents se disputeraient le regard. Le reflet est poussé au thread natif.
 *
 * INTERRUPTEUR D'ARRÊT : `AccessibilityInfo.isReduceMotionEnabled()` rend le
 * badge immobile, reflet au repos. Rien n'est perdu — l'or et le mot portent
 * toute l'information, le passage de lumière n'en ajoute aucune.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { spacing, type } from '@/constants/theme';

/**
 * L'or est écrit ICI, en dur, et ne vient pas du thème.
 *
 * C'est délibéré : un métal n'est pas une couleur de marque qui bascule avec
 * le thème clair ou sombre. Une plaque dorée reste dorée sur fond blanc comme
 * sur fond nuit — c'est même à cela qu'on la reconnaît comme métal. Lui faire
 * suivre le thème la transformerait en simple rectangle coloré.
 */
const OR = {
  /**
   * Champagne presque blanc. C'est l'arête et le haut de la plaque.
   *
   * L'écart de valeur entre cette teinte et `bronze` fait TOUT : une première
   * version gardait quatre ors trop proches, et la plaque se lisait comme une
   * pastille teintée. Un métal n'a pas une couleur, il a une PLAGE — presque
   * blanc là où la lumière frappe, presque brun là où elle n'arrive plus.
   */
  champagne: '#FFF8E3',
  /** Reflet poli, juste sous l'arête. */
  reflet: '#FFE9A8',
  /** Or de cœur — la teinte que l'œil retient. */
  coeur: '#F0B429',
  /** Or profond, sous la ligne de reflet. */
  profond: '#C67C09',
  /** Bronze du bas : la plaque s'éteint dans sa propre ombre. */
  bronze: '#7A4A02',
  /** Bordure frappée, plus sombre que tout le reste. */
  bord: '#5C3702',
  /**
   * Lettres. Brun très sombre plutôt que noir pur : le noir sur or paraît
   * collé, alors qu'un brun profond semble gravé DANS le métal. Contraste très
   * au-delà du seuil exigé.
   */
  encre: '#3B2402',
} as const;

export interface VipBadgeProps {
  /** Libellé affiché. Court par nature — « VIP » tient en trois lettres. */
  label: string;
  /**
   * Version réduite, pour un en-tête déjà chargé.
   * Le relief est conservé : c'est lui qui porte le sens.
   */
  compact?: boolean;
}

export default function VipBadge({ label, compact = false }: VipBadgeProps) {
  const [mouvementReduit, setMouvementReduit] = useState(false);
  const balayage = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let vivant = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(actif => { if (vivant) setMouvementReduit(!!actif); })
      .catch(() => { /* Réglage illisible : l'effet n'est pas critique, on le garde. */ });
    const abonnement = AccessibilityInfo.addEventListener?.(
      'reduceMotionChanged',
      (actif: boolean) => setMouvementReduit(!!actif),
    );
    return () => { vivant = false; abonnement?.remove?.(); };
  }, []);

  useEffect(() => {
    if (mouvementReduit) return;
    // UN passage, puis la valeur reste à 1 et plus rien ne tourne. Le léger
    // retard laisse la carte se poser avant que la lumière ne la traverse :
    // lancé à l'instant du montage, le geste passe inaperçu.
    const animation = Animated.timing(balayage, {
      toValue: 1,
      duration: 1100,
      delay: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [balayage, mouvementReduit]);

  // Assez de hauteur pour que la plage tonale du métal ait la place de se
  // lire : sous 26 dp, reflet et ombre propre se touchent et tout s'aplatit.
  const hauteur = compact ? 26 : 32;
  const padding = compact ? spacing.md : spacing.lg;

  return (
    <View
      // Une seule étiquette pour l'ensemble : un lecteur d'écran doit entendre
      // « VIP », pas traverser quatre dégradés décoratifs.
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[
        styles.socle,
        {
          height: hauteur,
          borderRadius: hauteur / 2,
          // Ombre PORTÉE, avec décalage vers le bas : c'est elle qui décolle la
          // plaque de la carte. Un halo centré sans décalage ne serait qu'un
          // ornement, il ne creuserait aucune profondeur.
          shadowColor: OR.bord,
          shadowOpacity: 0.55,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
          elevation: 6,
        },
      ]}
    >
      {/* ── 1. Corps du métal ────────────────────────────────────────────
          Vertical, pas diagonal : une plaque de cette hauteur se lit d'abord
          de haut en bas, et c'est cet axe qui porte la courbure. Les arrêts
          sont resserrés autour de 0,5 — là où passe la ligne de reflet. */}
      <LinearGradient
        colors={[OR.champagne, OR.reflet, OR.coeur, OR.profond, OR.bronze]}
        locations={[0, 0.2, 0.52, 0.78, 1]}
        start={{ x: 0.3, y: 0 }}
        end={{ x: 0.7, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: hauteur / 2 }]}
        pointerEvents="none"
      />

      {/* ── 2. Reflet PERMANENT ──────────────────────────────────────────
          Une bande claire en travers du tiers supérieur, présente en
          permanence. C'est la pièce maîtresse : un métal poli porte TOUJOURS
          la trace de la lumière. Sans elle, la plaque n'était qu'un dégradé,
          et l'œil y lisait du papier plutôt que du métal. Le balayage animé
          plus bas ne fait que passer PAR-DESSUS. */}
      <LinearGradient
        colors={['rgba(255,255,255,0.55)', 'rgba(255,255,255,0.05)', 'transparent']}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.refletHaut, { borderTopLeftRadius: hauteur / 2, borderTopRightRadius: hauteur / 2 }]}
        pointerEvents="none"
      />

      {/* ── 3. Ombre propre du bas ───────────────────────────────────────
          Le bas de la plaque s'assombrit encore : c'est la partie qui se
          détourne de la lumière. Sans elle, le bord inférieur reste plat. */}
      <LinearGradient
        colors={['transparent', 'rgba(74,44,2,0.45)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.ombreBas, { borderBottomLeftRadius: hauteur / 2, borderBottomRightRadius: hauteur / 2 }]}
        pointerEvents="none"
      />

      {/* ── 4. Biseau ────────────────────────────────────────────────────
          Arête claire en haut, arête sombre en bas. Deux filets d'un pixel,
          et la plaque cesse d'être imprimée sur la carte : elle en sort. */}
      <View
        pointerEvents="none"
        style={[styles.biseau, { borderRadius: hauteur / 2 }]}
      />

      {/* ── 5. Passage de lumière ────────────────────────────────────────
          Il traverse la plaque une fois, en biais, puis disparaît — le reflet
          permanent, lui, reste. Purement décoratif : masqué à l'accessibilité. */}
      {!mouvementReduit && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.balayage,
            {
              transform: [
                { translateX: balayage.interpolate({ inputRange: [0, 1], outputRange: [-80, 80] }) },
                { rotate: '18deg' },
              ],
              opacity: balayage.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.9, 0] }),
            },
          ]}
        >
          <LinearGradient
            colors={['transparent', 'rgba(255,255,255,0.95)', 'transparent']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}

      <View style={[styles.contenu, { paddingHorizontal: padding }]}>
        {/* Le losange à 10 px n'était qu'une tache : à cette taille, un
            pictogramme perd sa silhouette et salit le métal. Les lettres
            portent seules, et elles le font mieux — l'emphase vient de la
            graisse et de l'espacement, jamais d'un second dégradé. */}
        <Text
          style={[
            compact ? type.captionMedium : type.h3,
            {
              color: OR.encre,
              letterSpacing: compact ? 1.6 : 2,
              fontWeight: '800',
              // Ombre portée MINUSCULE sous les lettres : elles semblent
              // frappées dans la plaque plutôt que posées dessus.
              textShadowColor: 'rgba(255,248,227,0.5)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 0,
            },
          ]}
          numberOfLines={1}
          // Le badge ne grandit pas avec le réglage système : il est ancré dans
          // un en-tête, et son sens tient à l'or et à la forme, que
          // l'agrandissement ne touche pas.
          allowFontScaling={false}
        >
          {label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  socle: {
    overflow: 'hidden',
    justifyContent: 'center',
    // Bordure frappée : elle ferme la plaque et empêche l'or clair de se
    // confondre avec un fond clair en thème jour.
    borderWidth: 1,
    borderColor: OR.bord,
  },
  refletHaut: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: '46%',
  },
  ombreBas: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '38%',
  },
  biseau: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: 'transparent',
    // Lumière en haut à gauche, comme partout ailleurs sur cet écran.
    borderTopColor: 'rgba(255,255,255,0.85)',
    borderLeftColor: 'rgba(255,255,255,0.35)',
    borderBottomColor: 'rgba(59,36,2,0.55)',
  },
  balayage: {
    position: 'absolute',
    top: -16,
    bottom: -16,
    width: 20,
  },
  contenu: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
});

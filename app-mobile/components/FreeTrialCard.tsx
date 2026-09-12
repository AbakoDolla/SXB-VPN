/**
 * FreeTrialCard.tsx — « Période d'essai », carte interactive en relief.
 *
 * POURQUOI ELLE EXISTE : l'écran d'un appareil en essai gratuit doit se
 * distinguer immédiatement de celui d'un appareil à accès complet. Cette carte
 * annonce la période d'essai, ce qui a été CONSOMMÉ pendant l'essai, ce qui
 * reste, et la date de fin.
 *
 * QUI DÉCIDE DE L'AFFICHER : l'écran d'accueil, et lui seul, à partir du
 * marqueur d'essai établi par le serveur (une demande d'essai DÉPLOYÉE).
 * Ce composant ne devine rien : il ne lit ni le nom du forfait, ni le quota, ni
 * le réseau. Un appareil à accès complet ne le monte jamais.
 *
 * LE RELIEF suit exactement la convention du bouton d'alimentation : une seule
 * source de lumière en haut à gauche, obtenue par empilement de dégradés. Pas
 * de bibliothèque 3D, pas de dépendance supplémentaire.
 *
 * CE QUE COÛTE L'ANIMATION : rien au repos. Aucune boucle, aucun `setInterval`,
 * aucun rendu périodique — la carte ne bouge QUE pendant que le doigt la
 * touche, et les trois valeurs animées sont poussées au thread natif
 * (`useNativeDriver`), donc sans réveil du fil JavaScript pendant le geste. Au
 * relâchement, un ressort la remet à plat puis tout s'arrête.
 *
 * DEUX INTERRUPTEURS D'ARRÊT :
 *   — `AccessibilityInfo.isReduceMotionEnabled()` : la carte est alors rendue
 *     à plat, sans capteur de geste. Elle reste entièrement lisible : l'effet
 *     n'apporte jamais d'information que le texte ne porte pas déjà.
 *   — `AppState` : hors premier plan, le geste est ignoré et la carte revient
 *     à plat. Rien ne peut continuer à s'animer derrière l'écran.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import { alpha, elevation, glow, radius, spacing, type } from '@/constants/theme';
import { formatBytes } from '@/services/quotaState';
import { Pill, ProgressBar, StatRow, StatTile } from '@/components/ui/Primitives';

export interface FreeTrialCardProps {
  /** Volume consommé pendant l'essai, en octets. */
  usedBytes: number;
  /** Volume restant, en octets. */
  remainingBytes: number;
  /** Volume total accordé à l'essai, en octets. `0` = jamais communiqué. */
  totalBytes: number;
  /** Part consommée, entre 0 et 1. */
  usedRatio: number;
  /** Fin de l'essai, telle que le serveur la donne. */
  endsAt: string | null;
}

/** Amplitude maximale de l'inclinaison : au-delà, la carte se déforme. */
const INCLINAISON = 8;

export default function FreeTrialCard({
  usedBytes,
  remainingBytes,
  totalBytes,
  usedRatio,
  endsAt,
}: FreeTrialCardProps) {
  const colors = useColors();
  const { t, language } = useTranslation();

  // Le volume n'est PAS toujours mesuré : un essai peut être déployé sans
  // volume communiqué. Afficher « 0 o » se lirait « rien consommé », ce qui
  // serait faux ; on le dit donc franchement.
  const volumeConnu = totalBytes > 0;
  const consommationConnue = volumeConnu || usedBytes > 0;
  const nonMesure = t('quota_not_measured');
  const texteConsomme = consommationConnue ? formatBytes(usedBytes) : nonMesure;
  const texteRestant = volumeConnu ? formatBytes(remainingBytes) : nonMesure;
  const texteFin = endsAt
    ? new Date(endsAt).toLocaleDateString(language === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'medium' })
    : t('trial_ends_unknown');

  // ── Mouvement : désactivable, jamais indispensable ─────────────────────────
  const [mouvementReduit, setMouvementReduit] = useState(false);
  useEffect(() => {
    let vivant = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(actif => { if (vivant) setMouvementReduit(!!actif); })
      .catch(() => { /* Réglage illisible : on garde l'effet, il n'est pas critique. */ });
    const abonnement = AccessibilityInfo.addEventListener?.(
      'reduceMotionChanged',
      (actif: boolean) => setMouvementReduit(!!actif),
    );
    return () => { vivant = false; abonnement?.remove?.(); };
  }, []);

  const taille = useRef({ largeur: 1, hauteur: 1 });
  const auPremierPlan = useRef(true);
  const inclinaisonX = useRef(new Animated.Value(0)).current;
  const inclinaisonY = useRef(new Animated.Value(0)).current;
  const appui = useRef(new Animated.Value(0)).current;

  const repos = useCallback(() => {
    for (const valeur of [inclinaisonX, inclinaisonY, appui]) {
      Animated.spring(valeur, { toValue: 0, useNativeDriver: true, speed: 16, bounciness: 6 }).start();
    }
  }, [appui, inclinaisonX, inclinaisonY]);

  useEffect(() => {
    const abonnement = AppState.addEventListener('change', suivant => {
      auPremierPlan.current = suivant === 'active';
      if (suivant !== 'active') repos();
    });
    return () => abonnement.remove();
  }, [repos]);

  const suivreLeDoigt = useCallback((x: number, y: number) => {
    const borne = (valeur: number) => Math.max(-1, Math.min(1, valeur));
    inclinaisonX.setValue(borne((x / Math.max(1, taille.current.largeur)) * 2 - 1));
    inclinaisonY.setValue(borne((y / Math.max(1, taille.current.hauteur)) * 2 - 1));
  }, [inclinaisonX, inclinaisonY]);

  const gestes = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => auPremierPlan.current,
    onMoveShouldSetPanResponder: () => auPremierPlan.current,
    onPanResponderGrant: evenement => {
      Animated.spring(appui, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 0 }).start();
      suivreLeDoigt(evenement.nativeEvent.locationX, evenement.nativeEvent.locationY);
    },
    onPanResponderMove: evenement => {
      if (!auPremierPlan.current) return;
      suivreLeDoigt(evenement.nativeEvent.locationX, evenement.nativeEvent.locationY);
    },
    onPanResponderRelease: repos,
    onPanResponderTerminate: repos,
  }), [appui, repos, suivreLeDoigt]);

  const mesurer = useCallback((evenement: LayoutChangeEvent) => {
    const { width, height } = evenement.nativeEvent.layout;
    taille.current = { largeur: width || 1, hauteur: height || 1 };
  }, []);

  const relief = mouvementReduit ? undefined : [
    // `perspective` doit précéder les rotations, sinon elles restent plates.
    { perspective: 900 },
    { rotateX: inclinaisonY.interpolate({ inputRange: [-1, 1], outputRange: [`${INCLINAISON}deg`, `-${INCLINAISON}deg`] }) },
    { rotateY: inclinaisonX.interpolate({ inputRange: [-1, 1], outputRange: [`-${INCLINAISON}deg`, `${INCLINAISON}deg`] }) },
    { scale: appui.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }) },
  ];

  // Étiquette unique : ce que la carte dit doit être audible d'un seul tenant,
  // sans dépendre de l'ordre de lecture des tuiles.
  const libelle = [
    t('card_trial_period'), t('trial_headline'),
    `${t('trial_used')} ${texteConsomme}`,
    `${t('quota_remaining')} ${texteRestant}`,
    endsAt ? `${t('trial_ends_on')} ${texteFin}` : texteFin,
  ].join('. ');

  return (
    <Animated.View
      onLayout={mesurer}
      accessible
      accessibilityRole="summary"
      accessibilityLabel={libelle}
      {...(mouvementReduit ? {} : gestes.panHandlers)}
      style={[
        styles.carte,
        { borderColor: colors.purple + alpha.f40, backgroundColor: colors.bgCard },
        elevation.md,
        glow(colors.purple, 'sm'),
        relief ? { transform: relief } : null,
      ]}
    >
      {/* Fond en relief : clair en haut à gauche, sombre en bas à droite. */}
      <LinearGradient
        colors={[colors.purple + alpha.f24, colors.purple + alpha.f08, 'rgba(0,0,0,0.22)']}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={styles.fond}
        pointerEvents="none"
      />

      {/* Reflet spéculaire : il glisse avec le doigt et s'intensifie à l'appui.
          C'est lui qui fait lire la carte comme une surface, pas comme une
          image inclinée. Purement décoratif, donc masqué à l'accessibilité. */}
      {!mouvementReduit && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.reflet,
            {
              opacity: appui.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.45] }),
              transform: [
                { translateX: inclinaisonX.interpolate({ inputRange: [-1, 1], outputRange: [-70, 70] }) },
                { translateY: inclinaisonY.interpolate({ inputRange: [-1, 1], outputRange: [-50, 50] }) },
              ],
            },
          ]}
        >
          <LinearGradient
            colors={['rgba(255,255,255,0.32)', 'rgba(255,255,255,0.06)', 'transparent']}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}

      <View style={styles.enTete}>
        <Pill label={t('card_trial_period')} tone={colors.purple} icon="gift-outline" />
        <Ionicons name="hourglass-outline" size={18} color={colors.purple} />
      </View>

      <Text style={[type.h3, { color: colors.textPrimary }]}>{t('trial_headline')}</Text>

      <StatRow>
        <StatTile label={t('trial_used')} value={texteConsomme} tone={colors.purple} monospace />
        <StatTile
          label={t('quota_remaining')}
          value={texteRestant}
          tone={volumeConnu ? colors.connected : colors.textMuted}
          monospace
        />
      </StatRow>

      {volumeConnu && (
        <ProgressBar progress={usedRatio} tone={colors.purple} warnTone={colors.disconnected} />
      )}

      <View style={styles.piedRow}>
        <View style={styles.piedItem}>
          <Ionicons name="calendar-outline" size={13} color={colors.textMuted} />
          <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={1}>
            {endsAt ? `${t('trial_ends_on')} ${texteFin}` : texteFin}
          </Text>
        </View>
        {!mouvementReduit && (
          <Text style={[type.micro, { color: colors.textMuted }]} numberOfLines={1}>
            {t('trial_card_hint')}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  carte: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.md,
    overflow: 'hidden',
  },
  fond: { ...StyleSheet.absoluteFillObject },
  // Le reflet dépasse volontairement du cadre : `overflow: hidden` de la carte
  // le recoupe, ce qui évite un bord net quand il glisse.
  reflet: { position: 'absolute', top: -80, left: -80, right: -80, height: 190 },
  enTete: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  piedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  piedItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
});

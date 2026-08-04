/**
 * StepLogs — Parcours de connexion VPN, unifié et animé.
 *
 * Écran UNIQUE affiché à l'utilisateur pendant la connexion : chaque étape
 * technique (preparing → security → permission → config → provisioning →
 * payload/handshake → tunnel → engine → connected) est traduite en un message
 * clair (fr/en) et animée (apparition douce, check animé, transitions 250 ms).
 *
 * L'écran se termine sur un état final « ✅ Connecté » légèrement animé.
 *
 * Les logs techniques bruts sont accessibles ailleurs, uniquement sur clic
 * (« Voir les logs de connexion »). StepLogs n'affiche PAS ces logs bruts.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';
import { useTranslation } from '@/localization';

export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'warning';

export interface StepLogItem {
  key: string;
  translationKey: string;
  status: StepStatus;
  timestamp?: string;
  detail?: string;
}

interface StepLogsProps {
  steps: StepLogItem[];
  visible: boolean;
}

const TRANSITION_MS = 250; // transitions douces demandées

// Table des étapes visibles à l'utilisateur. Chaque étape technique reçoit
// une explication grand public — la clé i18n est résolue via t().
const STATUS_CONFIG: Record<StepStatus, { icon: string; color: string; bgColor: string }> = {
  pending:  { icon: 'ellipse-outline',     color: Colors.textMuted,    bgColor: 'transparent' },
  active:   { icon: 'sync',                color: Colors.primary,      bgColor: Colors.primaryDim },
  done:     { icon: 'checkmark-circle',    color: Colors.connected,    bgColor: Colors.connectedDim },
  error:    { icon: 'close-circle',        color: Colors.disconnected, bgColor: Colors.disconnectedDim },
  warning:  { icon: 'warning',             color: Colors.warning,      bgColor: Colors.warningDim },
};

// ── Explication grand public par étape ────────────────────────────────────────
// Table (translationKey d'origine) → clé « friendly » ajoutée dans fr/en.
// Si la clé friendly n'existe pas, on retombe sur la clé d'origine.
const FRIENDLY_MAP: Record<string, string> = {
  step_preparing:            'friendly_preparing',
  step_checking_security:    'friendly_security',
  step_security_ok:          'friendly_security_ok',
  step_permission_check:     'friendly_permission',
  step_permission_granted:   'friendly_permission_ok',
  step_permission_denied:    'friendly_permission_denied',
  step_loading_config:       'friendly_config',
  step_config_loaded:        'friendly_config_ok',
  step_provisioning:         'friendly_provisioning',
  step_provisioned:          'friendly_provisioning_ok',
  step_syncing:              'friendly_syncing',
  step_synced:               'friendly_synced',
  step_quota_check:          'friendly_quota',
  step_quota_ok:             'friendly_quota_ok',
  step_quota_exhausted:      'friendly_quota_exhausted',
  step_expired:              'friendly_expired',
  step_connecting:           'friendly_connecting',
  step_handshake:            'friendly_handshake',
  step_establishing_tunnel:  'friendly_tunnel',
  step_tunnel_ready:         'friendly_tunnel_ok',
  step_vpn_active:           'friendly_connected',
  step_disconnecting:        'friendly_disconnecting',
  step_disconnected:         'friendly_disconnected',
  step_reconnecting:         'friendly_reconnecting',
  step_revoked:              'friendly_revoked',
  step_suspended:            'friendly_suspended',
  step_error:                'friendly_error',
};

function StepRow({ step, index }: { step: StepLogItem; index: number }) {
  const { t } = useTranslation();
  // Apparition douce quand l'étape entre dans la liste.
  const enter = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(step.status === 'pending' ? 0.4 : 1)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const checkScale = useRef(new Animated.Value(step.status === 'done' ? 1 : 0)).current;

  useEffect(() => {
    // Fade-in initial (transition 250 ms)
    Animated.timing(enter, {
      toValue: 1,
      duration: TRANSITION_MS,
      delay: index * 60,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [enter, index]);

  useEffect(() => {
    if (step.status === 'active') {
      Animated.timing(fade, { toValue: 1, duration: TRANSITION_MS, useNativeDriver: true }).start();
      // Pulsation douce sur l'étape en cours
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.12, duration: 700, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1,    duration: 700, useNativeDriver: true }),
        ])
      ).start();
    } else if (step.status === 'done') {
      pulse.stopAnimation();
      pulse.setValue(1);
      fade.setValue(1);
      // Check animé (pop léger)
      Animated.spring(checkScale, {
        toValue: 1,
        speed: 14,
        bounciness: 8,
        useNativeDriver: true,
      }).start();
    } else if (step.status === 'error' || step.status === 'warning') {
      pulse.stopAnimation();
      pulse.setValue(1);
      fade.setValue(1);
    } else {
      Animated.timing(fade, { toValue: 0.4, duration: TRANSITION_MS, useNativeDriver: true }).start();
    }
  }, [step.status, fade, pulse, checkScale]);

  const cfg = STATUS_CONFIG[step.status];
  const friendlyKey = FRIENDLY_MAP[step.translationKey];
  // Résolution : essayer friendly, sinon retomber sur la clé d'origine.
  const friendlyLabel = friendlyKey ? t(friendlyKey as any) : '';
  const fallbackLabel = t(step.translationKey as any);
  const label = friendlyLabel && friendlyLabel !== friendlyKey ? friendlyLabel : (fallbackLabel || step.key);

  const ts = step.timestamp ? new Date(step.timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : null;

  const translateY = enter.interpolate({ inputRange: [0, 1], outputRange: [6, 0] });

  return (
    <Animated.View style={[styles.stepRow, { opacity: Animated.multiply(fade, enter), transform: [{ translateY }] }]}>
      {/* Timeline connector */}
      <View style={styles.timeline}>
        <Animated.View style={[
          styles.dot,
          { backgroundColor: cfg.color, borderColor: cfg.color, transform: [{ scale: pulse }] },
          step.status === 'active' && styles.dotActive,
        ]} />
        {index < 99 && (
          <View style={[
            styles.line,
            { backgroundColor: step.status === 'done' ? Colors.connected : Colors.border },
          ]} />
        )}
      </View>

      {/* Contenu (message grand public) */}
      <View style={[styles.stepContent, { backgroundColor: cfg.bgColor }]}>
        <View style={styles.stepHeader}>
          {step.status === 'done' ? (
            <Animated.View style={{ transform: [{ scale: checkScale }] }}>
              <Ionicons name="checkmark-circle" size={16} color={cfg.color} style={styles.stepIcon} />
            </Animated.View>
          ) : (
            <Ionicons name={cfg.icon as any} size={16} color={cfg.color} style={styles.stepIcon} />
          )}
          <Text style={[styles.stepLabel, { color: step.status === 'pending' ? Colors.textMuted : Colors.textPrimary }]}>
            {label}
          </Text>
          {ts && <Text style={styles.stepTime}>{ts}</Text>}
        </View>
        {step.detail && (
          <Text style={styles.stepDetail} numberOfLines={2}>
            {step.detail}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

// État final animé « ✅ Connecté » — apparaît lorsque la dernière étape passe done.
function FinalConnected() {
  const { t } = useTranslation();
  const scale = useRef(new Animated.Value(0.8)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: TRANSITION_MS, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, speed: 12, bounciness: 10, useNativeDriver: true }),
    ]).start();
  }, [opacity, scale]);
  return (
    <Animated.View style={[styles.finalBox, { opacity, transform: [{ scale }] }]}>
      <Ionicons name="checkmark-circle" size={20} color={Colors.connected} />
      <Text style={styles.finalText}>{t('friendly_connected_final')}</Text>
    </Animated.View>
  );
}

export default function StepLogs({ steps, visible }: StepLogsProps) {
  const { t } = useTranslation();
  // Titre grand public au-dessus de la liste — traduit via t().
  const header = useMemo(() => t('friendly_header'), [t]);
  if (!visible || steps.length === 0) return null;
  const last = steps[steps.length - 1];
  const showFinal = last && last.key === 'connected' && last.status === 'done';

  return (
    <View style={styles.container} accessibilityLabel={t('friendly_a11y_progress')}>
      {header ? <Text style={styles.header}>{header}</Text> : null}
      {steps.map((step, i) => (
        <StepRow key={step.key} step={step} index={i} />
      ))}
      {showFinal && <FinalConnected />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  header: {
    fontSize: 12,
    color: Colors.textMuted,
    fontFamily: 'Inter_500Medium',
    marginBottom: 8,
    marginLeft: 4,
    letterSpacing: 0.5,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 40,
  },
  timeline: {
    width: 24,
    alignItems: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    marginTop: 6,
  },
  dotActive: {
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
    elevation: 4,
  },
  line: {
    width: 2,
    flex: 1,
    minHeight: 20,
    marginTop: 2,
  },
  stepContent: {
    flex: 1,
    marginLeft: 8,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginBottom: 4,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepIcon: {
    marginRight: 6,
  },
  stepLabel: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    flex: 1,
  },
  stepTime: {
    fontSize: 10,
    color: Colors.textMuted,
    fontFamily: 'Inter_400Regular',
    marginLeft: 8,
  },
  stepDetail: {
    fontSize: 11,
    color: Colors.textMuted,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
    marginLeft: 22,
  },
  finalBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: Colors.connectedDim,
    borderWidth: 1,
    borderColor: Colors.connected + '40',
  },
  finalText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.connected,
  },
});

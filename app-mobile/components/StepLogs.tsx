/**
 * StepLogs — Modern step-by-step VPN connection logs
 *
 * Displays bilingual (FR/EN) step-by-step progress during VPN connection.
 * Each step has an icon, label, and status (pending/active/done/error).
 *
 * Usage:
 *   <StepLogs steps={steps} visible={true} />
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
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

const STATUS_CONFIG: Record<StepStatus, { icon: string; color: string; bgColor: string }> = {
  pending:  { icon: 'ellipse-outline',     color: Colors.textMuted,    bgColor: 'transparent' },
  active:   { icon: 'sync',                color: Colors.primary,      bgColor: Colors.primaryDim },
  done:     { icon: 'checkmark-circle',    color: Colors.connected,    bgColor: Colors.connectedDim },
  error:    { icon: 'close-circle',        color: Colors.disconnected, bgColor: Colors.disconnectedDim },
  warning:  { icon: 'warning',             color: Colors.warning,      bgColor: Colors.warningDim },
};

function StepRow({ step, index }: { step: StepLogItem; index: number }) {
  const { t } = useTranslation();
  const fadeAnim = useRef(new Animated.Value(step.status === 'pending' ? 0.4 : 1)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (step.status === 'active') {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.loop(
          Animated.sequence([
            Animated.timing(scaleAnim, { toValue: 1.15, duration: 800, useNativeDriver: true }),
            Animated.timing(scaleAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
          ])
        ),
      ]).start();
    } else if (step.status === 'done' || step.status === 'error') {
      fadeAnim.setValue(1);
      scaleAnim.setValue(1);
    } else {
      Animated.timing(fadeAnim, { toValue: 0.4, duration: 200, useNativeDriver: true }).start();
    }
  }, [step.status]);

  const cfg = STATUS_CONFIG[step.status];
  const label = t(step.translationKey as any) || step.key;
  const ts = step.timestamp ? new Date(step.timestamp).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : null;

  return (
    <Animated.View style={[styles.stepRow, { opacity: fadeAnim }]}>
      {/* Timeline connector */}
      <View style={styles.timeline}>
        <Animated.View style={[
          styles.dot,
          { backgroundColor: cfg.color, borderColor: cfg.color, transform: [{ scale: scaleAnim }] },
          step.status === 'active' && styles.dotActive,
        ]} />
        {index < 99 && <View style={[styles.line, { backgroundColor: step.status === 'done' ? Colors.connected : Colors.border }]} />}
      </View>

      {/* Content */}
      <View style={[styles.stepContent, { backgroundColor: cfg.bgColor }]}>
        <View style={styles.stepHeader}>
          <Ionicons name={cfg.icon as any} size={16} color={cfg.color} style={styles.stepIcon} />
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

export default function StepLogs({ steps, visible }: StepLogsProps) {
  if (!visible || steps.length === 0) return null;

  return (
    <View style={styles.container}>
      {steps.map((step, i) => (
        <StepRow key={step.key} step={step} index={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 8,
    paddingHorizontal: 4,
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
});

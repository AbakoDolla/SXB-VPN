import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';

interface VpnStatusCardProps {
  isConnected: boolean;
  isConnecting: boolean;
}

export default function VpnStatusCard({ isConnected, isConnecting }: VpnStatusCardProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const dotOpacity = useSharedValue(1);

  useEffect(() => {
    if (isConnected || isConnecting) {
      dotOpacity.value = withRepeat(
        withSequence(
          withTiming(0.2, { duration: 700 }),
          withTiming(1, { duration: 700 }),
        ),
        -1,
        false,
      );
    } else {
      dotOpacity.value = withTiming(1, { duration: 300 });
    }
  }, [isConnected, isConnecting]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  const statusColor = isConnecting
    ? colors.connecting
    : isConnected
    ? colors.connected
    : colors.mutedForeground;

  const label = isConnecting
    ? t('connecting_status')
    : isConnected
    ? t('protection_active')
    : t('protection_inactive');

  const icon: keyof typeof Ionicons.glyphMap = isConnected
    ? 'shield-checkmark'
    : 'shield-outline';

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Ionicons name={icon} size={22} color={statusColor} />
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      <View style={styles.indicator}>
        <Animated.View
          style={[styles.dot, { backgroundColor: statusColor }, dotStyle]}
        />
        <Text style={[styles.status, { color: statusColor }]}>
          {isConnected ? 'ON' : 'OFF'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
  },
  label: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500' as const,
  },
  indicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  status: {
    fontSize: 13,
    fontWeight: '700' as const,
    letterSpacing: 1,
  },
});

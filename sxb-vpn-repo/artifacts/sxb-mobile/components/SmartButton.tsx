import React, { useCallback, useEffect } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import type { SmartButtonState } from '@/types/api';

interface SmartButtonProps {
  state: SmartButtonState;
  onPress: () => void;
  disabled?: boolean;
}

const BUTTON_SIZE = 176;
const RING_OFFSET = 36;
const RING_SIZE = BUTTON_SIZE + RING_OFFSET;

export default function SmartButton({ state, onPress, disabled = false }: SmartButtonProps) {
  const colors = useColors();
  const { t } = useTranslation();

  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);
  const buttonScale = useSharedValue(1);
  const glowOpacity = useSharedValue(0);

  const isConnected = state === 'connected';
  const isAnimating = state === 'connecting' || state === 'disconnecting';

  useEffect(() => {
    if (isConnected) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 0 }),
          withTiming(1.25, { duration: 1100, easing: Easing.out(Easing.ease) }),
        ),
        -1,
        false,
      );
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.55, { duration: 0 }),
          withTiming(0, { duration: 1100 }),
        ),
        -1,
        false,
      );
      glowOpacity.value = withTiming(1, { duration: 600 });
    } else {
      pulseScale.value = withTiming(1, { duration: 300 });
      pulseOpacity.value = withTiming(0, { duration: 300 });
      glowOpacity.value = withTiming(0, { duration: 400 });
    }
  }, [isConnected]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  const buttonPressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const getColor = useCallback((): string => {
    switch (state) {
      case 'no_account': return colors.muted;
      case 'no_package': return colors.primary;
      case 'connect': return colors.primary;
      case 'connecting': return colors.connecting;
      case 'connected': return colors.connected;
      case 'disconnecting': return colors.connecting;
      case 'expired': return colors.warning;
      case 'suspended': return colors.destructive;
      default: return colors.muted;
    }
  }, [state, colors]);

  const getIcon = (): keyof typeof Ionicons.glyphMap => {
    switch (state) {
      case 'no_account': return 'shield-outline';
      case 'no_package': return 'add-circle-outline';
      case 'connect': return 'shield';
      case 'connecting': return 'shield';
      case 'connected': return 'shield-checkmark';
      case 'disconnecting': return 'shield';
      case 'expired': return 'refresh-circle-outline';
      case 'suspended': return 'alert-circle-outline';
      default: return 'shield-outline';
    }
  };

  const getLabel = (): string => {
    switch (state) {
      case 'no_account': return t('activate_account');
      case 'no_package': return t('activate_plan');
      case 'connect': return t('connect');
      case 'connecting': return t('connecting');
      case 'connected': return t('disconnect');
      case 'disconnecting': return t('disconnecting');
      case 'expired': return t('renew_plan');
      case 'suspended': return t('contact_support');
      default: return '';
    }
  };

  const btnColor = getColor();

  const handlePress = () => {
    if (disabled) return;
    buttonScale.value = withSequence(
      withTiming(0.91, { duration: 90 }),
      withTiming(1.03, { duration: 120 }),
      withTiming(1, { duration: 100 }),
    );
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  return (
    <View style={styles.wrapper}>
      {/* Glow shadow */}
      <Animated.View
        style={[
          styles.glow,
          { width: BUTTON_SIZE + 60, height: BUTTON_SIZE + 60, borderRadius: (BUTTON_SIZE + 60) / 2, backgroundColor: btnColor },
          glowStyle,
        ]}
      />

      {/* Pulsing ring */}
      <Animated.View
        style={[
          styles.ring,
          {
            width: RING_SIZE,
            height: RING_SIZE,
            borderRadius: RING_SIZE / 2,
            borderColor: btnColor,
          },
          pulseStyle,
        ]}
      />

      {/* Inner ring */}
      <View
        style={[
          styles.innerRing,
          {
            width: BUTTON_SIZE + 16,
            height: BUTTON_SIZE + 16,
            borderRadius: (BUTTON_SIZE + 16) / 2,
            borderColor: `${btnColor}55`,
          },
        ]}
      />

      {/* Button */}
      <Pressable onPress={handlePress} disabled={disabled || isAnimating}>
        <Animated.View
          style={[
            styles.button,
            {
              width: BUTTON_SIZE,
              height: BUTTON_SIZE,
              borderRadius: BUTTON_SIZE / 2,
              backgroundColor: btnColor,
              shadowColor: btnColor,
            },
            buttonPressStyle,
          ]}
        >
          {isAnimating ? (
            <ActivityIndicator size="large" color="#FFFFFF" />
          ) : (
            <Ionicons name={getIcon()} size={52} color="#FFFFFF" />
          )}
        </Animated.View>
      </Pressable>

      {/* Label */}
      <Text style={[styles.label, { color: btnColor }]}>{getLabel()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  glow: {
    position: 'absolute',
    opacity: 0.12,
  },
  ring: {
    position: 'absolute',
    borderWidth: 2,
  },
  innerRing: {
    position: 'absolute',
    borderWidth: 1,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 14,
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.45,
        shadowRadius: 20,
      },
      android: {},
      default: {},
    }),
  },
  label: {
    marginTop: 28,
    fontSize: 16,
    fontWeight: '600' as const,
    letterSpacing: 0.3,
  },
});

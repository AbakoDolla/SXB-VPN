import React, { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
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

  const pulseScale = useRef(new Animated.Value(1)).current;
  const pulseOpacity = useRef(new Animated.Value(0)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef<Animated.CompositeAnimation | null>(null);

  const isConnected = state === 'connected';
  const isAnimating = state === 'connecting' || state === 'disconnecting';

  useEffect(() => {
    if (pulseAnim.current) {
      pulseAnim.current.stop();
    }

    if (isConnected) {
      pulseAnim.current = Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(pulseScale, { toValue: 1, duration: 0, useNativeDriver: true }),
            Animated.timing(pulseScale, { toValue: 1.25, duration: 1100, useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(pulseOpacity, { toValue: 0.55, duration: 0, useNativeDriver: true }),
            Animated.timing(pulseOpacity, { toValue: 0, duration: 1100, useNativeDriver: true }),
          ]),
        ])
      );
      pulseAnim.current.start();
      Animated.timing(glowOpacity, { toValue: 1, duration: 600, useNativeDriver: true }).start();
    } else {
      Animated.parallel([
        Animated.timing(pulseScale, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(pulseOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(glowOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start();
    }
  }, [isConnected]);

  const getColor = useCallback((): string => {
    switch (state) {
      case 'no_account':    return colors.muted;
      case 'no_package':   return colors.primary;
      case 'connect':      return colors.primary;
      case 'connecting':   return colors.connecting;
      case 'connected':    return colors.connected;
      case 'disconnecting': return colors.connecting;
      case 'expired':      return colors.warning;
      case 'suspended':    return colors.destructive;
      default:             return colors.muted;
    }
  }, [state, colors]);

  const getIcon = (): keyof typeof Ionicons.glyphMap => {
    switch (state) {
      case 'no_account':    return 'shield-outline';
      case 'no_package':   return 'add-circle-outline';
      case 'connect':      return 'shield';
      case 'connecting':   return 'shield';
      case 'connected':    return 'shield-checkmark';
      case 'disconnecting': return 'shield';
      case 'expired':      return 'refresh-circle-outline';
      case 'suspended':    return 'alert-circle-outline';
      default:             return 'shield-outline';
    }
  };

  const getLabel = (): string => {
    switch (state) {
      case 'no_account':    return t('activate_account');
      case 'no_package':   return t('activate_plan');
      case 'connect':      return t('connect');
      case 'connecting':   return t('connecting');
      case 'connected':    return t('disconnect');
      case 'disconnecting': return t('disconnecting');
      case 'expired':      return t('renew_plan');
      case 'suspended':    return t('contact_support');
      default:             return '';
    }
  };

  const btnColor = getColor();

  return (
    <View style={styles.wrapper}>
      {/* Glow */}
      <Animated.View
        style={[
          styles.glow,
          {
            width: RING_SIZE + 40,
            height: RING_SIZE + 40,
            borderRadius: (RING_SIZE + 40) / 2,
            backgroundColor: btnColor,
            opacity: glowOpacity,
          },
        ]}
      />

      {/* Pulse ring */}
      <Animated.View
        style={[
          styles.ring,
          {
            width: RING_SIZE,
            height: RING_SIZE,
            borderRadius: RING_SIZE / 2,
            borderColor: btnColor,
            transform: [{ scale: pulseScale }],
            opacity: pulseOpacity,
          },
        ]}
      />

      {/* Inner static ring */}
      <View
        style={[
          styles.innerRing,
          {
            width: BUTTON_SIZE + 16,
            height: BUTTON_SIZE + 16,
            borderRadius: (BUTTON_SIZE + 16) / 2,
            borderColor: btnColor + '40',
          },
        ]}
      />

      <Pressable
        onPress={disabled ? undefined : onPress}
        onPressIn={() => {
          Animated.timing(buttonScale, {
            toValue: 0.95,
            duration: 100,
            useNativeDriver: true,
          }).start();
          if (!disabled) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }}
        onPressOut={() => {
          Animated.timing(buttonScale, {
            toValue: 1,
            duration: 100,
            useNativeDriver: true,
          }).start();
        }}
      >
        <Animated.View
          style={[
            styles.button,
            {
              width: BUTTON_SIZE,
              height: BUTTON_SIZE,
              borderRadius: BUTTON_SIZE / 2,
              backgroundColor: btnColor,
              transform: [{ scale: buttonScale }],
            },
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

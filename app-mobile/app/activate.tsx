
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path, Circle } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { useAuthContext } from '@/contexts/AuthContext';
import { useTranslation } from '@/localization';
import TokenInput from '@/components/TokenInput';
import LoadingOverlay from '@/components/LoadingOverlay';

function ShieldIcon({ size = 60 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      <Path
        d="M30 4 L56 14 L56 34 C56 47 45 56 30 59 C15 56 4 47 4 34 L4 14 Z"
        fill="rgba(91,141,239,0.15)"
        stroke="#5B8DEF"
        strokeWidth={2}
      />
      <Path
        d="M20 31 L27 38 L41 24"
        stroke="#00E5A0"
        strokeWidth={3.5}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function DeviceIdBox({ deviceId, onCopy }: { deviceId: string; onCopy: () => void }) {
  const colors = useColors();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!deviceId) return null;

  return (
    <View style={[styles.deviceBox, { borderColor: 'rgba(91,141,239,0.3)', backgroundColor: 'rgba(91,141,239,0.06)' }]}>
      <View style={styles.deviceBoxHeader}>
        <Ionicons name="phone-portrait-outline" size={14} color="#5B8DEF" />
        <Text style={[styles.deviceBoxLabel, { color: '#5B8DEF' }]}>ID de votre appareil</Text>
      </View>
      <View style={styles.deviceBoxRow}>
        <Text style={[styles.deviceBoxId, { color: '#fff' }]} numberOfLines={1} selectable>
          {deviceId}
        </Text>
        <Pressable onPress={handleCopy} style={styles.copyBtn} hitSlop={8}>
          <Ionicons
            name={copied ? 'checkmark-circle' : 'copy-outline'}
            size={20}
            color={copied ? '#00E5A0' : '#5B8DEF'}
          />
        </Pressable>
      </View>
      <Text style={[styles.deviceBoxHint, { color: 'rgba(255,255,255,0.4)' }]}>
        Copiez cet ID et donnez-le à votre administrateur pour recevoir votre token d'activation.
      </Text>
    </View>
  );
}

export default function ActivateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { activateAccount, isAuthenticated, deviceId } = useAuthContext();
  const { t } = useTranslation();

  const [token, setToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const successScale = useRef(new Animated.Value(0)).current;
  const [showSuccess, setShowSuccess] = useState(false);

  const handleCopyDeviceId = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    // Clipboard copy via Alert fallback if expo-clipboard not installed
    try {
      const { Clipboard } = require('react-native');
      Clipboard.setString(deviceId);
    } catch {
      // expo-clipboard not available, user can use selectable text
    }
  };

  const handleActivate = async () => {
    if (!token.trim()) {
      setError(t('error_invalid_token'));
      return;
    }
    setError('');
    setIsLoading(true);
    try {
      await activateAccount(token.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowSuccess(true);
      Animated.spring(successScale, {
        toValue: 1,
        tension: 80,
        friction: 6,
        useNativeDriver: true,
      }).start();
      setTimeout(() => router.replace('/(tabs)/'), 1400);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg: string = err?.response?.data?.message ?? '';
      if (err?.response?.status === 404) {
        setError(t('error_invalid_token'));
      } else if (err?.response?.status === 403) {
        if (msg.includes('appareil') || msg.includes('device')) {
          setError('Ce token est lié à un autre appareil.');
        } else if (msg.includes('expiré') || msg.includes('expired')) {
          setError(t('error_expired_token'));
        } else {
          setError(t('error_suspended'));
        }
      } else if (msg.includes('expir')) {
        setError(t('error_expired_token'));
      } else if (!msg && err?.message?.includes('Network')) {
        setError(t('error_no_network'));
      } else {
        setError(t('error_generic'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <LinearGradient colors={['#080B14', '#0D1530', '#080B14']} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Icon */}
        <View style={styles.iconWrap}>
          <ShieldIcon size={80} />
        </View>

        {/* Title */}
        <Text style={styles.title}>{t('activate_account_title')}</Text>
        <Text style={[styles.desc, { color: colors.mutedForeground }]}>
          {t('activate_account_desc')}
        </Text>

        {/* Step 1: Device ID */}
        <View style={styles.stepSection}>
          <View style={styles.stepHeader}>
            <View style={styles.stepBadge}>
              <Text style={styles.stepNum}>1</Text>
            </View>
            <Text style={[styles.stepLabel, { color: 'rgba(255,255,255,0.7)' }]}>
              Copiez votre ID appareil
            </Text>
          </View>
          <DeviceIdBox deviceId={deviceId} onCopy={handleCopyDeviceId} />
        </View>

        {/* Step 2: Enter token */}
        <View style={styles.stepSection}>
          <View style={styles.stepHeader}>
            <View style={styles.stepBadge}>
              <Text style={styles.stepNum}>2</Text>
            </View>
            <Text style={[styles.stepLabel, { color: 'rgba(255,255,255,0.7)' }]}>
              Entrez votre token d'activation
            </Text>
          </View>
          <View style={styles.inputSection}>
            <TokenInput
              value={token}
              onChange={(v) => { setToken(v); setError(''); }}
              placeholder={t('token_user_placeholder')}
              error={error}
            />
          </View>
        </View>

        {/* Format hint */}
        <View style={styles.helpRow}>
          <Ionicons name="information-circle-outline" size={14} color={colors.mutedForeground} />
          <Text style={[styles.helpText, { color: colors.mutedForeground }]}>
            Format : SXB-USER-XXXX-XXXX-XXXX
          </Text>
        </View>

        {/* Activate button */}
        <Pressable
          onPress={handleActivate}
          disabled={isLoading || !token.trim()}
          style={({ pressed }) => [
            styles.btn,
            {
              opacity: isLoading || !token.trim() ? 0.5 : pressed ? 0.85 : 1,
              backgroundColor: 'rgba(91,141,239,0.18)',
              borderWidth: 1.5,
              borderColor: 'rgba(91,141,239,0.4)',
              marginTop: 24,
            },
          ]}
        >
          <Ionicons name="shield-checkmark" size={20} color="#fff" />
          <Text style={styles.btnText}>{t('activate')}</Text>
        </Pressable>

        {isLoading && <LoadingOverlay />}

        {/* Success overlay */}
        {showSuccess && (
          <View style={styles.successOverlay}>
            <Animated.View
              style={[
                styles.successCard,
                {
                  transform: [{ scale: successScale }],
                  backgroundColor: '#0D1530',
                  borderColor: '#00E5A0',
                },
              ]}
            >
              <Ionicons name="checkmark-circle" size={56} color="#00E5A0" />
              <Text style={[styles.successText, { color: '#fff' }]}>
                Compte activé !{'\n'}Bienvenue sur SXB VPN
              </Text>
            </Animated.View>
          </View>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 24,
    gap: 0,
  },
  iconWrap: {
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginBottom: 10,
  },
  desc: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    fontFamily: 'Inter_400Regular',
    marginBottom: 32,
  },
  stepSection: {
    marginBottom: 20,
    gap: 10,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  stepBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(91,141,239,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(91,141,239,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNum: {
    color: '#5B8DEF',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  stepLabel: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    fontWeight: '500',
  },
  deviceBox: {
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 14,
    gap: 8,
  },
  deviceBoxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deviceBoxLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  deviceBoxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deviceBoxId: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  copyBtn: {
    padding: 4,
  },
  deviceBoxHint: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    lineHeight: 17,
  },
  inputSection: {
    gap: 12,
  },
  helpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  helpText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 16,
    paddingVertical: 18,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,11,20,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successCard: {
    padding: 36,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: 'center',
    gap: 16,
  },
  successText: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    fontFamily: 'Inter_600SemiBold',
  },
});

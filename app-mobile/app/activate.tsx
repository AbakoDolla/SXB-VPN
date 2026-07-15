import React, { useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { useAuthContext } from '@/contexts/AuthContext';
import { useTranslation } from '@/localization';
import TokenInput from '@/components/TokenInput';
import LoadingOverlay from '@/components/LoadingOverlay';

function ShieldIcon({ size = 60 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      <Path d="M30 4 L56 14 L56 34 C56 47 45 56 30 59 C15 56 4 47 4 34 L4 14 Z" fill="rgba(91,141,239,0.15)" stroke="#5B8DEF" strokeWidth={2} />
      <Path d="M20 31 L27 38 L41 24" stroke="#00E5A0" strokeWidth={3.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function ActivateScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { activateAccount, isAuthenticated } = useAuthContext();
  const { t } = useTranslation();

  const [token, setToken] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const successScale = useRef(new Animated.Value(0)).current;
  const [showSuccess, setShowSuccess] = useState(false);

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
      Animated.spring(successScale, { toValue: 1, tension: 80, friction: 6, useNativeDriver: true }).start();
      setTimeout(() => router.replace('/(tabs)/'), 1400);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg: string = err?.response?.data?.message ?? '';
      if (err?.response?.status === 404) {
        setError(t('error_invalid_token'));
      } else if (err?.response?.status === 403) {
        setError(t('error_suspended'));
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
          { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 40 },
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

        {/* Token input */}
        <View style={styles.inputSection}>
          <TokenInput
            value={token}
            onChange={(v) => { setToken(v); setError(''); }}
            placeholder={t('token_user_placeholder')}
            error={error}
          />
        </View>

        {/* Activate button */}
        <Pressable
          onPress={handleActivate}
          disabled={isLoading || !token.trim()}
          style={({ pressed }) => [
            styles.btn,
            {
              backgroundColor: token.trim() ? colors.primary : colors.muted,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Ionicons name="shield-checkmark" size={18} color="#FFF" />
          <Text style={styles.btnText}>
            {isLoading ? t('activating') : t('activate')}
          </Text>
        </Pressable>

        {/* Help text */}
        <View style={styles.helpRow}>
          <Ionicons name="information-circle-outline" size={16} color={colors.mutedForeground} />
          <Text style={[styles.helpText, { color: colors.mutedForeground }]}>
            Format : SXB-USER-XXXX-XXXX-XXXX
          </Text>
        </View>
      </ScrollView>

      {/* Success overlay */}
      {showSuccess && (
        <View style={styles.successOverlay}>
          <Animated.View
            style={[
              styles.successCard,
              { backgroundColor: colors.card, borderColor: colors.connected, transform: [{ scale: successScale }] },
            ]}
          >
            <Ionicons name="checkmark-circle" size={52} color={colors.connected} />
            <Text style={[styles.successText, { color: colors.foreground }]}>
              {t('activation_success')}
            </Text>
          </Animated.View>
        </View>
      )}

      {isLoading && !showSuccess && <LoadingOverlay message={t('activating')} />}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 28,
    alignItems: 'stretch',
    gap: 20,
  },
  iconWrap: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  title: {
    fontSize: 26,
    fontWeight: '700' as const,
    color: '#F0F4FF',
    textAlign: 'center',
    fontFamily: 'Inter_700Bold',
  },
  desc: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    fontFamily: 'Inter_400Regular',
  },
  inputSection: {
    gap: 12,
    marginTop: 8,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 16,
    paddingVertical: 18,
    marginTop: 4,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600' as const,
    fontFamily: 'Inter_600SemiBold',
  },
  helpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  helpText: {
    fontSize: 13,
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
    fontWeight: '600' as const,
    textAlign: 'center',
  },
});

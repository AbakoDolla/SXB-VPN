import React, { useRef, useState } from 'react';
import {
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
import { useColors } from '@/hooks/useColors';
import { useAuthContext } from '@/contexts/AuthContext';
import { useTranslation } from '@/localization';
import TokenInput from '@/components/TokenInput';
import LoadingOverlay from '@/components/LoadingOverlay';

export default function PlanScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { activatePlan, accountState } = useAuthContext();
  const { t } = useTranslation();

  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  const successScale = useRef(new Animated.Value(0)).current;

  const handleActivate = async () => {
    if (!code.trim()) {
      setError(t('error_invalid_token'));
      return;
    }
    setError('');
    setIsLoading(true);
    try {
      await activatePlan(code.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowSuccess(true);
      Animated.spring(successScale, { toValue: 1, tension: 80, friction: 6, useNativeDriver: true }).start();
      setTimeout(() => router.back(), 1600);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (err?.response?.status === 404) setError(t('error_invalid_token'));
      else if (err?.response?.status === 403) setError(t('error_expired_token'));
      else if (!err?.response && err?.message?.includes('Network')) setError(t('error_no_network'));
      else setError(t('error_generic'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Handle bar */}
      <View style={[styles.handle, { backgroundColor: colors.border }]} />

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={[styles.iconBg, { backgroundColor: `${colors.primary}22` }]}>
            <Ionicons name="cube-outline" size={28} color={colors.primary} />
          </View>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="close" size={24} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <Text style={[styles.title, { color: colors.foreground }]}>{t('activate_plan_title')}</Text>
        <Text style={[styles.desc, { color: colors.mutedForeground }]}>{t('activate_plan_desc')}</Text>

        <TokenInput
          value={code}
          onChange={(v) => { setCode(v); setError(''); }}
          placeholder={t('token_data_placeholder')}
          error={error}
        />

        <Pressable
          onPress={handleActivate}
          disabled={isLoading || !code.trim()}
          style={({ pressed }) => [
            styles.btn,
            {
              backgroundColor: code.trim() ? colors.connected : colors.muted,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
        >
          <Ionicons name="add-circle-outline" size={18} color="#FFF" />
          <Text style={styles.btnText}>
            {isLoading ? t('plan_activating') : t('activate')}
          </Text>
        </Pressable>

        <View style={styles.helpRow}>
          <Ionicons name="information-circle-outline" size={16} color={colors.mutedForeground} />
          <Text style={[styles.helpText, { color: colors.mutedForeground }]}>
            Format : SXB-DATA-XXXX-XXXX-XXXX
          </Text>
        </View>
      </ScrollView>

      {/* Success */}
      {showSuccess && (
        <View style={styles.successOverlay}>
          <Animated.View
            style={[
              styles.successCard,
              { backgroundColor: colors.card, borderColor: colors.connected, transform: [{ scale: successScale }] },
            ]}
          >
            <Ionicons name="checkmark-circle" size={52} color={colors.connected} />
            <Text style={[styles.successTitle, { color: colors.foreground }]}>{t('plan_success')}</Text>
            {accountState && (
              <Text style={[styles.successSub, { color: colors.mutedForeground }]}>
                {accountState.quotaRemainingGb.toFixed(1)} {t('gb')} {t('quota_remaining').toLowerCase()}
              </Text>
            )}
          </Animated.View>
        </View>
      )}

      {isLoading && !showSuccess && <LoadingOverlay message={t('plan_activating')} />}
    </View>
  );
}

const styles = StyleSheet.create({
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 12,
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 20,
    gap: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconBg: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '700' as const,
    fontFamily: 'Inter_700Bold',
  },
  desc: {
    fontSize: 14,
    lineHeight: 21,
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
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600' as const,
  },
  helpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  helpText: { fontSize: 13 },
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,11,20,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successCard: {
    padding: 36,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: 'center',
    gap: 12,
  },
  successTitle: {
    fontSize: 17,
    fontWeight: '600' as const,
    textAlign: 'center',
  },
  successSub: {
    fontSize: 14,
    textAlign: 'center',
  },
});

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
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { useColors } from '@/hooks/useColors';
import { useConfigContext } from '@/contexts/ConfigContext';
import { useTranslation } from '@/localization';
import TokenInput from '@/components/TokenInput';
import LoadingOverlay from '@/components/LoadingOverlay';

function ConfigIcon({ size = 60 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      <Rect x="8" y="10" width="44" height="40" rx="8" fill="rgba(91,141,239,0.12)" stroke="#5B8DEF" strokeWidth={2} />
      <Rect x="16" y="22" width="28" height="5" rx="2.5" fill="#5B8DEF" opacity={0.6} />
      <Rect x="16" y="31" width="20" height="4" rx="2" fill="#5B8DEF" opacity={0.35} />
      <Circle cx="46" cy="44" r="10" fill="#00E5A0" />
      <Path d="M41 44 L44.5 47.5 L51 41" stroke="white" strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default function ImportConfigScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { importVpnConfig, isImporting } = useConfigContext();
  const { t } = useTranslation();

  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  const successScale = useRef(new Animated.Value(0)).current;

  const handleImport = async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError(t('error_invalid_config_token'));
      return;
    }
    setError('');
    try {
      await importVpnConfig(trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setShowSuccess(true);
      Animated.spring(successScale, {
        toValue: 1,
        tension: 80,
        friction: 6,
        useNativeDriver: true,
      }).start();
      setTimeout(() => router.back(), 1600);
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const status = err?.response?.status;
      const msg: string = err?.response?.data?.message ?? '';
      if (status === 404) {
        setError(t('error_invalid_config_token'));
      } else if (status === 403) {
        setError(t('error_config_forbidden'));
      } else if (msg.includes('expir')) {
        setError(t('error_expired_token'));
      } else if (!msg && err?.message?.includes('Network')) {
        setError(t('error_no_network'));
      } else {
        setError(t('error_generic'));
      }
    }
  };

  return (
    <LinearGradient colors={['#080B14', '#0D1530', '#080B14']} style={{ flex: 1 }}>
      {isImporting && <LoadingOverlay />}

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Close */}
        <Pressable
          onPress={() => router.back()}
          style={[styles.closeBtn, { backgroundColor: 'rgba(255,255,255,0.07)' }]}
        >
          <Ionicons name="close" size={22} color="#8FA8CC" />
        </Pressable>

        {/* Icon */}
        <View style={styles.iconWrap}>
          <ConfigIcon size={88} />
        </View>

        <Text style={styles.title}>{t('import_config_title')}</Text>
        <Text style={[styles.desc, { color: colors.mutedForeground }]}>
          {t('import_config_desc')}
        </Text>

        {/* Token input */}
        <View style={styles.inputSection}>
          <TokenInput
            value={token}
            onChange={(v) => { setToken(v); setError(''); }}
            placeholder={t('token_config_placeholder')}
            error={error}
          />
        </View>

        {/* Info card */}
        <View style={[styles.infoCard, { backgroundColor: 'rgba(0,229,160,0.06)', borderColor: 'rgba(0,229,160,0.25)' }]}>
          <Ionicons name="shield-checkmark-outline" size={18} color="#00E5A0" />
          <Text style={[styles.infoText, { color: '#6B9E8A' }]}>
            {t('import_config_security_note')}
          </Text>
        </View>

        {/* Import button */}
        <Pressable
          onPress={handleImport}
          disabled={isImporting || !token.trim()}
          style={({ pressed }) => [
            styles.btn,
            {
              opacity: (isImporting || !token.trim()) ? 0.5 : (pressed ? 0.85 : 1),
              backgroundColor: '#00E5A0',
              shadowColor: '#00E5A0',
              shadowOpacity: 0.35,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 8 },
              elevation: 6,
            },
          ]}
        >
          <Ionicons name="download-outline" size={20} color="#001A0F" />
          <Text style={[styles.btnText, { color: '#001A0F' }]}>
            {t('import_config_btn')}
          </Text>
        </Pressable>
      </ScrollView>

      {/* Success overlay */}
      {showSuccess && (
        <View style={styles.successOverlay} pointerEvents="none">
          <Animated.View
            style={[
              styles.successCard,
              { backgroundColor: '#0F1525', borderColor: '#00E5A0', transform: [{ scale: successScale }] },
            ]}
          >
            <Ionicons name="checkmark-circle" size={56} color="#00E5A0" />
            <Text style={[styles.successText, { color: '#F0F4FF' }]}>
              {t('import_config_success')}
            </Text>
          </Animated.View>
        </View>
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 16,
  },
  closeBtn: {
    alignSelf: 'flex-end',
    borderRadius: 20,
    padding: 8,
    marginBottom: 8,
  },
  iconWrap: {
    width: 120,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 36,
    backgroundColor: 'rgba(91,141,239,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(91,141,239,0.2)',
    marginBottom: 4,
  },
  title: {
    fontSize: 26,
    fontWeight: '700' as const,
    color: '#F0F4FF',
    textAlign: 'center',
    fontFamily: 'Inter_700Bold',
    lineHeight: 34,
  },
  desc: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 24,
    fontFamily: 'Inter_400Regular',
    maxWidth: 300,
  },
  inputSection: {
    width: '100%',
    gap: 12,
    marginTop: 4,
  },
  infoCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: 'Inter_400Regular',
  },
  btn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 16,
    paddingVertical: 18,
    marginTop: 4,
  },
  btnText: {
    fontSize: 17,
    fontWeight: '600' as const,
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
    maxWidth: 280,
  },
  successText: {
    fontSize: 18,
    fontWeight: '600' as const,
    textAlign: 'center',
    fontFamily: 'Inter_600SemiBold',
  },
});

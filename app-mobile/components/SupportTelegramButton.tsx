import React, { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { SUPPORT_TELEGRAM_URL } from '@/constants/support';
import { alpha, radius, spacing, type } from '@/constants/theme';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';

type OpenUrl = (url: string) => Promise<unknown>;

export async function openSupportTelegram(
  onError: () => void,
  openBrowser: OpenUrl = (url) => WebBrowser.openBrowserAsync(url),
  // Linking.openURL utilise `this` : extraire la méthode cassait même les liens HTTPS.
  openLink: OpenUrl = (url) => Linking.openURL(url),
): Promise<boolean> {
  try {
    await openBrowser(SUPPORT_TELEGRAM_URL);
    return true;
  } catch {
    console.warn('[Support] Browser unavailable; trying the system HTTPS handler.');
  }
  try {
    await openLink(SUPPORT_TELEGRAM_URL);
    return true;
  } catch {
    console.warn('[Support] No application could open the support link.');
  }
  onError();
  return false;
}

export default function SupportTelegramButton({ compact = false }: { compact?: boolean }) {
  const colors = useColors();
  const { t } = useTranslation();
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);

  const handlePress = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      await openSupportTelegram(() =>
        Alert.alert(t('support_telegram_title'), t('support_telegram_error')));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('support_telegram_button')}
      accessibilityHint={t('support_telegram_hint')}
      accessibilityState={{ busy: opening, disabled: opening }}
      aria-busy={opening}
      aria-disabled={opening}
      disabled={opening}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.bgCard, borderColor: colors.primary + alpha.f40 },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.icon, { backgroundColor: colors.primaryDim }]}>
        <Ionicons name="paper-plane-outline" size={22} color={colors.primary} />
      </View>
      <View style={styles.copy}>
        <Text style={[type.bodyMedium, { color: colors.textPrimary }]}>{t('support_telegram_button')}</Text>
        {!compact && (
          <Text style={[type.caption, { color: colors.textSecondary }]}>{t('support_telegram_hint')}</Text>
        )}
      </View>
      {opening
        ? <ActivityIndicator size="small" color={colors.primary} />
        : <Ionicons name="open-outline" size={18} color={colors.primary} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  icon: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0, gap: spacing.xs },
  pressed: { opacity: 0.85 },
});

/**
 * SupportTelegramButton — Bouton « Support » ouvrant le canal Telegram.
 *
 * Placé là où l'utilisateur cherche de l'aide, y compris avant d'avoir un
 * compte (écran d'activation, écran d'essai gratuit). Il n'a donc besoin
 * d'aucune session.
 *
 * L'ouverture réutilise le mécanisme déjà employé ailleurs dans l'application
 * (Linking.openURL encadré d'un try/catch suivi d'une Alert) : si aucune
 * application ne peut prendre l'URL en charge, l'utilisateur voit un message
 * explicite, jamais un échec silencieux.
 */
import React from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SUPPORT_TELEGRAM_URL } from '@/constants/support';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';

export async function openSupportTelegram(
  onError: () => void,
  open: (url: string) => Promise<unknown> = Linking.openURL,
): Promise<boolean> {
  try {
    await open(SUPPORT_TELEGRAM_URL);
    return true;
  } catch {
    onError();
    return false;
  }
}

export default function SupportTelegramButton({ compact = false }: { compact?: boolean }) {
  const colors = useColors();
  const { t } = useTranslation();

  const handlePress = () => {
    void openSupportTelegram(() =>
      Alert.alert(t('support_telegram_title'), t('support_telegram_error')));
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('support_telegram_button')}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.bgCard + 'CC', borderColor: colors.primary + '45' },
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.icon, { backgroundColor: colors.primaryDim }]}>
        <Ionicons name="paper-plane" size={18} color={colors.primary} />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.label, { color: colors.primary }]}>{t('support_telegram_title')}</Text>
        <Text style={[styles.text, { color: colors.textPrimary }]}>{t('support_telegram_button')}</Text>
        {!compact && (
          <Text style={[styles.hint, { color: colors.textMuted }]}>{t('support_telegram_hint')}</Text>
        )}
      </View>
      <Ionicons name="open-outline" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 18, padding: 13 },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: 2 },
  label: { fontSize: 9, fontFamily: 'Inter_700Bold', letterSpacing: 1.4 },
  text: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  hint: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular' },
  pressed: { opacity: 0.68, transform: [{ scale: 0.98 }] },
});

/**
 * SupportTelegramButton — Bouton « Support » ouvrant le canal Telegram.
 *
 * Placé là où l'utilisateur cherche de l'aide, y compris avant d'avoir un
 * compte (écran d'activation, écran d'essai gratuit). Il n'a donc besoin
 * d'aucune session.
 *
 * L'ouverture vise le lien `https://t.me/...` EN PREMIER : Telegram déclare
 * t.me en lien d'application vérifié, donc Android l'ouvre directement dans
 * l'application quand elle est installée, et le navigateur affiche sinon la
 * page t.me — qui propose elle-même d'ouvrir Telegram. L'adresse native
 * `tg://` ne sert plus que de second recours (voir `openSupportTelegram`).
 */
import React from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SUPPORT_TELEGRAM_URL, telegramAppUrl } from '@/constants/support';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';

/**
 * Ouvre le canal de support.
 *
 * ORDRE : le lien `https://t.me/...` D'ABORD, l'adresse native ensuite.
 *
 * POURQUOI CET ORDRE — et pourquoi l'inverse a échoué
 * ───────────────────────────────────────────────────
 * L'implémentation précédente tentait `tg://join?invite=HASH` en premier, en
 * partant du principe qu'une adresse native mène forcément à l'application.
 * C'est faux pour une invitation : `openURL` RÉUSSIT dès que Telegram déclare
 * le schéma `tg://`, donc le repli web n'est jamais atteint — mais Telegram,
 * lui, ne résout pas toujours l'invitation ainsi et s'ouvre sur un écran vide.
 * Résultat vu par l'utilisateur : le bouton « ne fait rien », sans la moindre
 * erreur pour l'expliquer.
 *
 * Le lien https n'a pas ce défaut :
 *   • Telegram déclare t.me en lien d'application vérifié : sur un appareil où
 *     l'application est installée, Android l'ouvre DIRECTEMENT dedans ;
 *   • sinon le navigateur affiche la page t.me, qui propose elle-même
 *     « Ouvrir dans Telegram » — un chemin qui aboutit dans les deux cas.
 *
 * L'adresse native reste un second recours, pour l'appareil où le navigateur
 * a été désactivé. L'alerte ne paraît que si plus rien n'ouvre le lien.
 */
export async function openSupportTelegram(
  onError: () => void,
  open: (url: string) => Promise<unknown> = Linking.openURL,
): Promise<boolean> {
  try {
    await open(SUPPORT_TELEGRAM_URL);
    return true;
  } catch {
    // Aucun navigateur et aucun gestionnaire de lien : cas rare, mais réel sur
    // un appareil où le navigateur système a été retiré.
  }
  const natif = telegramAppUrl(SUPPORT_TELEGRAM_URL);
  if (natif) {
    try {
      await open(natif);
      return true;
    } catch {
      // Telegram absent lui aussi : il n'y a plus rien à tenter.
    }
  }
  onError();
  return false;
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

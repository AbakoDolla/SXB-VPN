/**
 * PrivacyDisclosure — page d'information sur la confidentialité.
 *
 * ELLE NE BLOQUE PLUS RIEN. Cet écran était une barrière de consentement
 * imposée par les règles de Google Play : il fallait l'accepter avant toute
 * connexion, et le bouton « retour » y était piégé pour qu'on ne puisse pas
 * l'esquiver. SXB ne publie plus sur Play ; l'utilisateur qui installe l'APK
 * et saisit son jeton consent par le geste même.
 *
 * Ce qui reste est ce qui avait de la valeur pour l'utilisateur, et qui n'a
 * jamais dépendu d'une boutique : ce que l'application collecte, la politique
 * de confidentialité, et la demande de suppression des données. Elle s'atteint
 * par `/privacy`, depuis l'écran d'activation et les réglages.
 */
import React from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguageContext } from '@/contexts/LanguageContext';
import { useTranslation } from '@/localization';
import { useColors } from '@/hooks/useColors';
import { DATA_DELETION_URL, PRIVACY_URL } from '@/services/distribution';
import { PRIVACY_CONSENT_VERSION } from '@/services/privacyPolicy';
import { radius, spacing } from '@/constants/theme';

export default function PrivacyDisclosure() {
  const { t, language } = useTranslation();
  const { setLanguage } = useLanguageContext();
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const open = async (url: string) => {
    try { await Linking.openURL(`${url}?lang=${language}`); }
    catch { Alert.alert(t('privacy_title'), t('privacy_link_error')); }
  };

  const button = (label: string, onPress: () => void, primary = false) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.button, { borderColor: colors.primary, backgroundColor: primary ? colors.primary : colors.bgCard }]}
    >
      <Text style={{ color: primary ? colors.primaryForeground : colors.textPrimary, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
    >
      <View style={styles.languages}>
        {button('Français', () => setLanguage('fr'))}
        {button('English', () => setLanguage('en'))}
      </View>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>{t('privacy_title')}</Text>
      <Text style={[styles.body, { color: colors.textPrimary }]}>{t('privacy_vpn_disclosure')}</Text>
      <Text style={[styles.body, { color: colors.textPrimary }]}>{t('privacy_required_data')}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{t('privacy_permission_separate')}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{t('privacy_deletion_description')}</Text>
      {button(t('privacy_policy'), () => { void open(PRIVACY_URL); })}
      {button(t('privacy_delete_request'), () => { void open(DATA_DELETION_URL); })}
      <Text style={{ color: colors.textMuted }}>{t('privacy_version')} {PRIVACY_CONSENT_VERSION}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, gap: spacing.xl },
  languages: { flexDirection: 'row', gap: spacing.md },
  title: { fontSize: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 24 },
  button: { padding: 16, borderWidth: 1, borderRadius: radius.sm, alignItems: 'center' },
});

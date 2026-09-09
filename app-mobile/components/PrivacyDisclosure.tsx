import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePrivacy } from '@/contexts/PrivacyContext';
import { useLanguageContext } from '@/contexts/LanguageContext';
import { useTranslation } from '@/localization';
import { useColors } from '@/hooks/useColors';
import { DATA_DELETION_URL, isPlayDistribution, PRIVACY_URL } from '@/services/distribution';
import { NO_CONSENT, PRIVACY_CONSENT_VERSION } from '@/services/privacyPolicy';

export default function PrivacyDisclosure() {
  const { consent, loading, error, reload, save } = usePrivacy();
  const { t, language } = useTranslation();
  const { setLanguage } = useLanguageContext();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(consent.diagnostics);
  const [notifications, setNotifications] = useState(consent.notifications);
  useEffect(() => {
    setDiagnostics(consent.vpn && consent.diagnostics);
    setNotifications(consent.vpn && consent.notifications);
  }, [consent]);
  useEffect(() => {
    if (!isPlayDistribution || consent.vpn) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) setRefused(true);
      return true;
    });
    return () => subscription.remove();
  }, [busy, consent.vpn]);

  const change = async (vpn: boolean) => {
    setBusy(true);
    try {
      await save(vpn
        ? { version: PRIVACY_CONSENT_VERSION, vpn: true, diagnostics, notifications }
        : { ...NO_CONSENT });
      setRefused(!vpn);
    } catch {
      Alert.alert(t('privacy_title'), t('privacy_change_error'));
    } finally { setBusy(false); }
  };
  const open = async (url: string) => {
    try { await Linking.openURL(`${url}?lang=${language}`); }
    catch { Alert.alert(t('privacy_title'), t('privacy_link_error')); }
  };
  const button = (label: string, onPress: () => void, primary = false) => (
    <Pressable accessibilityRole="button" disabled={busy || loading} onPress={onPress}
      style={[styles.button, { borderColor: colors.primary, backgroundColor: primary ? colors.primary : colors.bgCard }]}>
      <Text style={{ color: primary ? colors.primaryForeground : colors.textPrimary, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.languages}>
        {button('Français', () => setLanguage('fr'))}
        {button('English', () => setLanguage('en'))}
      </View>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.textPrimary }]}>{t('privacy_title')}</Text>
      {loading || busy ? <ActivityIndicator color={colors.primary} /> : null}
      {error && <Text accessibilityRole="alert" style={{ color: colors.disconnected }}>{t('privacy_change_error')}</Text>}
      {error && button(t('privacy_retry'), () => { void reload(); })}
      {refused && !consent.vpn ? (
        <>
          <Text style={[styles.body, { color: colors.textPrimary }]}>{t('privacy_refused')}</Text>
          {button(t('privacy_review'), () => setRefused(false), true)}
        </>
      ) : (
        <>
          <Text style={[styles.body, { color: colors.textPrimary }]}>{t('privacy_vpn_disclosure')}</Text>
          <Text style={[styles.body, { color: colors.textPrimary }]}>{t('privacy_required_data')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{t('privacy_permission_separate')}</Text>
          {isPlayDistribution && <>
            <View style={styles.option}>
              <Text style={[styles.optionText, { color: colors.textPrimary }]}>{t('privacy_diagnostics')}</Text>
              <Switch accessibilityLabel={t('privacy_diagnostics_label')} value={diagnostics} disabled={busy || loading} onValueChange={setDiagnostics} />
            </View>
            <View style={styles.option}>
              <Text style={[styles.optionText, { color: colors.textPrimary }]}>{t('privacy_notifications')}</Text>
              <Switch accessibilityLabel={t('privacy_notifications_label')} value={notifications} disabled={busy || loading} onValueChange={setNotifications} />
            </View>
            {button(consent.vpn ? t('privacy_save') : t('privacy_accept'), () => { void change(true); }, true)}
            {consent.vpn
              ? button(t('privacy_revoke'), () => { void change(false); })
              : button(t('privacy_decline'), () => { setDiagnostics(false); setNotifications(false); setRefused(true); })}
          </>}
        </>
      )}
      <Text style={[styles.body, { color: colors.textSecondary }]}>{t('privacy_deletion_description')}</Text>
      {button(t('privacy_policy'), () => { void open(PRIVACY_URL); })}
      {button(t('privacy_delete_request'), () => { void open(DATA_DELETION_URL); })}
      <Text style={{ color: colors.textMuted }}>{t('privacy_version')} {PRIVACY_CONSENT_VERSION}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, gap: 18 },
  languages: { flexDirection: 'row', gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 24 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  optionText: { flex: 1, fontSize: 15, lineHeight: 22 },
  button: { padding: 16, borderWidth: 1, borderRadius: 12, alignItems: 'center' },
});

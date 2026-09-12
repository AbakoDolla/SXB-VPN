import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthContext } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import { refreshAccessState, reportAccessSyncError } from '@/services/accessSync';
import AccessNotices from '@/components/AccessNotices';

export default function DeviceAccessScreen() {
  const { deviceAccess } = useAuthContext();
  const { t, language } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const status = deviceAccess?.status === 'active' ? 'disabled' : deviceAccess?.status ?? 'disabled';
  const refresh = async () => {
    setBusy(true);
    setFailed(false);
    try { if (!await refreshAccessState()) setFailed(true); }
    catch (error) { setFailed(true); reportAccessSyncError(error); }
    finally { setBusy(false); }
  };
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24,
      paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24, gap: 20, backgroundColor: colors.bg }}>
      <Text style={{ fontSize: 14, color: colors.primary }}>{t("app_name")}</Text>
      <Text style={{ fontSize: 26, fontWeight: '700', color: colors.textPrimary }}>{t('access_device_title')}</Text>
      <Text accessibilityRole="alert" style={{ color: colors.warning, fontSize: 17 }}>{t(`access_device_${status}`)}</Text>
      <Text style={{ color: colors.textSecondary, lineHeight: 22 }}>{t('access_preserved')}</Text>
      {deviceAccess?.expireAt && <Text style={{ color: colors.textMuted }}>
        {t('access_device_expiry')}: {new Date(deviceAccess.expireAt).toLocaleDateString(language)}
      </Text>}
      <AccessNotices />
      {failed && <Text accessibilityRole="alert" style={{ color: colors.warning }}>{t('access_offline')}</Text>}
      <Pressable disabled={busy} onPress={() => { void refresh(); }} accessibilityRole="button"
        style={{ backgroundColor: colors.primary, borderRadius: 14, padding: 16, alignItems: 'center' }}>
        {busy ? <ActivityIndicator color={colors.primaryForeground} /> :
          <Text style={{ color: colors.primaryForeground }}>{t('access_refresh')}</Text>}
      </Pressable>
      {deviceAccess?.activationRequired && <Pressable onPress={() => router.push('/activate')} accessibilityRole="button">
        <Text style={{ color: colors.primary }}>{t('access_enter_code')}</Text>
      </Pressable>}
      <View style={{ flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
        <Pressable onPress={() => router.push('/settings')} accessibilityRole="button"><Text style={{ color: colors.primary }}>{t('settings')}</Text></Pressable>
        <Pressable onPress={() => router.push('/privacy')} accessibilityRole="link"><Text style={{ color: colors.primary }}>{t('privacy_title')}</Text></Pressable>
      </View>
      <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 11 }}>{t('created_by')}</Text>
    </ScrollView>
  );
}

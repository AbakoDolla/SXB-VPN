import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAuthContext } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import { dismissAccessNotices } from '@/services/accessState';
import { reportAccessSyncError } from '@/services/accessSync';

export default function AccessNotices() {
  const { accessNotices } = useAuthContext();
  const { t } = useTranslation();
  const colors = useColors();
  if (!accessNotices.length) return null;
  return (
    <View style={{ padding: 16, gap: 8, borderRadius: 16, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 }}>
      {accessNotices.map(notice => (
        <Text key={notice.id} accessibilityRole="alert" style={{ color: colors.textSecondary, fontSize: 13 }}>
          {t(`access_${notice.kind}`).replace('{name}', notice.name || 'VPN')}
        </Text>
      ))}
      <Pressable accessibilityRole="button" onPress={() => { void dismissAccessNotices().catch(reportAccessSyncError); }}>
        <Text style={{ color: colors.primary }}>{t('close')}</Text>
      </Pressable>
    </View>
  );
}

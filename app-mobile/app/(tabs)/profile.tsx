import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuthContext } from '@/contexts/AuthContext';
import { useVpnContext } from '@/contexts/VpnContext';
import { useConfigContext } from '@/contexts/ConfigContext';
import { useTranslation } from '@/localization';

function InfoRow({ icon, label, value, accent }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string; accent?: boolean }) {
  const colors = useColors();
  return (
    <View style={[styles.infoRow, { borderColor: colors.border }]}>
      <View style={[styles.infoIcon, { backgroundColor: `${colors.primary}22` }]}>
        <Ionicons name={icon} size={16} color={colors.primary} />
      </View>
      <View style={styles.infoContent}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: accent ? colors.connected : colors.foreground }]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, accountState, logout } = useAuthContext();
  const { disconnect } = useVpnContext();
  const { hasConfig, configTokenRef } = useConfigContext();
  const { t } = useTranslation();
  const version = Constants.expoConfig?.version ?? '1.0.0';

  const handleLogout = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(t('logout_confirm_title'), t('logout_confirm_message'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('logout'),
        style: 'destructive',
        onPress: async () => {
          await disconnect().catch(() => {});
          await logout();
          router.replace('/activate');
        },
      },
    ]);
  };

  const formatExpiry = (iso: string | null) => {
    if (!iso) return t('no_expiry');
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  };

  const getStatus = () => {
    if (!accountState) return '-';
    switch (accountState.state) {
      case 'no_package': return t('no_package_status');
      case 'ready': return t('active');
      case 'expired': return t('expired');
      case 'suspended': return t('suspended_status');
      default: return '-';
    }
  };

  const firstName = user?.name?.split(' ')[0] ?? 'Utilisateur';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 80 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <View style={[styles.avatar, { backgroundColor: `${colors.primary}33` }]}>
            <Text style={[styles.avatarLetter, { color: colors.primary }]}>
              {firstName.charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={[styles.name, { color: colors.foreground }]}>{user?.name ?? '-'}</Text>
          {user?.email ? (
            <Text style={[styles.email, { color: colors.mutedForeground }]}>{user.email}</Text>
          ) : null}
        </View>

        {/* Status badge */}
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusBadge,
              {
                backgroundColor:
                  accountState?.state === 'suspended'
                    ? `${colors.destructive}22`
                    : accountState?.state === 'expired'
                    ? `${colors.warning}22`
                    : `${colors.connected}22`,
              },
            ]}
          >
            <Ionicons
              name={
                accountState?.state === 'suspended'
                  ? 'warning-outline'
                  : accountState?.state === 'expired'
                  ? 'timer-outline'
                  : 'shield-checkmark-outline'
              }
              size={16}
              color={
                accountState?.state === 'suspended'
                  ? colors.destructive
                  : accountState?.state === 'expired'
                  ? colors.warning
                  : colors.connected
              }
            />
            <Text
              style={[
                styles.statusText,
                {
                  color:
                    accountState?.state === 'suspended'
                      ? colors.destructive
                      : accountState?.state === 'expired'
                      ? colors.warning
                      : colors.connected,
                },
              ]}
            >
              {getStatus()}
            </Text>
          </View>
        </View>

        {/* Account info */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <InfoRow icon="person-outline" label={t('client_id')} value={user?.id?.slice(0, 8).toUpperCase() ?? '-'} />
          <View style={[styles.sep, { backgroundColor: colors.border }]} />
          {accountState && (
            <>
              <InfoRow
                icon="cube-outline"
                label={t('plan_label')}
                value={`${accountState.quotaRemainingGb.toFixed(1)} Go restants`}
                accent
              />
              <View style={[styles.sep, { backgroundColor: colors.border }]} />
              <InfoRow
                icon="calendar-outline"
                label={t('expiration')}
                value={formatExpiry(accountState.expireAt)}
              />
              <View style={[styles.sep, { backgroundColor: colors.border }]} />
              <InfoRow
                icon="phone-portrait-outline"
                label={t('devices_authorized')}
                value={`${accountState.deviceLimit} ${accountState.deviceLimit > 1 ? t('devices') : t('device')}`}
              />
              <View style={[styles.sep, { backgroundColor: colors.border }]} />
            </>
          )}
          <InfoRow icon="information-circle-outline" label={t('app_version')} value={version} />
        </View>

        {/* Actions */}
        <Pressable
          onPress={() => router.push('/support')}
          style={[styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Ionicons name="help-circle-outline" size={20} color={colors.primary} />
          <Text style={[styles.actionText, { color: colors.primary }]}>{t('support')}</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
        </Pressable>

        <Pressable
          onPress={() => router.push('/plan')}
          style={[styles.actionBtn, { backgroundColor: `${colors.connected}11`, borderColor: `${colors.connected}44` }]}
        >
          <Ionicons name="add-circle-outline" size={20} color={colors.connected} />
          <Text style={[styles.actionText, { color: colors.connected }]}>{t('activate_plan')}</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.connected} />
        </Pressable>

        <Pressable
          onPress={() => router.push('/import-config')}
          style={[styles.actionBtn, { backgroundColor: `${colors.info}11`, borderColor: `${colors.info}33` }]}
        >
          <Ionicons name="download-outline" size={20} color={colors.info} />
          <Text style={[styles.actionText, { color: colors.info }]}>
            {hasConfig ? t('config_imported') : t('import_config_action')}
          </Text>
          {hasConfig && configTokenRef ? (
            <Text style={{ fontSize: 11, color: colors.mutedForeground }}>{configTokenRef}</Text>
          ) : null}
          <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
        </Pressable>

        <Pressable
          onPress={handleLogout}
          style={[styles.actionBtn, { backgroundColor: `${colors.destructive}11`, borderColor: `${colors.destructive}33` }]}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.destructive} />
          <Text style={[styles.actionText, { color: colors.destructive }]}>{t('logout')}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 16 },
  avatarSection: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  avatar: { width: 80, height: 80, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontSize: 34, fontWeight: '700' as const },
  name: { fontSize: 22, fontWeight: '700' as const },
  email: { fontSize: 14 },
  statusRow: { alignItems: 'center' },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 100 },
  statusText: { fontSize: 14, fontWeight: '600' as const },
  card: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  infoRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  infoIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  infoContent: { flex: 1, gap: 2 },
  infoLabel: { fontSize: 12 },
  infoValue: { fontSize: 15, fontWeight: '500' as const },
  sep: { height: 1, marginHorizontal: 16 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 16, borderRadius: 16, borderWidth: 1 },
  actionText: { flex: 1, fontSize: 15, fontWeight: '500' as const },
});

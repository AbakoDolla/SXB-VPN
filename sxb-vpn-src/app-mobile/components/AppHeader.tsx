import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuthContext } from '@/contexts/AuthContext';
import { useTranslation } from '@/localization';

interface AppHeaderProps {
  showSettings?: boolean;
}

function getGreeting(t: (key: any) => string): string {
  const h = new Date().getHours();
  if (h < 12) return t('greeting_morning');
  if (h < 18) return t('greeting_afternoon');
  return t('greeting_evening');
}

export default function AppHeader({ showSettings = true }: AppHeaderProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, accountState } = useAuthContext();
  const { t } = useTranslation();

  const firstName = user?.name?.split(' ')[0] ?? 'Utilisateur';
  const isActive = accountState?.state === 'ready' || accountState?.state === 'no_package';
  const statusLabel = accountState?.state === 'suspended'
    ? t('account_suspended')
    : t('account_active');
  const statusColor = accountState?.state === 'suspended' ? colors.destructive : colors.connected;

  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top + 12, backgroundColor: colors.background },
      ]}
    >
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: `${colors.primary}33` }]}>
        <Text style={[styles.avatarText, { color: colors.primary }]}>
          {firstName.charAt(0).toUpperCase()}
        </Text>
      </View>

      {/* Greeting */}
      <View style={styles.greetingCol}>
        <Text style={[styles.greeting, { color: colors.mutedForeground }]}>
          {getGreeting(t)}
        </Text>
        <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
          {firstName}
        </Text>
      </View>

      {/* Status badge */}
      {accountState && (
        <View style={[styles.badge, { backgroundColor: `${statusColor}22` }]}>
          <View style={[styles.badgeDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.badgeText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      )}

      {/* Settings */}
      {showSettings && (
        <Pressable onPress={() => router.push('/settings')} hitSlop={10}>
          <Ionicons name="settings-outline" size={22} color={colors.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    gap: 12,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 18,
    fontWeight: '700' as const,
  },
  greetingCol: {
    flex: 1,
    gap: 1,
  },
  greeting: {
    fontSize: 12,
  },
  name: {
    fontSize: 16,
    fontWeight: '600' as const,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600' as const,
  },
});

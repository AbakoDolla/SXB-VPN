import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { Notification } from '@/types/api';

interface NotificationCardProps {
  item: Notification;
}

const typeIcons: Record<string, keyof typeof Ionicons.glyphMap> = {
  info: 'information-circle',
  warning: 'warning',
  error: 'alert-circle',
  success: 'checkmark-circle',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "À l'instant";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

export default function NotificationCard({ item }: NotificationCardProps) {
  const colors = useColors();

  const iconColor = {
    info: colors.info,
    warning: colors.warning,
    error: colors.destructive,
    success: colors.success,
  }[item.type] ?? colors.primary;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: item.isRead ? colors.card : `${colors.primary}11`,
          borderColor: item.isRead ? colors.border : `${colors.primary}33`,
        },
      ]}
    >
      <View style={[styles.iconContainer, { backgroundColor: `${iconColor}22` }]}>
        <Ionicons name={typeIcons[item.type] ?? 'information-circle'} size={20} color={iconColor} />
      </View>
      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[styles.time, { color: colors.mutedForeground }]}>
            {formatTime(item.createdAt)}
          </Text>
        </View>
        <Text style={[styles.message, { color: colors.mutedForeground }]} numberOfLines={2}>
          {item.message}
        </Text>
      </View>
      {!item.isRead && (
        <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600' as const,
  },
  time: {
    fontSize: 12,
  },
  message: {
    fontSize: 13,
    lineHeight: 18,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
  },
});

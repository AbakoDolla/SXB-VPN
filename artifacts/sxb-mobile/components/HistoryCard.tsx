import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { HistoryItem } from '@/types/api';

interface HistoryCardProps {
  item: HistoryItem;
  isLast?: boolean;
}

const actionIcons: Record<string, keyof typeof Ionicons.glyphMap> = {
  account_activated: 'person-add',
  plan_activated: 'cube',
  vpn_connected: 'shield-checkmark',
  vpn_disconnected: 'shield-outline',
  plan_expired: 'timer-outline',
  plan_renewed: 'refresh-circle',
};

function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
}

export default function HistoryCard({ item, isLast = false }: HistoryCardProps) {
  const colors = useColors();

  const statusColor = {
    success: colors.success,
    error: colors.destructive,
    info: colors.info,
  }[item.status] ?? colors.primary;

  const iconName = actionIcons[item.action] ?? 'time-outline';
  const { date, time } = formatDateTime(item.createdAt);

  return (
    <View style={styles.row}>
      {/* Timeline line */}
      <View style={styles.timelineColumn}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        {!isLast && <View style={[styles.line, { backgroundColor: colors.border }]} />}
      </View>

      {/* Content */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.iconRow}>
          <View style={[styles.iconBg, { backgroundColor: `${statusColor}22` }]}>
            <Ionicons name={iconName} size={16} color={statusColor} />
          </View>
          <Text style={[styles.description, { color: colors.foreground }]}>
            {item.description}
          </Text>
        </View>
        <View style={styles.meta}>
          <Text style={[styles.date, { color: colors.mutedForeground }]}>{date}</Text>
          <Text style={[styles.time, { color: colors.mutedForeground }]}>{time}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 14,
    paddingBottom: 4,
  },
  timelineColumn: {
    alignItems: 'center',
    width: 16,
    paddingTop: 16,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  line: {
    flex: 1,
    width: 2,
    marginTop: 6,
  },
  card: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBg: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  description: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500' as const,
    lineHeight: 20,
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  date: {
    fontSize: 12,
  },
  time: {
    fontSize: 12,
  },
});

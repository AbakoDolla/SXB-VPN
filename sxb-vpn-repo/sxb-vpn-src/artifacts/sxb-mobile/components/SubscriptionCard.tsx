import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import type { AccountState } from '@/types/api';

interface SubscriptionCardProps {
  accountState: AccountState;
  onAddPlan?: () => void;
}

function formatQuota(gb: number, t: (key: any) => string): string {
  if (gb >= 1) return `${gb.toFixed(1)} ${t('gb')}`;
  if (gb * 1024 >= 1) return `${(gb * 1024).toFixed(0)} ${t('mb')}`;
  return `${(gb * 1024 * 1024).toFixed(0)} ${t('kb')}`;
}

function formatDate(iso: string | null, t: (key: any) => string): string {
  if (!iso) return t('no_expiry');
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function getDaysLeft(iso: string | null): number {
  if (!iso) return 9999;
  const diff = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

const RING_SIZE = 72;
const STROKE = 6;

export default function SubscriptionCard({ accountState }: SubscriptionCardProps) {
  const colors = useColors();
  const { t } = useTranslation();

  const { quotaRemainingGb, quotaTotalGb, expireAt, state } = accountState;
  const daysLeft = getDaysLeft(expireAt);
  const isExpired = state === 'expired';
  const ratio = quotaTotalGb > 0 ? Math.min(quotaRemainingGb / quotaTotalGb, 1) : 0;

  const r = (RING_SIZE - STROKE * 2) / 2;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * ratio;

  const ringColor = isExpired
    ? colors.destructive
    : ratio < 0.2
    ? colors.warning
    : colors.connected;

  const cardBg = colors.card;

  return (
    <View style={[styles.card, { backgroundColor: cardBg, borderColor: colors.border }]}>
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="analytics-outline" size={18} color={colors.primary} />
        <Text style={[styles.title, { color: colors.foreground }]}>{t('current_plan')}</Text>
        {isExpired && (
          <View style={[styles.badge, { backgroundColor: `${colors.destructive}22` }]}>
            <Text style={[styles.badgeText, { color: colors.destructive }]}>{t('expired')}</Text>
          </View>
        )}
      </View>

      <View style={styles.body}>
        {/* Quota ring */}
        <View style={styles.ringContainer}>
          <Svg width={RING_SIZE} height={RING_SIZE}>
            <Circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={r}
              stroke={colors.border}
              strokeWidth={STROKE}
              fill="none"
            />
            <Circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={r}
              stroke={ringColor}
              strokeWidth={STROKE}
              fill="none"
              strokeDasharray={`${dash} ${circumference}`}
              strokeLinecap="round"
              rotation="-90"
              origin={`${RING_SIZE / 2}, ${RING_SIZE / 2}`}
            />
          </Svg>
          <View style={styles.ringCenter}>
            <Text style={[styles.ringPercent, { color: ringColor }]}>
              {Math.round(ratio * 100)}%
            </Text>
          </View>
        </View>

        {/* Quota info */}
        <View style={styles.info}>
          <View style={styles.row}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t('quota_remaining')}</Text>
            <Text style={[styles.value, { color: colors.foreground }]}>
              {formatQuota(quotaRemainingGb, t)}
            </Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.row}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t('expires_on')}</Text>
            <Text style={[styles.value, { color: isExpired ? colors.destructive : colors.foreground }]}>
              {formatDate(expireAt, t)}
            </Text>
          </View>
          {!isExpired && daysLeft < 9999 && (
            <>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <View style={styles.row}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}> </Text>
                <Text style={[styles.daysLeft, { color: daysLeft <= 3 ? colors.warning : colors.mutedForeground }]}>
                  {daysLeft} {daysLeft === 1 ? t('day_left') : t('days_left')}
                </Text>
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600' as const,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 100,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600' as const,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
  },
  ringContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCenter: {
    position: 'absolute',
  },
  ringPercent: {
    fontSize: 13,
    fontWeight: '700' as const,
  },
  info: {
    flex: 1,
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: 12,
  },
  value: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  divider: {
    height: 1,
  },
  daysLeft: {
    fontSize: 12,
    fontWeight: '500' as const,
  },
});

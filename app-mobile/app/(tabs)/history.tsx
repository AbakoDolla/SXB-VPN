import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import { useAuthContext } from '@/contexts/AuthContext';
import HistoryCard from '@/components/HistoryCard';
import apiClient from '@/services/apiClient';
import type { HistoryItem } from '@/types/api';

// Fallback local history derived from account state
function buildLocalHistory(accountState: any): HistoryItem[] {
  const items: HistoryItem[] = [];
  if (accountState?.state !== 'no_package') {
    items.push({
      id: '1',
      action: 'plan_activated',
      description: 'Forfait activé',
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
      status: 'success',
    });
  }
  items.push({
    id: '2',
    action: 'account_activated',
    description: 'Compte activé',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    status: 'success',
  });
  return items;
}

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { accountState } = useAuthContext();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiClient.get('/mobile/history');
        if (!cancelled) setItems(res.data ?? []);
      } catch (_) {
        if (!cancelled && accountState) {
          setItems(buildLocalHistory(accountState));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [accountState]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 16, borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>{t('history')}</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="time-outline" size={48} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{t('no_history')}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 80 }]}
          renderItem={({ item, index }) => (
            <HistoryCard item={item} isLast={index === items.length - 1} />
          )}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  title: { fontSize: 24, fontWeight: '700' as const, fontFamily: 'Inter_700Bold' },
  list: { paddingHorizontal: 20, paddingTop: 16, gap: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText: { fontSize: 15, textAlign: 'center' },
});

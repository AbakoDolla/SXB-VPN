import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "@/services/apiClient";
import type { HistoryItem } from "@/types/api";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";
import { alpha, layout, radius, spacing, type } from "@/constants/theme";
import { EmptyState } from "@/components/ui/Primitives";

/**
 * Une ligne d'historique. La frise verticale relie les événements entre eux :
 * elle rend l'ordre chronologique perceptible sans avoir à lire les dates.
 */
function HistoryRow({ item, isLast }: { item: HistoryItem; isLast: boolean }) {
  const colors = useColors();

  const metadata: Record<string, { icon: string; color: string }> = {
    connect: { icon: "shield-checkmark", color: colors.connected },
    disconnect: { icon: "power", color: colors.disconnected },
    account_activated: { icon: "key", color: colors.primary },
    plan_activated: { icon: "sparkles", color: colors.purple },
    default: { icon: "time", color: colors.textMuted },
  };
  const meta = metadata[item.action] || metadata.default;
  const date = new Date(item.createdAt);
  const resultColor = item.status === "success"
    ? colors.connected
    : item.status === "error"
    ? colors.disconnected
    : colors.textMuted;

  return (
    <View style={styles.row}>
      <View style={styles.timeline}>
        <View style={[styles.dot, { backgroundColor: meta.color }]} />
        {!isLast && <View style={[styles.line, { backgroundColor: colors.border }]} />}
      </View>

      <View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: meta.color + alpha.f24 }]}>
        <View style={[styles.iconCircle, { backgroundColor: meta.color + alpha.f12 }]}>
          <Ionicons name={meta.icon as any} size={17} color={meta.color} />
        </View>
        <View style={styles.copy}>
          <Text style={[type.bodyMedium, { color: colors.textPrimary }]} numberOfLines={2}>
            {item.description}
          </Text>
          <Text style={[type.micro, { color: colors.textMuted }]}>
            {date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })} ·{" "}
            {date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
        <View style={[styles.resultDot, { backgroundColor: resultColor }]} />
      </View>
    </View>
  );
}

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "connections" | "activations">("all");

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get("/mobile/history")
      .then((res) => { if (!cancelled) setItems(Array.isArray(res.data) ? res.data : []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filteredItems = items.filter((item) =>
    filter === "all"
      || (filter === "connections"
        ? ["connect", "disconnect"].includes(item.action)
        : ["account_activated", "plan_activated"].includes(item.action)),
  );

  const filters = [
    { key: "all" as const, label: t("filter_all") },
    { key: "connections" as const, label: t("filter_connections") },
    { key: "activations" as const, label: t("filter_activations") },
  ];

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.lg, borderBottomColor: colors.border }]}>
        <Text style={[type.overline, { color: colors.primary }]}>SXB VPN</Text>
        <Text style={[type.h1, { color: colors.textPrimary, marginBottom: spacing.md }]}>{t("history")}</Text>

        <View style={styles.filterRow}>
          {filters.map((item) => {
            const isActive = filter === item.key;
            return (
              <Pressable
                key={item.key}
                onPress={() => setFilter(item.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                style={({ pressed }) => [
                  styles.filterButton,
                  {
                    backgroundColor: isActive ? colors.primaryDim : colors.bgCard,
                    borderColor: isActive ? colors.primary + alpha.f60 : colors.border,
                  },
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[type.captionMedium, { color: isActive ? colors.primary : colors.textMuted }]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : filteredItems.length === 0 ? (
        <View style={styles.center}>
          <EmptyState
            icon="time-outline"
            title={t("no_history")}
            description={t("history_empty_hint")}
          />
        </View>
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + layout.tabBarClearance },
          ]}
          renderItem={({ item, index }) => (
            <HistoryRow item={item} isLast={index === filteredItems.length - 1} />
          )}
          showsVerticalScrollIndicator={false}
        />
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  filterRow: { flexDirection: "row", gap: spacing.sm },
  filterButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },

  list: { paddingHorizontal: layout.screenPadding, paddingTop: spacing.lg },
  row: { flexDirection: "row", gap: spacing.md },
  timeline: { width: 18, alignItems: "center" },
  dot: { width: 10, height: 10, borderRadius: radius.full, marginTop: 24, zIndex: 1 },
  line: { flex: 1, width: StyleSheet.hairlineWidth, marginTop: spacing.xs },
  card: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: spacing.xs },
  resultDot: { width: 7, height: 7, borderRadius: radius.full },

  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: layout.screenPadding },
});

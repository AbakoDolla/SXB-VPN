import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "@/services/apiClient";
import type { HistoryItem } from "@/types/api";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

function HistoryRow({ item, isLast }: { item: HistoryItem; isLast: boolean }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const metadata: Record<string, { icon: string; color: string }> = {
    connect: { icon: "shield-checkmark", color: colors.connected },
    disconnect: { icon: "power", color: colors.disconnected },
    account_activated: { icon: "key", color: colors.primary },
    plan_activated: { icon: "sparkles", color: colors.purple },
    default: { icon: "time", color: colors.textMuted },
  };
  const meta = metadata[item.action] || metadata.default;
  const date = new Date(item.createdAt);
  return <View style={styles.row}><View style={styles.timeline}><View style={[styles.dot, { backgroundColor: meta.color }]} />{!isLast && <View style={[styles.line, { backgroundColor: colors.border }]} />}</View><View style={[styles.card, { borderColor: meta.color + "35" }]}><View style={[styles.iconCircle, { backgroundColor: meta.color + "18" }]}><Ionicons name={meta.icon as any} size={18} color={meta.color} /></View><View style={styles.copy}><Text style={styles.description}>{item.description}</Text><Text style={styles.time}>{date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })} · {date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</Text></View><View style={[styles.resultDot, { backgroundColor: item.status === "success" ? colors.connected : item.status === "error" ? colors.disconnected : colors.textMuted }]} /></View></View>;
}

export default function HistoryScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "connections" | "activations">("all");

  useEffect(() => {
    let cancelled = false;
    apiClient.get("/mobile/history").then((res) => { if (!cancelled) setItems(Array.isArray(res.data) ? res.data : []); }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filteredItems = items.filter((item) => filter === "all" || (filter === "connections" ? ["connect", "disconnect"].includes(item.action) : ["account_activated", "plan_activated"].includes(item.action)));
  const filters = [{ key: "all" as const, label: t("filter_all") }, { key: "connections" as const, label: t("filter_connections") }, { key: "activations" as const, label: t("filter_activations") }];

  return <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}><View style={[styles.header, { paddingTop: insets.top + 16 }]}><Text style={styles.eyebrow}>SXB VPN</Text><Text style={styles.title}>{t("history")}</Text><View style={styles.filterRow}>{filters.map((item) => <Pressable key={item.key} onPress={() => setFilter(item.key)} style={({ pressed }) => [styles.filterButton, filter === item.key && { backgroundColor: colors.primaryDim, borderColor: colors.primary + "65" }, pressed && styles.pressed]}><Text style={[styles.filterText, { color: filter === item.key ? colors.primary : colors.textMuted }]}>{item.label}</Text></Pressable>)}</View></View>{loading ? <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View> : filteredItems.length === 0 ? <View style={styles.center}><View style={styles.emptyIcon}><Ionicons name="time-outline" size={38} color={colors.textMuted} /></View><Text style={styles.emptyTitle}>{t("no_history")}</Text><Text style={styles.emptyHint}>Les événements réels de votre compte apparaîtront ici.</Text></View> : <FlatList data={filteredItems} keyExtractor={(item) => item.id} contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]} renderItem={({ item, index }) => <HistoryRow item={item} isLast={index === filteredItems.length - 1} />} showsVerticalScrollIndicator={false} />}</LinearGradient>;
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({
    container: { flex: 1 }, header: { paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border }, eyebrow: { color: colors.primary, fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.7, marginBottom: 4 }, title: { color: colors.textPrimary, fontSize: 26, fontFamily: "Inter_700Bold", marginBottom: 14 }, filterRow: { flexDirection: "row", gap: 8 }, filterButton: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 99, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard }, filterText: { fontSize: 11, fontFamily: "Inter_600SemiBold" }, list: { paddingHorizontal: 20, paddingTop: 17 }, row: { flexDirection: "row", gap: 10, minHeight: 78 }, timeline: { width: 18, alignItems: "center" }, dot: { width: 10, height: 10, borderRadius: 5, marginTop: 22, zIndex: 1 }, line: { flex: 1, width: 1, marginTop: 3 }, card: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 17, borderWidth: 1, backgroundColor: colors.bgCard, marginBottom: 10 }, iconCircle: { width: 37, height: 37, borderRadius: 13, alignItems: "center", justifyContent: "center" }, copy: { flex: 1, gap: 4 }, description: { color: colors.textPrimary, fontSize: 13, fontFamily: "Inter_600SemiBold" }, time: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_400Regular" }, resultDot: { width: 6, height: 6, borderRadius: 3 }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 20 }, emptyIcon: { width: 78, height: 78, borderRadius: 27, alignItems: "center", justifyContent: "center", backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }, emptyTitle: { color: colors.textPrimary, fontSize: 16, fontFamily: "Inter_600SemiBold" }, emptyHint: { color: colors.textMuted, fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center" }, pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  });
}

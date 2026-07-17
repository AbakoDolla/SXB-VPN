import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuthContext } from "@/contexts/AuthContext";
import apiClient from "@/services/apiClient";
import type { HistoryItem } from "@/types/api";
import Colors from "@/constants/colors";

const ICON_MAP: Record<string, { icon: string; color: string }> = {
  connect:          { icon: "shield-checkmark", color: Colors.connected },
  disconnect:       { icon: "power",            color: Colors.disconnected },
  account_activated:{ icon: "key",              color: Colors.primary },
  plan_activated:   { icon: "gift",             color: Colors.purple },
  default:          { icon: "time",             color: Colors.textMuted },
};

function HistoryRow({ item, isLast }: { item: HistoryItem; isLast: boolean }) {
  const meta = ICON_MAP[item.action] || ICON_MAP.default;
  const date = new Date(item.createdAt);
  const timeStr = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const dateStr = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });

  return (
    <View style={rowStyles.container}>
      {/* Timeline line */}
      <View style={rowStyles.lineCol}>
        <View style={[rowStyles.dot, { backgroundColor: meta.color }]} />
        {!isLast && <View style={rowStyles.line} />}
      </View>

      {/* Content */}
      <View style={[rowStyles.card, { borderColor: meta.color + "25" }]}>
        <View style={[rowStyles.iconCircle, { backgroundColor: meta.color + "15" }]}>
          <Ionicons name={meta.icon as any} size={18} color={meta.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={rowStyles.description}>{item.description}</Text>
          <Text style={rowStyles.time}>{dateStr} · {timeStr}</Text>
        </View>
        <View style={[rowStyles.statusDot, { backgroundColor: item.status === "success" ? Colors.connected : item.status === "error" ? Colors.disconnected : Colors.textMuted }]} />
      </View>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  container: { flexDirection: "row", gap: 12, marginBottom: 0 },
  lineCol: { width: 20, alignItems: "center" },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 20, zIndex: 1 },
  line: { flex: 1, width: 1, backgroundColor: Colors.border, marginTop: 4 },
  card: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: Colors.bgCard, borderRadius: 14, borderWidth: 1, padding: 12, marginBottom: 10 },
  iconCircle: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  description: { fontSize: 13, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  time: { fontSize: 11, color: Colors.textMuted, fontFamily: "Inter_400Regular", marginTop: 2 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
});

function buildLocalHistory(accountState: any): HistoryItem[] {
  const items: HistoryItem[] = [];
  if (accountState?.state !== "no_package") {
    items.push({ id: "1", action: "plan_activated", description: "Forfait activé", createdAt: new Date(Date.now() - 86400000).toISOString(), status: "success" });
  }
  items.push({ id: "2", action: "account_activated", description: "Compte activé", createdAt: new Date(Date.now() - 172800000).toISOString(), status: "success" });
  return items;
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { accountState } = useAuthContext();
  const [items, setItems]   = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState<"all" | "connections" | "activations">("all");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiClient.get("/mobile/history");
        if (!cancelled) setItems(res.data ?? []);
      } catch (_) {
        if (!cancelled && accountState) setItems(buildLocalHistory(accountState));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [accountState]);

  const filteredItems = items.filter((item) => {
    if (filter === "all") return true;
    if (filter === "connections") return ["connect", "disconnect"].includes(item.action);
    if (filter === "activations") return ["account_activated", "plan_activated"].includes(item.action);
    return true;
  });

  const FILTERS: { key: "all" | "connections" | "activations"; label: string }[] = [
    { key: "all",         label: "Tout" },
    { key: "connections", label: "Connexions" },
    { key: "activations", label: "Activations" },
  ];

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.title}>Historique</Text>
        <View style={styles.filterRow}>
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[styles.filterBtn, filter === f.key && styles.filterBtnActive]}
            >
              <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : filteredItems.length === 0 ? (
        <View style={styles.center}>
          <View style={styles.emptyIcon}>
            <Ionicons name="time-outline" size={40} color={Colors.textMuted} />
          </View>
          <Text style={styles.emptyText}>Aucune activité</Text>
          <Text style={styles.emptyHint}>Votre historique apparaîtra ici</Text>
        </View>
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 100 }]}
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
  header: { paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  title: { fontSize: 24, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  filterRow: { flexDirection: "row", gap: 8 },
  filterBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.bgCard },
  filterBtnActive: { backgroundColor: Colors.primaryDim, borderColor: Colors.primary + "50" },
  filterText: { fontSize: 12, color: Colors.textMuted, fontFamily: "Inter_500Medium" },
  filterTextActive: { color: Colors.primary, fontFamily: "Inter_600SemiBold" },
  list: { paddingHorizontal: 20, paddingTop: 16 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.bgCard, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  emptyHint: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular" },
});

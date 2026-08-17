import React from "react";
import { Modal, StyleSheet, Text, View, Pressable, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";

interface Announcement {
  id: string;
  title: string;
  message: string;
  type: string;
}

interface Props {
  announcement: Announcement | null;
  onClose: () => void;
}

const TYPE_CONFIG: Record<string, { icon: string; color: string; bg: string }> = {
  critical: { icon: "alert-circle", color: Colors.disconnected, bg: "#301010" },
  warning:  { icon: "warning",      color: Colors.warning,      bg: "#302510" },
  success:  { icon: "checkmark-circle", color: Colors.connected, bg: "#103020" },
  info:     { icon: "information-circle", color: Colors.primary, bg: "#102030" },
};

export default function AnnouncementModal({ announcement, onClose }: Props) {
  if (!announcement) return null;

  const config = TYPE_CONFIG[announcement.type] || TYPE_CONFIG.info;

  return (
    <Modal transparent visible={!!announcement} animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <LinearGradient colors={[config.bg, "#060914"]} style={styles.content}>
            <View style={styles.header}>
              <View style={[styles.iconWrap, { backgroundColor: config.color + "20" }]}>
                <Ionicons name={config.icon as any} size={32} color={config.color} />
              </View>
              <Text style={styles.title}>{announcement.title}</Text>
            </View>

            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              <Text style={styles.message}>{announcement.message}</Text>
            </ScrollView>

            <Pressable onPress={onClose} style={[styles.closeBtn, { backgroundColor: config.color }]}>
              <Text style={styles.closeBtnText}>Compris</Text>
            </Pressable>
          </LinearGradient>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", alignItems: "center", padding: 24 },
  modal: { width: "100%", maxWidth: 400, borderRadius: 24, overflow: "hidden", borderWidth: 1, borderColor: Colors.border },
  content: { padding: 24, gap: 20 },
  header: { alignItems: "center", gap: 12 },
  iconWrap: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 20, fontWeight: "700", color: "#FFF", textAlign: "center", fontFamily: "Inter_700Bold" },
  scroll: { maxHeight: 300 },
  message: { fontSize: 14, color: Colors.textSecondary, textAlign: "center", lineHeight: 22, fontFamily: "Inter_400Regular" },
  closeBtn: { paddingVertical: 14, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  closeBtnText: { color: "#000", fontWeight: "700", fontSize: 15, fontFamily: "Inter_700Bold" },
});

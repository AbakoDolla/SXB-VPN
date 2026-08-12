import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "@/services/apiClient";
import Colors from "@/constants/colors";
import { useTranslation, type TranslationKey } from "@/localization";

type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

type SupportTicket = {
  id: string;
  title: string;
  description?: string | null;
  priority: "low" | "medium" | "high";
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
};

function FaqItem({ item }: { item: { q: string; a: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(!open)} style={styles.faqItem} accessibilityRole="button">
      <View style={styles.faqQ}>
        <Ionicons name="help-circle-outline" size={18} color={Colors.primary} />
        <Text style={styles.faqQText}>{item.q}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={Colors.textMuted} />
      </View>
      {open && <Text style={styles.faqA}>{item.a}</Text>}
    </Pressable>
  );
}

export default function SupportScreen() {
  const { t, language } = useTranslation();
  const insets = useSafeAreaInsets();
  const subjectRef = useRef<TextInput>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const FAQ = [
    { q: t("faq_q1"), a: t("faq_a1") },
    { q: t("faq_q2"), a: t("faq_a2") },
    { q: t("faq_q3"), a: t("faq_a3") },
    { q: t("faq_q4"), a: t("faq_a4") },
  ];

  const loadTickets = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoadingTickets(true);
    try {
      const response = await apiClient.get("/mobile/support/tickets");
      setTickets(Array.isArray(response.data?.tickets) ? response.data.tickets : []);
      setError(null);
    } catch {
      setError(t("ticket_load_failed"));
    } finally {
      setLoadingTickets(false);
      setRefreshing(false);
    }
  // `t` est recréée à chaque rendu par le contexte : dépendre d’elle ici
  // relançait automatiquement l’effet et saturait l’API support. La langue,
  // elle, ne change que lors d’un choix explicite de l’utilisateur.
  }, [language]);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  const handleSend = async () => {
    if (!subject.trim() || !message.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await apiClient.post("/mobile/support/ticket", {
        subject: subject.trim(),
        message: message.trim(),
      });
      const ticket = response.data?.ticket as SupportTicket | undefined;
      if (!ticket) throw new Error("Ticket response missing");
      setTickets((previous) => [ticket, ...previous.filter((item) => item.id !== ticket.id)]);
      setSent(true);
      setSubject("");
      setMessage("");
      setTimeout(() => setSent(false), 3000);
    } catch {
      setError(t("ticket_send_failed"));
    } finally {
      setSending(false);
    }
  };

  const ticketStatusKeys: Record<TicketStatus, TranslationKey> = {
    open: "ticket_open",
    in_progress: "ticket_in_progress",
    resolved: "ticket_resolved",
    closed: "ticket_closed",
  };
  const statusLabel = (status: TicketStatus) => t(ticketStatusKeys[status]);
  const statusColor = (status: TicketStatus) => {
    if (status === "resolved" || status === "closed") return Colors.connected;
    if (status === "in_progress") return "#F5A524";
    return Colors.primary;
  };

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: 16, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadTickets(true)} tintColor={Colors.primary} />}
      >
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="headset" size={40} color={Colors.primary} />
          </View>
          <Text style={styles.heroTitle}>{t("support")}</Text>
          <Text style={styles.heroSub}>{t("hero_sub")}</Text>
          <Pressable onPress={() => subjectRef.current?.focus()} style={styles.heroBtn} accessibilityRole="button">
            <Ionicons name="create-outline" size={16} color="#000" />
            <Text style={styles.heroBtnText}>{t("create_ticket")}</Text>
          </Pressable>
        </View>

        {error && (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle-outline" size={18} color="#FF7184" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.formSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="create-outline" size={18} color={Colors.primary} />
            <Text style={styles.sectionTitle}>{t("contact_us")}</Text>
          </View>
          <View style={styles.formCard}>
            <TextInput
              ref={subjectRef}
              style={styles.input}
              placeholder={t("ticket_subject_placeholder")}
              placeholderTextColor={Colors.textMuted}
              value={subject}
              onChangeText={setSubject}
              maxLength={200}
            />
            <TextInput
              style={[styles.input, styles.textarea]}
              placeholder={t("ticket_message_placeholder")}
              placeholderTextColor={Colors.textMuted}
              value={message}
              onChangeText={setMessage}
              multiline
              numberOfLines={4}
              maxLength={5000}
              textAlignVertical="top"
            />
            <Pressable
              onPress={handleSend}
              disabled={sending || !subject.trim() || !message.trim()}
              style={[styles.sendBtn, (sending || sent) && { backgroundColor: Colors.connected }, (!subject.trim() || !message.trim()) && styles.sendBtnDisabled]}
              accessibilityRole="button"
            >
              {sending
                ? <ActivityIndicator size="small" color="#000" />
                : <>
                    <Ionicons name={sent ? "checkmark" : "send"} size={16} color="#000" />
                    <Text style={styles.sendBtnText}>{sent ? t("sent") : t("send")}</Text>
                  </>}
            </Pressable>
            {sent && <Text style={styles.successText}>{t("ticket_success")}</Text>}
          </View>
        </View>

        <View style={styles.ticketSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="ticket-outline" size={18} color={Colors.primary} />
            <Text style={styles.sectionTitle}>{t("my_tickets")}</Text>
            {loadingTickets && <ActivityIndicator size="small" color={Colors.primary} />}
          </View>
          {!loadingTickets && tickets.length === 0 ? (
            <View style={styles.emptyTickets}>
              <Ionicons name="file-tray-outline" size={27} color={Colors.textMuted} />
              <Text style={styles.emptyText}>{t("ticket_empty")}</Text>
            </View>
          ) : (
            tickets.map((ticket) => (
              <View key={ticket.id} style={styles.ticketCard}>
                <View style={styles.ticketTop}>
                  <Text style={styles.ticketTitle} numberOfLines={1}>{ticket.title}</Text>
                  <View style={[styles.statusBadge, { borderColor: statusColor(ticket.status) + "80", backgroundColor: statusColor(ticket.status) + "18" }]}>
                    <Text style={[styles.statusText, { color: statusColor(ticket.status) }]}>{statusLabel(ticket.status)}</Text>
                  </View>
                </View>
                {!!ticket.description && <Text style={styles.ticketMessage} numberOfLines={2}>{ticket.description}</Text>}
                <Text style={styles.ticketDate}>{t("ticket_updated_at")} · {new Date(ticket.updatedAt).toLocaleDateString()}</Text>
              </View>
            ))
          )}
        </View>

        <View style={styles.faqSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="help-circle-outline" size={18} color={Colors.primary} />
            <Text style={styles.sectionTitle}>{t("faq")}</Text>
          </View>
          <View style={styles.faqCard}>
            {FAQ.map((item, index) => (
              <View key={item.q}>
                <FaqItem item={item} />
                {index < FAQ.length - 1 && <View style={styles.divider} />}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, gap: 20 },
  hero: { alignItems: "center", gap: 10, backgroundColor: Colors.bgCard, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, padding: 24 },
  heroIcon: { width: 80, height: 80, borderRadius: 40, backgroundColor: Colors.primaryDim, borderWidth: 1, borderColor: Colors.primary + "40", alignItems: "center", justifyContent: "center" },
  heroTitle: { fontSize: 20, fontWeight: "700", color: "#FFF", fontFamily: "Inter_700Bold" },
  heroSub: { fontSize: 13, color: Colors.textMuted, fontFamily: "Inter_400Regular", textAlign: "center" },
  heroBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: Colors.primary, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, marginTop: 4 },
  heroBtnText: { fontSize: 14, fontWeight: "700", color: "#000", fontFamily: "Inter_700Bold" },
  errorCard: { flexDirection: "row", alignItems: "center", gap: 9, padding: 13, borderWidth: 1, borderColor: "#FF718440", backgroundColor: "#FF718412", borderRadius: 14 },
  errorText: { flex: 1, color: "#FFB1BC", fontSize: 13, lineHeight: 19, fontFamily: "Inter_400Regular" },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 4, marginBottom: 8 },
  sectionTitle: { flex: 1, fontSize: 14, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  formSection: { gap: 0 },
  formCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, padding: 14, gap: 10 },
  input: { backgroundColor: Colors.bgInput, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: "#FFF", fontFamily: "Inter_400Regular" },
  textarea: { minHeight: 100 },
  sendBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 13 },
  sendBtnDisabled: { opacity: 0.48 },
  sendBtnText: { fontSize: 14, fontWeight: "700", color: "#000", fontFamily: "Inter_700Bold" },
  successText: { color: Colors.connected, fontSize: 12, textAlign: "center", fontFamily: "Inter_500Medium" },
  ticketSection: { gap: 0 },
  emptyTickets: { minHeight: 92, alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border },
  emptyText: { color: Colors.textMuted, fontSize: 13, fontFamily: "Inter_400Regular" },
  ticketCard: { backgroundColor: Colors.bgCard, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, padding: 14, gap: 8, marginBottom: 9 },
  ticketTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  ticketTitle: { flex: 1, color: "#FFF", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  statusBadge: { borderWidth: 1, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4 },
  statusText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  ticketMessage: { color: Colors.textSecondary, fontSize: 12, lineHeight: 18, fontFamily: "Inter_400Regular" },
  ticketDate: { color: Colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular" },
  faqSection: { gap: 0 },
  faqCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 14 },
  faqItem: { paddingVertical: 14, gap: 8 },
  faqQ: { flexDirection: "row", alignItems: "center", gap: 8 },
  faqQText: { flex: 1, fontSize: 13, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  faqA: { fontSize: 13, color: Colors.textSecondary, fontFamily: "Inter_400Regular", lineHeight: 20, paddingLeft: 26 },
  divider: { height: 1, backgroundColor: Colors.border },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import apiClient from "@/services/apiClient";
import { useColors } from "@/hooks/useColors";
import { useTranslation, type TranslationKey } from "@/localization";

type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
type SupportTicket = { id: string; title: string; description?: string | null; priority: "low" | "medium" | "high"; status: TicketStatus; createdAt: string; updatedAt: string };

function FaqItem({ item }: { item: { q: string; a: string } }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  return <Pressable onPress={() => setOpen((value) => !value)} style={({ pressed }) => [styles.faqItem, { borderBottomColor: colors.border }, pressed && styles.pressed]} accessibilityRole="button"><View style={styles.faqQuestion}><Ionicons name="help-circle-outline" size={18} color={colors.primary} /><Text style={[styles.faqQuestionText, { color: colors.textPrimary }]}>{item.q}</Text><Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.textMuted} /></View>{open && <Text style={[styles.faqAnswer, { color: colors.textSecondary }]}>{item.a}</Text>}</Pressable>;
}

export default function SupportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, language } = useTranslation();
  const subjectRef = useRef<TextInput>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const faq = ["faq_q1", "faq_q2", "faq_q3", "faq_q4"].map((key, index) => ({ q: t(key as TranslationKey), a: t(`faq_a${index + 1}` as TranslationKey) }));

  const loadTickets = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true); else setLoadingTickets(true);
    try { const response = await apiClient.get("/mobile/support/tickets"); setTickets(Array.isArray(response.data?.tickets) ? response.data.tickets : []); setError(null); }
    catch { setError(t("ticket_load_failed")); }
    finally { setLoadingTickets(false); setRefreshing(false); }
  }, [language]);
  useEffect(() => { void loadTickets(); }, [loadTickets]);

  const handleSend = async () => {
    if (!subject.trim() || !message.trim() || sending) return;
    setSending(true); setError(null);
    try { const response = await apiClient.post("/mobile/support/ticket", { subject: subject.trim(), message: message.trim() }); const ticket = response.data?.ticket as SupportTicket | undefined; if (!ticket) throw new Error("Ticket response missing"); setTickets((previous) => [ticket, ...previous.filter((item) => item.id !== ticket.id)]); setSent(true); setSubject(""); setMessage(""); setTimeout(() => setSent(false), 3000); }
    catch { setError(t("ticket_send_failed")); }
    finally { setSending(false); }
  };
  const statusColor = (status: TicketStatus) => status === "resolved" || status === "closed" ? colors.connected : status === "in_progress" ? colors.warning : colors.primary;
  const statusKey: Record<TicketStatus, TranslationKey> = { open: "ticket_open", in_progress: "ticket_in_progress", resolved: "ticket_resolved", closed: "ticket_closed" };

  return <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}><ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void loadTickets(true)} tintColor={colors.primary} />}>
    <View style={[styles.hero, { backgroundColor: colors.bgCard, borderColor: colors.border }]}><View style={[styles.heroIcon, { backgroundColor: colors.primaryDim, borderColor: colors.primary + "45" }]}><Ionicons name="headset-outline" size={38} color={colors.primary} /></View><Text style={[styles.eyebrow, { color: colors.primary }]}>SXB VPN · ASSISTANCE</Text><Text style={[styles.heroTitle, { color: colors.textPrimary }]}>{t("support")}</Text><Text style={[styles.heroSub, { color: colors.textSecondary }]}>{t("hero_sub")}</Text><Pressable onPress={() => subjectRef.current?.focus()} style={({ pressed }) => [styles.heroButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}><Ionicons name="create-outline" size={16} color={colors.primaryForeground} /><Text style={[styles.heroButtonText, { color: colors.primaryForeground }]}>{t("create_ticket")}</Text></Pressable></View>
    {error && <View style={[styles.errorCard, { backgroundColor: colors.disconnectedDim, borderColor: colors.disconnected + "45" }]}><Ionicons name="alert-circle-outline" size={18} color={colors.disconnected} /><Text style={[styles.errorText, { color: colors.disconnected }]}>{error}</Text></View>}
    <SectionHeader icon="create-outline" title={t("contact_us")} colors={colors} /><View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.border }]}><TextInput ref={subjectRef} style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgInput, borderColor: colors.border }]} placeholder={t("ticket_subject_placeholder")} placeholderTextColor={colors.textMuted} value={subject} onChangeText={setSubject} maxLength={200} /><TextInput style={[styles.input, styles.textarea, { color: colors.textPrimary, backgroundColor: colors.bgInput, borderColor: colors.border }]} placeholder={t("ticket_message_placeholder")} placeholderTextColor={colors.textMuted} value={message} onChangeText={setMessage} multiline numberOfLines={4} maxLength={5000} textAlignVertical="top" /><Pressable onPress={handleSend} disabled={sending || !subject.trim() || !message.trim()} style={({ pressed }) => [styles.sendButton, { backgroundColor: sent ? colors.connected : colors.primary }, (!subject.trim() || !message.trim() || sending) && styles.disabled, pressed && styles.pressed]}>{sending ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <><Ionicons name={sent ? "checkmark" : "send"} size={16} color={colors.primaryForeground} /><Text style={[styles.sendText, { color: colors.primaryForeground }]}>{sent ? t("sent") : t("send")}</Text></>}</Pressable>{sent && <Text style={[styles.successText, { color: colors.connected }]}>{t("ticket_success")}</Text>}</View>
    <SectionHeader icon="ticket-outline" title={t("my_tickets")} colors={colors} trailing={loadingTickets ? <ActivityIndicator size="small" color={colors.primary} /> : undefined} />{!loadingTickets && tickets.length === 0 ? <View style={[styles.emptyCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}><Ionicons name="file-tray-outline" size={28} color={colors.textMuted} /><Text style={[styles.emptyText, { color: colors.textMuted }]}>{t("ticket_empty")}</Text></View> : tickets.map((ticket) => { const color = statusColor(ticket.status); return <View key={ticket.id} style={[styles.ticketCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}><View style={styles.ticketTop}><Text style={[styles.ticketTitle, { color: colors.textPrimary }]} numberOfLines={1}>{ticket.title}</Text><View style={[styles.statusBadge, { borderColor: color + "70", backgroundColor: color + "16" }]}><Text style={[styles.statusText, { color }]}>{t(statusKey[ticket.status])}</Text></View></View>{ticket.description && <Text style={[styles.ticketMessage, { color: colors.textSecondary }]} numberOfLines={2}>{ticket.description}</Text>}<Text style={[styles.ticketDate, { color: colors.textMuted }]}>{t("ticket_updated_at")} · {new Date(ticket.updatedAt).toLocaleDateString()}</Text></View>; })}
    <SectionHeader icon="help-circle-outline" title={t("faq")} colors={colors} /><View style={[styles.card, { backgroundColor: colors.bgCard, borderColor: colors.border, paddingHorizontal: 14 }]}>{faq.map((item, index) => <View key={item.q}><FaqItem item={item} />{index < faq.length - 1 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}</View>)}</View>
  </ScrollView></LinearGradient>;
}

function SectionHeader({ icon, title, colors, trailing }: { icon: string; title: string; colors: ReturnType<typeof import("@/hooks/useColors").useColors>; trailing?: React.ReactNode }) { return <View style={styles.sectionHeader}><Ionicons name={icon as any} size={18} color={colors.primary} /><Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{title}</Text>{trailing}</View>; }

const styles = StyleSheet.create({ container: { flex: 1 }, content: { paddingHorizontal: 20, gap: 10 }, hero: { alignItems: "center", gap: 9, borderRadius: 24, borderWidth: 1, padding: 23, marginBottom: 8 }, heroIcon: { width: 78, height: 78, borderRadius: 28, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 3 }, eyebrow: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.5 }, heroTitle: { fontSize: 22, fontFamily: "Inter_700Bold" }, heroSub: { fontSize: 13, lineHeight: 19, fontFamily: "Inter_400Regular", textAlign: "center" }, heroButton: { minHeight: 45, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, borderRadius: 14, marginTop: 3 }, heroButtonText: { fontSize: 13, fontFamily: "Inter_700Bold" }, errorCard: { flexDirection: "row", alignItems: "center", gap: 9, padding: 13, borderWidth: 1, borderRadius: 15 }, errorText: { flex: 1, fontSize: 12, lineHeight: 18, fontFamily: "Inter_400Regular" }, sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 4, paddingTop: 8, marginBottom: 3 }, sectionTitle: { flex: 1, fontSize: 14, fontFamily: "Inter_700Bold" }, card: { borderRadius: 19, borderWidth: 1, padding: 14, gap: 10 }, input: { minHeight: 46, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11, fontSize: 13, fontFamily: "Inter_400Regular" }, textarea: { minHeight: 105, paddingTop: 13 }, sendButton: { minHeight: 47, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 13 }, sendText: { fontSize: 13, fontFamily: "Inter_700Bold" }, successText: { fontSize: 12, textAlign: "center", fontFamily: "Inter_500Medium" }, disabled: { opacity: 0.48 }, ticketCard: { borderRadius: 17, borderWidth: 1, padding: 14, gap: 7, marginBottom: 9 }, ticketTop: { flexDirection: "row", alignItems: "center", gap: 8 }, ticketTitle: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold" }, statusBadge: { borderWidth: 1, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4 }, statusText: { fontSize: 10, fontFamily: "Inter_600SemiBold" }, ticketMessage: { fontSize: 12, lineHeight: 18, fontFamily: "Inter_400Regular" }, ticketDate: { fontSize: 10, fontFamily: "Inter_400Regular" }, emptyCard: { minHeight: 90, alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 17, borderWidth: 1 }, emptyText: { fontSize: 12, fontFamily: "Inter_400Regular" }, faqItem: { paddingVertical: 14, gap: 8 }, faqQuestion: { flexDirection: "row", alignItems: "center", gap: 8 }, faqQuestionText: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold" }, faqAnswer: { fontSize: 13, lineHeight: 20, fontFamily: "Inter_400Regular", paddingLeft: 26 }, divider: { height: 1 }, pressed: { opacity: 0.7, transform: [{ scale: 0.99 }] },
});

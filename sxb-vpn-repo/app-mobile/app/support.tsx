import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import apiClient from "@/services/apiClient";
import Colors from "@/constants/colors";

const FAQ = [
  { q: "Comment activer mon compte ?", a: "Entrez votre token SXB-USER dans l'écran d'activation. Vous l'obtenez auprès de votre administrateur." },
  { q: "Mon VPN ne se connecte pas", a: "Vérifiez votre connexion internet, puis assurez-vous que votre forfait est actif et non expiré." },
  { q: "Comment renouveler mon forfait ?", a: "Utilisez un token SXB-DATA fourni par votre administrateur dans la section Activer un forfait." },
  { q: "Combien d'appareils puis-je utiliser ?", a: "Le nombre d'appareils autorisés dépend de votre forfait. Consultez votre profil pour voir la limite." },
];

function FaqItem({ item }: { item: { q: string; a: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(!open)} style={styles.faqItem}>
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
  const insets = useSafeAreaInsets();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent]       = useState(false);

  const handleSend = async () => {
    if (!subject.trim() || !message.trim()) return;
    setSending(true);
    try {
      await apiClient.post("/mobile/support/ticket", { subject, message });
    } catch (_) {}
    setSent(true);
    setSending(false);
    setSubject(""); setMessage("");
    setTimeout(() => setSent(false), 3000);
  };

  return (
    <LinearGradient colors={["#060914", "#0A1025", "#060914"]} style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: 16, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="headset" size={40} color={Colors.primary} />
          </View>
          <Text style={styles.heroTitle}>Besoin d'aide ?</Text>
          <Text style={styles.heroSub}>Notre équipe est disponible pour vous aider.</Text>
          <Pressable onPress={handleSend} style={styles.heroBtn}>
            <Ionicons name="create-outline" size={16} color="#000" />
            <Text style={styles.heroBtnText}>Créer un ticket</Text>
          </Pressable>
        </View>

        {/* Quick contacts */}
        <View style={styles.contactRow}>
          {[
            { icon: "logo-whatsapp", label: "WhatsApp", color: "#25D366" },
            { icon: "mail-outline",  label: "Email",    color: Colors.primary },
            { icon: "logo-discord",  label: "Discord",  color: "#5865F2" },
          ].map((c) => (
            <Pressable key={c.label} style={[styles.contactBtn, { borderColor: c.color + "30", backgroundColor: c.color + "10" }]}>
              <Ionicons name={c.icon as any} size={22} color={c.color} />
              <Text style={[styles.contactLabel, { color: c.color }]}>{c.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* FAQ */}
        <View style={styles.faqSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="help-circle-outline" size={18} color={Colors.primary} />
            <Text style={styles.sectionTitle}>Questions fréquentes</Text>
          </View>
          <View style={styles.faqCard}>
            {FAQ.map((item, i) => (
              <View key={i}>
                <FaqItem item={item} />
                {i < FAQ.length - 1 && <View style={styles.divider} />}
              </View>
            ))}
          </View>
        </View>

        {/* Ticket form */}
        <View style={styles.formSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="create-outline" size={18} color={Colors.primary} />
            <Text style={styles.sectionTitle}>Nous contacter</Text>
          </View>
          <View style={styles.formCard}>
            <TextInput
              style={styles.input}
              placeholder="Sujet"
              placeholderTextColor={Colors.textMuted}
              value={subject}
              onChangeText={setSubject}
            />
            <TextInput
              style={[styles.input, styles.textarea]}
              placeholder="Décrivez votre problème..."
              placeholderTextColor={Colors.textMuted}
              value={message}
              onChangeText={setMessage}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
            <Pressable onPress={handleSend} disabled={sending || !subject.trim() || !message.trim()} style={[styles.sendBtn, (sending || sent) && { backgroundColor: Colors.connected }]}>
              {sending
                ? <ActivityIndicator size="small" color="#000" />
                : <>
                    <Ionicons name={sent ? "checkmark" : "send"} size={16} color="#000" />
                    <Text style={styles.sendBtnText}>{sent ? "Envoyé !" : "Envoyer"}</Text>
                  </>
              }
            </Pressable>
          </View>
        </View>

        {/* Ticket history */}
        <Pressable style={styles.historyBtn}>
          <Ionicons name="ticket-outline" size={18} color={Colors.textSecondary} />
          <Text style={styles.historyBtnText}>Voir mes tickets</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
        </Pressable>
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
  contactRow: { flexDirection: "row", gap: 10 },
  contactBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 14, borderWidth: 1 },
  contactLabel: { fontSize: 12, fontWeight: "600", fontFamily: "Inter_600SemiBold" },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 4, marginBottom: 8 },
  sectionTitle: { fontSize: 14, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  faqSection: { gap: 0 },
  faqCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 14 },
  faqItem: { paddingVertical: 14, gap: 8 },
  faqQ: { flexDirection: "row", alignItems: "center", gap: 8 },
  faqQText: { flex: 1, fontSize: 13, fontWeight: "600", color: "#FFF", fontFamily: "Inter_600SemiBold" },
  faqA: { fontSize: 13, color: Colors.textSecondary, fontFamily: "Inter_400Regular", lineHeight: 20, paddingLeft: 26 },
  divider: { height: 1, backgroundColor: Colors.border },
  formSection: { gap: 0 },
  formCard: { backgroundColor: Colors.bgCard, borderRadius: 16, borderWidth: 1, borderColor: Colors.border, padding: 14, gap: 10 },
  input: { backgroundColor: Colors.bgInput, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: "#FFF", fontFamily: "Inter_400Regular" },
  textarea: { minHeight: 100 },
  sendBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 13 },
  sendBtnText: { fontSize: 14, fontWeight: "700", color: "#000", fontFamily: "Inter_700Bold" },
  historyBtn: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: Colors.bgCard, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, padding: 14 },
  historyBtnText: { flex: 1, fontSize: 14, color: Colors.textSecondary, fontFamily: "Inter_500Medium" },
});

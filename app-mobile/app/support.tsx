import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';

interface FaqItem { q: string; a: string }

function FaqAccordion({ item }: { item: FaqItem }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);

  return (
    <Pressable
      onPress={() => { setOpen(!open); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
      style={[styles.faqCard, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={styles.faqRow}>
        <Text style={[styles.faqQ, { color: colors.foreground, flex: 1 }]}>{item.q}</Text>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.mutedForeground}
        />
      </View>
      {open && (
        <Text style={[styles.faqA, { color: colors.mutedForeground }]}>{item.a}</Text>
      )}
    </Pressable>
  );
}

export default function SupportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const faqs: FaqItem[] = [
    { q: t('faq_q1'), a: t('faq_a1') },
    { q: t('faq_q2'), a: t('faq_a2') },
    { q: t('faq_q3'), a: t('faq_a3') },
    { q: t('faq_q4'), a: t('faq_a4') },
  ];

  const handleSend = () => {
    if (!message.trim()) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSent(true);
    setSubject('');
    setMessage('');
    setTimeout(() => setSent(false), 3000);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* FAQ */}
        <Text style={[styles.section, { color: colors.foreground }]}>{t('faq')}</Text>
        {faqs.map((item, i) => (
          <FaqAccordion key={i} item={item} />
        ))}

        {/* Contact */}
        <Text style={[styles.section, { color: colors.foreground }]}>{t('contact_us')}</Text>
        <View style={styles.contactRow}>
          <Pressable
            onPress={() => Linking.openURL('https://wa.me/+22507XXXXXXXX')}
            style={[styles.contactBtn, { backgroundColor: `${colors.connected}22`, borderColor: colors.connected }]}
          >
            <Ionicons name="logo-whatsapp" size={22} color={colors.connected} />
            <Text style={[styles.contactText, { color: colors.connected }]}>WhatsApp</Text>
          </Pressable>
          <Pressable
            onPress={() => Linking.openURL('mailto:support@sxb-vpn.com')}
            style={[styles.contactBtn, { backgroundColor: `${colors.primary}22`, borderColor: colors.primary }]}
          >
            <Ionicons name="mail-outline" size={22} color={colors.primary} />
            <Text style={[styles.contactText, { color: colors.primary }]}>Email</Text>
          </Pressable>
        </View>

        {/* Ticket form */}
        <Text style={[styles.section, { color: colors.foreground }]}>{t('create_ticket')}</Text>
        <View style={[styles.form, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.input, color: colors.foreground, borderColor: colors.border }]}
            placeholder={t('ticket_subject')}
            placeholderTextColor={colors.mutedForeground}
            value={subject}
            onChangeText={setSubject}
          />
          <TextInput
            style={[styles.textarea, { backgroundColor: colors.input, color: colors.foreground, borderColor: colors.border }]}
            placeholder={t('ticket_message')}
            placeholderTextColor={colors.mutedForeground}
            value={message}
            onChangeText={setMessage}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
          <Pressable
            onPress={handleSend}
            style={[styles.sendBtn, { backgroundColor: sent ? colors.connected : colors.primary }]}
          >
            <Ionicons name={sent ? 'checkmark' : 'send'} size={18} color="#FFF" />
            <Text style={styles.sendText}>
              {sent ? t('ticket_success') : t('ticket_submit')}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
  section: { fontSize: 18, fontWeight: '700' as const, marginTop: 8, marginBottom: 4, fontFamily: 'Inter_700Bold' },
  faqCard: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 10 },
  faqRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  faqQ: { fontSize: 14, fontWeight: '500' as const, lineHeight: 20 },
  faqA: { fontSize: 13, lineHeight: 20 },
  contactRow: { flexDirection: 'row', gap: 12 },
  contactBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1 },
  contactText: { fontSize: 15, fontWeight: '600' as const },
  form: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  input: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14 },
  textarea: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, minHeight: 100 },
  sendBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, paddingVertical: 14 },
  sendText: { color: '#FFF', fontSize: 15, fontWeight: '600' as const },
});

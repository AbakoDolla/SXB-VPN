import React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import { useLanguageContext } from '@/contexts/LanguageContext';
import { useThemeContext } from '@/contexts/ThemeContext';
import type { Language } from '@/localization';

function SettingRow({
  icon,
  label,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  children?: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <View style={[styles.rowIcon, { backgroundColor: `${colors.primary}22` }]}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <Text style={[styles.rowLabel, { color: colors.foreground, flex: 1 }]}>{label}</Text>
      {children}
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  const colors = useColors();
  return <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{title.toUpperCase()}</Text>;
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguageContext();
  const { themePreference, setThemePreference } = useThemeContext();

  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Language */}
        <SectionHeader title={t('language_section')} />
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {(['fr', 'en'] as Language[]).map((lang, i) => (
            <Pressable
              key={lang}
              onPress={() => setLanguage(lang)}
              style={[
                styles.selectRow,
                { borderColor: colors.border },
                i > 0 && { borderTopWidth: 1 },
              ]}
            >
              <Text style={[styles.selectLabel, { color: colors.foreground }]}>
                {lang === 'fr' ? t('french') : t('english')}
              </Text>
              {language === lang && (
                <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
              )}
            </Pressable>
          ))}
        </View>

        {/* Theme */}
        <SectionHeader title={t('theme_section')} />
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {(['system', 'dark', 'light'] as const).map((mode, i) => (
            <Pressable
              key={mode}
              onPress={() => setThemePreference(mode)}
              style={[
                styles.selectRow,
                { borderColor: colors.border },
                i > 0 && { borderTopWidth: 1 },
              ]}
            >
              <Ionicons
                name={mode === 'dark' ? 'moon-outline' : mode === 'light' ? 'sunny-outline' : 'phone-portrait-outline'}
                size={18}
                color={colors.mutedForeground}
              />
              <Text style={[styles.selectLabel, { color: colors.foreground, flex: 1 }]}>
                {mode === 'dark' ? t('theme_dark') : mode === 'light' ? t('theme_light') : t('theme_system')}
              </Text>
              {themePreference === mode && (
                <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
              )}
            </Pressable>
          ))}
        </View>

        {/* Security */}
        <SectionHeader title={t('security_section')} />
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SettingRow icon="finger-print-outline" label={t('biometrics')}>
            <Switch
              value={false}
              onValueChange={() => {}}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#FFFFFF"
            />
          </SettingRow>
        </View>

        {/* About */}
        <SectionHeader title={t('about_section')} />
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SettingRow icon="information-circle-outline" label={t('version')}>
            <Text style={[styles.valueText, { color: colors.mutedForeground }]}>{version}</Text>
          </SettingRow>
          <View style={[styles.sep, { backgroundColor: colors.border }]} />
          <Pressable
            onPress={() => Linking.openURL('https://sxb-vpn.com/terms')}
            style={[styles.selectRow, { borderColor: colors.border }]}
          >
            <Ionicons name="document-text-outline" size={18} color={colors.mutedForeground} />
            <Text style={[styles.selectLabel, { color: colors.foreground, flex: 1 }]}>{t('terms')}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
          </Pressable>
          <View style={[styles.sep, { backgroundColor: colors.border }]} />
          <Pressable
            onPress={() => Linking.openURL('https://sxb-vpn.com/privacy')}
            style={styles.selectRow}
          >
            <Ionicons name="shield-outline" size={18} color={colors.mutedForeground} />
            <Text style={[styles.selectLabel, { color: colors.foreground, flex: 1 }]}>{t('privacy_policy')}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 8, gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '600' as const, letterSpacing: 0.8, marginTop: 16, marginBottom: 4, paddingHorizontal: 4 },
  card: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { fontSize: 15 },
  selectRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  selectLabel: { fontSize: 15 },
  sep: { height: 1, marginHorizontal: 16 },
  valueText: { fontSize: 14 },
});

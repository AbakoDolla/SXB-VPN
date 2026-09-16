/**
 * Diagnostic — écran UNIQUE des journaux et de l'état de la connexion.
 *
 * Les journaux étaient auparavant dispersés à trois endroits : les étapes en
 * ligne sur l'accueil, une fenêtre modale sur l'accueil, et une seconde fenêtre
 * modale dans les réglages. Chacune montrait une partie différente, sans que
 * rien n'indique laquelle faisait foi. Tout est désormais réuni ici :
 *
 *   • l'état vivant de la connexion (latence, débits, durée, adresse) ;
 *   • le déroulé des étapes d'établissement ;
 *   • le flux brut, filtrable et copiable.
 *
 * La mesure de latence est locale à cet écran et s'arrête à sa fermeture : elle
 * ne consomme donc rien tant que l'utilisateur ne consulte pas le diagnostic.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import apiClient from '@/services/apiClient';
import { useVpnContext, formatBytes, formatSpeed } from '@/contexts/VpnContext';
import { useColors } from '@/hooks/useColors';
import { useResponsive } from '@/hooks/useResponsive';
import { useTranslation } from '@/localization';
import { alpha, layout, radius, spacing, type } from '@/constants/theme';
import { EmptyState, IconButton, Pill, SectionHeader, StatRow, StatTile, Surface } from '@/components/ui/Primitives';
import { traduireJournal } from '@/services/logTranslator';

type Filter = 'all' | 'errors' | 'engine';

export default function DiagnosticsScreen() {
  const colors = useColors();
  const responsive = useResponsive();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const {
    vpnLogs, stepLogs, isConnected, isConnecting, vpnState,
    connectedProtocol, selectedProtocol, trafficStats,
  } = useVpnContext();

  const [filter, setFilter] = useState<Filter>('all');
  const [ping, setPing] = useState<number | null>(null);
  const [pingHistory, setPingHistory] = useState<number[]>([]);
  const [copied, setCopied] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);

  // Latence mesurée uniquement pendant la consultation de cet écran.
  useEffect(() => {
    if (!isConnected) {
      setPing(null);
      setPingHistory([]);
      return;
    }
    let cancelled = false;
    const measure = async () => {
      const start = Date.now();
      try {
        await apiClient.get('/health', { timeout: 4000 });
        if (cancelled) return;
        const value = Date.now() - start;
        setPing(value);
        // Douze mesures suffisent à révéler une instabilité sans alourdir l'écran.
        setPingHistory(prev => [...prev, value].slice(-12));
      } catch {
        if (!cancelled) setPing(null);
      }
    };
    void measure();
    const timer = setInterval(measure, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isConnected]);

  // Durée de session : la valeur de référence vient du service natif, qui
  // continue de compter application fermée. On avance la seconde localement
  // entre deux relevés pour que l'affichage reste fluide, et on se recale sur
  // le natif dès qu'un relevé arrive.
  useEffect(() => {
    if (!isConnected) {
      setSessionSeconds(0);
      return;
    }
    setSessionSeconds(trafficStats.connectedSeconds || 0);
    const timer = setInterval(() => setSessionSeconds(prev => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [isConnected, trafficStats.connectedSeconds]);

  const avgPing = pingHistory.length
    ? Math.round(pingHistory.reduce((a, b) => a + b, 0) / pingHistory.length)
    : null;
  const jitter = pingHistory.length > 1
    ? Math.round(Math.max(...pingHistory) - Math.min(...pingHistory))
    : null;

  // ── Journaux : traduits, jamais bruts ──────────────────────────────────────
  //
  // Les messages du moteur portent le protocole, l'hôte, le port, le chemin
  // WebSocket — tout ce qui permet de reconstituer la configuration. Ils sont
  // donc REMPLACÉS par des phrases écrites à l'avance (`logTranslator`), jamais
  // nettoyés : un masquage par expression régulière laisse passer le premier
  // message non prévu, en silence.
  const journal = useMemo(() => {
    const traduit = traduireJournal(vpnLogs);
    if (filter === 'errors') return traduit.filter(l => l.niveau === 'echec' || l.niveau === 'attention');
    return traduit;
  }, [vpnLogs, filter]);

  const stateTone = isConnected ? colors.connected : isConnecting ? colors.warning : colors.textMuted;
  const stateLabel = isConnected
    ? t('protection_active')
    : isConnecting
    ? t('connecting_status')
    : t('protection_inactive');

  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600).toString().padStart(2, '0');
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${h}:${m}:${sec}`;
  };

  const filters: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: t('filter_all') },
    { key: 'errors', label: t('logs_filter_errors') },
    { key: 'engine', label: t('logs_filter_engine') },
  ];

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <View style={[styles.header, {
        paddingHorizontal: responsive.screenPadding,
        paddingTop: insets.top + spacing.md,
        borderBottomColor: colors.border,
        maxWidth: responsive.contentMaxWidth,
        width: "100%",
        alignSelf: "center",
      }]}>
        <IconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel={t('back')} />
        <View style={{ flex: 1 }}>
          <Text style={[type.overline, { color: colors.primary }]}>{t("app_name")}</Text>
          <Text style={[type.h2, { color: colors.textPrimary }]}>{t('diagnostic_title')}</Text>
        </View>
        <Pill label={stateLabel} tone={stateTone} dot />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: responsive.screenPadding,
            paddingBottom: insets.bottom + spacing['3xl'],
            maxWidth: responsive.contentMaxWidth,
            width: "100%",
            alignSelf: "center",
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* État vivant — les mesures que l'utilisateur veut vérifier en premier. */}
        <Surface>
          <SectionHeader title={t('diagnostic_live')} icon="pulse-outline" />
          <StatRow>
            <StatTile
              label={t('info_ping')}
              value={ping !== null ? `${ping} ms` : '—'}
              icon="pulse-outline"
              tone={ping !== null && ping < 150 ? colors.connected : colors.warning}
              monospace
            />
            <StatTile
              label={t('logs_ping_avg')}
              value={avgPing !== null ? `${avgPing} ms` : '—'}
              monospace
            />
            <StatTile
              label={t('logs_jitter')}
              value={jitter !== null ? `${jitter} ms` : '—'}
              monospace
            />
          </StatRow>
          <StatRow>
            <StatTile label={t('session_duration')} value={formatDuration(sessionSeconds)} icon="time-outline" monospace />
            <StatTile label={t('engine_state')} value={stateLabel} icon="pulse-outline" />
          </StatRow>
        </Surface>

        {/* Étapes d'établissement — remplace le bloc autrefois inséré sur l'accueil. */}
        {stepLogs.length > 0 && (
          <Surface>
            <SectionHeader title={t('diagnostic_steps')} icon="git-commit-outline" />
            {stepLogs.map((step) => {
              const tone = step.status === 'done'
                ? colors.connected
                : step.status === 'error'
                ? colors.disconnected
                : step.status === 'warning'
                ? colors.warning
                : step.status === 'active'
                ? colors.primary
                : colors.textMuted;
              const icon = step.status === 'done'
                ? 'checkmark-circle'
                : step.status === 'error'
                ? 'close-circle'
                : step.status === 'warning'
                ? 'alert-circle'
                : step.status === 'active'
                ? 'ellipse'
                : 'ellipse-outline';
              return (
                <View key={step.key} style={styles.stepRow}>
                  <Ionicons name={icon as any} size={16} color={tone} />
                  <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]} numberOfLines={2}>
                    {t(step.translationKey as any)}
                  </Text>
                  {step.status === 'active' && <ActivityIndicator size="small" color={colors.primary} />}
                </View>
              );
            })}
          </Surface>
        )}

        {/* Journal d'activité — traduit, jamais brut. */}
        <Surface>
          <SectionHeader
            title={t('vpn_logs')}
            icon="pulse-outline"
            trailing={
              <Text style={[type.micro, { color: colors.textMuted }]}>{journal.length}</Text>
            }
          />

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
                    styles.filterChip,
                    {
                      backgroundColor: isActive ? colors.primaryDim : colors.bgCard2,
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

          {journal.length === 0 ? (
            <EmptyState icon="pulse-outline" title={t('logs_waiting')} />
          ) : (
            <View style={styles.journalBox}>
              {journal.slice(0, 60).map((ligne, i) => {
                const teinte = ligne.niveau === 'echec'
                  ? colors.accents.corail
                  : ligne.niveau === 'attention'
                  ? colors.accents.ambre
                  : ligne.niveau === 'ok'
                  ? colors.accents.emeraude
                  : colors.textSecondary;
                return (
                  <View key={`${i}-${ligne.cle}`} style={styles.journalRow}>
                    <View style={[styles.journalDot, { backgroundColor: teinte }]} />
                    <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>
                      {t(ligne.cle as any)}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* Ni copie ni partage : ce sont eux qui faisaient sortir le détail
              technique de l'appareil. Une phrase dit pourquoi, plutôt que de
              laisser croire à un bouton oublié. */}
          <Text style={[type.micro, { color: colors.textMuted }]}>
            {t('diagnostic_plain_hint')}
          </Text>
        </Surface>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  journalBox: { gap: spacing.sm },
  journalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  // La pastille est décalée d'un cheveu pour s'aligner sur la première ligne du
  // texte plutôt que sur le haut du bloc, qui la laissait flotter.
  journalDot: { width: 6, height: 6, borderRadius: 3, marginTop: 5 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: { paddingHorizontal: layout.screenPadding, paddingTop: spacing.lg, gap: spacing.lg },

  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },

  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filterChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
  },

  logBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    gap: 2,
    maxHeight: 340,
  },

  actionRow: { flexDirection: 'row', gap: spacing.sm },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});

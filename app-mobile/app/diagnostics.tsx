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
import { useTranslation } from '@/localization';
import { alpha, layout, radius, spacing, type } from '@/constants/theme';
import { EmptyState, IconButton, Pill, SectionHeader, StatRow, StatTile, Surface } from '@/components/ui/Primitives';

type Filter = 'all' | 'errors' | 'engine';

export default function DiagnosticsScreen() {
  const colors = useColors();
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

  const filtered = useMemo(() => {
    if (filter === 'errors') {
      return vpnLogs.filter(line => /❌|⚠️|error|failed|refus|invalid/i.test(line));
    }
    if (filter === 'engine') {
      return vpnLogs.filter(line => /\[engine\]|\[SXB_TRACE\]|\[JSch/i.test(line));
    }
    return vpnLogs;
  }, [vpnLogs, filter]);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(vpnLogs.join('\n')).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [vpnLogs]);

  const handleShare = useCallback(async () => {
    // Les journaux sont déjà masqués à la source (SecurityModule) : aucun
    // identifiant ni secret ne peut sortir par ce partage.
    await Share.share({ message: vpnLogs.slice(0, 200).join('\n') }).catch(() => {});
  }, [vpnLogs]);

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
      <View style={[styles.header, { paddingTop: insets.top + spacing.md, borderBottomColor: colors.border }]}>
        <IconButton icon="arrow-back" onPress={() => router.back()} accessibilityLabel={t('back')} />
        <View style={{ flex: 1 }}>
          <Text style={[type.overline, { color: colors.primary }]}>SXB VPN</Text>
          <Text style={[type.h2, { color: colors.textPrimary }]}>{t('diagnostic_title')}</Text>
        </View>
        <Pill label={stateLabel} tone={stateTone} dot />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing['3xl'] }]}
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
            <StatTile label={t('info_protocol')} value={connectedProtocol || selectedProtocol || '—'} icon="git-branch-outline" />
            <StatTile
              label={t('traffic_speed')}
              value={`↓${formatSpeed(trafficStats.downloadSpeed)}`}
              icon="speedometer-outline"
              tone={colors.connected}
              monospace
            />
          </StatRow>
          <StatRow>
            <StatTile label={t('traffic_sent')} value={formatBytes(trafficStats.uploadBytes)} monospace />
            <StatTile label={t('traffic_received')} value={formatBytes(trafficStats.downloadBytes)} monospace />
            <StatTile label={t('engine_state')} value={vpnState} />
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

        {/* Flux brut */}
        <Surface>
          <SectionHeader
            title={t('vpn_logs')}
            icon="terminal-outline"
            trailing={
              <Text style={[type.micro, { color: colors.textMuted }]}>{filtered.length}</Text>
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

          {filtered.length === 0 ? (
            <EmptyState icon="terminal-outline" title={t('logs_waiting')} />
          ) : (
            <View style={[styles.logBox, { backgroundColor: colors.bgInput, borderColor: colors.border }]}>
              {filtered.slice(0, 200).map((line, i) => (
                <Text
                  key={`${i}-${line.slice(0, 24)}`}
                  style={[
                    type.micro,
                    {
                      color: /❌|error|failed/i.test(line)
                        ? colors.disconnected
                        : /⚠️|warn/i.test(line)
                        ? colors.warning
                        : /✅/.test(line)
                        ? colors.connected
                        : colors.textSecondary,
                      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                    },
                  ]}
                >
                  {line}
                </Text>
              ))}
            </View>
          )}

          <View style={styles.actionRow}>
            <Pressable
              onPress={handleCopy}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.actionBtn,
                { borderColor: colors.primary + alpha.f40, backgroundColor: colors.primaryDim },
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={15} color={colors.primary} />
              <Text style={[type.captionMedium, { color: colors.primary }]}>
                {copied ? t('logs_copied') : t('logs_copy')}
              </Text>
            </Pressable>

            <Pressable
              onPress={handleShare}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.actionBtn,
                { borderColor: colors.border, backgroundColor: colors.bgCard2 },
                pressed && styles.pressed,
              ]}
            >
              <Ionicons name="share-outline" size={15} color={colors.textSecondary} />
              <Text style={[type.captionMedium, { color: colors.textSecondary }]}>{t('logs_share')}</Text>
            </Pressable>
          </View>
        </Surface>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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

  filterRow: { flexDirection: 'row', gap: spacing.sm },
  filterChip: {
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

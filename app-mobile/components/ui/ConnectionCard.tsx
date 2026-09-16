/**
 * ConnectionCard — une connexion de la liste d'accueil.
 *
 * VOLONTAIREMENT SIMPLE. La version précédente empilait un fond teinté
 * translucide, un lavis dégradé et un halo coloré. Sur Android, l'ombre portée
 * d'une vue à fond translucide se voit À TRAVERS elle : chaque carte portait
 * donc un rectangle plus clair aux arêtes nettes en son milieu — l'aspect que
 * le propriétaire a refusé. Le fond est ici OPAQUE, sans ombre ni halo, et la
 * couleur ne sert plus qu'à ce qui porte du sens : l'état et la progression.
 *
 * Le VOLUME revient en détail — restant, consommé, total, et la barre — parce
 * que c'est ce qu'on vient lire ici : cette liste sert à comparer les forfaits
 * entre eux, ce qu'une seule ligne « restant / total » ne permettait plus.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import { formatBytes } from '@/services/quotaState';
import type { DerivedQuota } from '@/services/quotaState';
import type { VpnConnection } from '@/types/api';
import { alpha, layout, radius, spacing, type } from '@/constants/theme';
import { Pill, ProgressBar } from '@/components/ui/Primitives';

interface ConnectionCardProps {
  conn: VpnConnection;
  isActive: boolean;
  /** Quota dérivé du profil en cours : la source qui fait autorité. */
  activeQuota?: DerivedQuota;
}

/**
 * Une ligne « libellé … valeur ».
 *
 * Préférée aux tuiles côte à côte : trois colonnes sur un écran de 320 px ne
 * laissaient que ~66 px par valeur, et « 204.8 MB » y était tronqué. Une ligne
 * par volume se lit d'un coup d'œil et ne peut pas rogner le chiffre.
 */
function QuotaLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const colors = useColors();
  return (
    <View style={styles.quotaLine}>
      <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={1}>{label}</Text>
      <Text
        style={[type.bodyMedium, { color: tone || colors.textPrimary, fontVariant: ['tabular-nums'] }]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

export default function ConnectionCard({ conn, isActive, activeQuota }: ConnectionCardProps) {
  const now = Date.now();
  const isExpired = conn.status === 'expired' || (conn.expiresAt ? new Date(conn.expiresAt).getTime() < now : false);
  const isExhausted = conn.status === 'exhausted';
  const isRevoked = conn.status === 'revoked';
  const isSuspended = conn.status === 'suspended';

  // La connexion ACTIVE lit le quota dérivé — celui de la carte du haut, octets
  // mesurés et pas encore remontés compris. L'instantané distant de la liste
  // peut dater de la dernière synchronisation : deux chiffres différents pour
  // un même forfait sur un même écran se lisent comme une erreur de comptage.
  const remoteTotal = conn.quota.totalBytes || (conn.quota.totalGB * 1024 ** 3);
  const remoteUsed = conn.quota.usedBytes || (conn.quota.usedGB * 1024 ** 3);
  const courant = isActive ? activeQuota : undefined;
  const totalBytes = courant?.totalBytes ?? remoteTotal;
  const usedBytes = courant?.usedBytes ?? remoteUsed;
  const remainingBytes = courant
    ? courant.remainingBytes
    : conn.quota.totalBytes !== undefined ? Math.max(0, remoteTotal - remoteUsed) : (conn.quota.remainingGB * 1024 ** 3);

  const usedRatio = totalBytes > 0 ? Math.min(usedBytes / totalBytes, 1) : 0;
  const pct = Math.round(usedRatio * 100);

  const { t, language } = useTranslation();
  const colors = useColors();
  const statusColor = isExpired || isExhausted || isRevoked || isSuspended
    ? colors.accents.corail
    : isActive
      ? colors.accents.emeraude
      : colors.accents.cyan;
  const statusLabel = isExhausted ? t('friendly_quota_exhausted')
    : isExpired ? t('expired')
      : isRevoked ? t('connection_revoked')
        : isSuspended ? t('suspended_status')
          : t('active');

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.bgCard2,
          // Seule la connexion en cours porte une bordure colorée : elle se
          // repère alors sans lire les pastilles une par une.
          borderColor: isActive ? statusColor + alpha.f40 : colors.border,
        },
      ]}
    >
      <View style={styles.header}>
        {/* Deux lignes : « orange unlimited CM — 30j » était tronqué au point
            de ne plus distinguer deux forfaits d'un même opérateur. Le
            protocole reste masqué : il décrit la technique de transport que
            l'exploitant vend, et une capture d'écran suffirait à la révéler. */}
        <Text style={[type.h3, { color: colors.textPrimary, flex: 1 }]} numberOfLines={2}>
          {conn.name}
        </Text>
        <Pill label={statusLabel} tone={statusColor} dot />
      </View>

      {totalBytes > 0 ? (
        <>
          <View style={styles.quotaHead}>
            <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={1}>
              {t('quota_used_row')}
            </Text>
            <Text style={[type.captionMedium, { color: statusColor, fontVariant: ['tabular-nums'] }]}>
              {pct} %
            </Text>
          </View>

          <ProgressBar progress={usedRatio} tone={statusColor} warnTone={colors.disconnected} />

          <View style={styles.quotaLines}>
            <QuotaLine label={t('quota_remaining')} value={formatBytes(remainingBytes)} tone={colors.connected} />
            <QuotaLine label={t('quota_used')} value={formatBytes(usedBytes)} />
            <QuotaLine label={t('quota_total')} value={formatBytes(totalBytes)} />
          </View>
        </>
      ) : (
        // Un « 0 o » se lirait « rien consommé » : un volume que le serveur n'a
        // jamais communiqué est nommé comme tel.
        <Text style={[type.caption, { color: colors.textMuted }]}>{t('quota_not_measured')}</Text>
      )}

      {conn.expiresAt && (
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {t('expires_on')} {new Date(conn.expiresAt).toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'medium' })}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fond OPAQUE et sans ombre : une carte translucide posée sur une carte
  // laisse voir l'ombre portée à travers elle sur Android.
  card: {
    marginTop: spacing.md,
    padding: layout.cardPadding,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  quotaHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  quotaLines: { gap: spacing.sm },
  quotaLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
});

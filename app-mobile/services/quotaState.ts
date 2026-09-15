/**
 * quotaState.ts — Sélecteur unique de quota (B1)
 *
 * Source unique de vérité pour l'affichage et la dérivation du quota.
 * Combine le snapshot local/serveur persisté avec les compteurs de session
 * en direct pendant la connexion.
 */

import type { QuotaData } from './offlineStorage';

export interface DerivedQuota {
  totalBytes: number;
  usedBytes: number;
  remainingBytes: number;
  totalGb: number;
  usedGb: number;
  remainingGb: number;
  isExhausted: boolean;
  isExpired: boolean;
  expiryDate: string | null;
  formattedTotal: string;
  formattedUsed: string;
  formattedRemaining: string;
  usedRatio: number; // 0..1
}

export interface SessionCounters {
  sessionUp: number;
  sessionDown: number;
  sessionBaselineUp: number;
  sessionBaselineDown: number;
  /** Retard du livre durable, y compris après déconnexion/reconnexion. */
  pendingBytes?: number;
  /** Consommé du snapshot apparié au dernier acquittement de ce livre. */
  accountedUsedBytes?: number;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${parseFloat(val.toFixed(1))} ${sizes[i]}`;
}

export function deriveQuota(
  baseQuota: QuotaData | null | {
    totalQuota?: number;
    usedQuota?: number;
    quotaTotalBytes?: number;
    quotaUsedBytes?: number;
    totalBytes?: number;
    usedBytes?: number;
    totalGB?: number;
    usedGB?: number;
    quotaTotalGb?: number;
    quotaUsedGb?: number;
    quotaRemainingGb?: number;
    expiryDate?: string | null;
    expireAt?: string | null;
    expiresAt?: string | null;
  },
  sessionStats?: SessionCounters | null,
  isConnected?: boolean
): DerivedQuota {
  let totalBytes = 0;
  let baseUsedBytes = 0;
  let expiryDate: string | null = null;

  if (baseQuota) {
    if ('totalQuota' in baseQuota && baseQuota.totalQuota !== undefined) {
      totalBytes = baseQuota.totalQuota || 0;
      baseUsedBytes = baseQuota.usedQuota || 0;
      expiryDate = baseQuota.expiryDate ?? null;
    } else {
      const b = baseQuota as any;
      totalBytes = (
        b.quotaTotalBytes ?? b.totalBytes ??
        (b.quotaTotalGb != null ? Number(b.quotaTotalGb) * (1024 ** 3) :
          b.totalGB != null ? Number(b.totalGB) * (1024 ** 3) : 0)
      ) || 0;
      baseUsedBytes = (
        b.quotaUsedBytes ?? b.usedBytes ??
        (b.quotaUsedGb != null ? Number(b.quotaUsedGb) * (1024 ** 3) :
          b.usedGB != null ? Number(b.usedGB) * (1024 ** 3) : 0)
      ) || 0;
      expiryDate = b.expiryDate || b.expireAt || b.expiresAt || null;
    }
  }

  let sessionDelta = 0;
  if (sessionStats?.pendingBytes !== undefined) {
    const projected = (sessionStats.accountedUsedBytes ?? baseUsedBytes) + Math.max(0, sessionStats.pendingBytes);
    // Un snapshot de contrôle peut inclure un rapport dont la réponse est
    // encore en vol. Ne jamais lui additionner une seconde fois la même tête.
    sessionDelta = Math.max(0, projected - baseUsedBytes);
  } else if (isConnected && sessionStats) {
    const sessionCumul = Math.max(0, (sessionStats.sessionUp || 0) + (sessionStats.sessionDown || 0));
    const sessionBaseline = Math.max(0, (sessionStats.sessionBaselineUp || 0) + (sessionStats.sessionBaselineDown || 0));
    sessionDelta = Math.max(0, sessionCumul - sessionBaseline);
  }

  // Le dernier rapport peut dépasser le forfait avant son arrêt par le
  // serveur. Le consommé reste réel ; seuls le restant et la jauge sont bornés.
  const usedBytes = baseUsedBytes + sessionDelta;
  const remainingBytes = Math.max(0, totalBytes - usedBytes);

  const GB = 1024 ** 3;
  const isExpired = expiryDate ? new Date(expiryDate).getTime() < Date.now() : false;
  const isExhausted = totalBytes > 0 && remainingBytes <= 0 && !isExpired;

  return {
    totalBytes,
    usedBytes,
    remainingBytes,
    totalGb: totalBytes / GB,
    usedGb: usedBytes / GB,
    remainingGb: remainingBytes / GB,
    isExhausted,
    isExpired,
    expiryDate,
    formattedTotal: formatBytes(totalBytes),
    formattedUsed: formatBytes(usedBytes),
    formattedRemaining: formatBytes(remainingBytes),
    usedRatio: totalBytes > 0 ? Math.min(1, usedBytes / totalBytes) : 0,
  };
}

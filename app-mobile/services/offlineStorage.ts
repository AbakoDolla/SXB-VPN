/**
 * offlineStorage.ts — Stockage local sécurisé pour mode hors-ligne SXB VPN
 *
 * Gère :
 *   - Sauvegarde/restauration de la config VPN (AsyncStorage)
 *   - Compteur de quota local (utilisé si backend inaccessible)
 *   - Synchronisation backend quand internet revient
 *
 * Cycle de vie :
 *   Import config (avec internet)
 *     → validateVpnConfig()
 *     → saveVpnConfig()          ← stockage local chiffré (Keystore via SecureStore)
 *     → syncQuotaFromBackend()   ← récupère quota initial
 *   Déconnexion internet
 *     → loadVpnConfig()          ← config toujours dispo
 *     → consumeLocalQuota()      ← décompte local des bytes
 *   Reconnexion internet
 *     → syncQuotaFromBackend()   ← resynchronise le vrai compteur
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as configStore from './configStore';

// ── Clés de stockage ──────────────────────────────────────────────────────────

const KEYS = {
  VPN_CONFIG:   'sxb_offline_vpn_config_v2',
  QUOTA:        'sxb_offline_quota_v2',
  LAST_SYNC:    'sxb_offline_last_sync',
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuotaData {
  configId:       string;
  totalQuota:     number;   // bytes
  usedQuota:      number;   // bytes
  remainingQuota: number;   // bytes (calculé)
  expiryDate:     string | null;   // ISO date string ou null
  lastSync:       string;          // ISO date string
}

export interface OfflineConfig {
  config:     Record<string, any>;
  savedAt:    string;   // ISO date string
  protocol:   string;
  configId:   string;
  expiresAt?: string | null;  // ISO date string — null/absent = pas d'expiration
}

// ── Legacy adapter ─────────────────────────────────────────────────────────────
// Credentials now live exclusively in configStore (AES-256-GCM payload + SecureStore master key).

// ── Config VPN ───────────────────────────────────────────────────────────────

/**
 * Sauvegarde la configuration VPN localement (SecureStore / AsyncStorage).
 * Appeler après validation réussie par configValidator.
 * @param expiresAt  Date d'expiration de la config (ISO). null = pas d'expiration.
 */
export async function saveVpnConfig(config: Record<string, any>, protocol: string, configId?: string, expiresAt?: string | null): Promise<void> {
  const id = configId || config.configId || `local_${Date.now()}`;
  const saved = await configStore.save(String(id), config, { configId: String(id), protocol: protocol.toLowerCase(), expiryDate: expiresAt ?? null });
  if (saved.status !== 'ok') throw saved.error || new Error('Stockage chiffré indisponible');
  await AsyncStorage.setItem(KEYS.LAST_SYNC, new Date().toISOString());
}

/** Legacy-shaped active config for callers not yet migrated. */
export async function loadVpnConfig(): Promise<OfflineConfig | null> {
  const result = await configStore.getActive();
  if (result.status !== 'ok' || !result.value) return null;
  const { config, meta } = result.value;
  return { config, savedAt: meta.savedAt || '', protocol: meta.protocol || '', configId: meta.configId, expiresAt: meta.expiryDate || null };
}

export async function isOfflineConfigExpired(): Promise<boolean> {
  const cfg = await loadVpnConfig();
  return !!cfg?.expiresAt && new Date() > new Date(cfg.expiresAt);
}

export async function clearVpnConfig(): Promise<void> {
  const active = await configStore.getActive();
  if (active.status === 'ok' && active.value) await configStore.remove(active.value.meta.configId);
}

/**
 * Vérifie si une configuration est disponible en local.
 */
export async function hasOfflineConfig(): Promise<boolean> {
  const cfg = await loadVpnConfig();
  return cfg !== null;
}

// ── Quota ─────────────────────────────────────────────────────────────────────

/**
 * Sauvegarde les données de quota reçues depuis le backend.
 * À appeler à chaque synchronisation réussie.
 */
export async function saveQuotaData(data: Omit<QuotaData, 'lastSync' | 'remainingQuota'>): Promise<QuotaData> {
  const quota: QuotaData = {
    ...data,
    remainingQuota: Math.max(0, data.totalQuota - data.usedQuota),
    lastSync: new Date().toISOString(),
  };
  await AsyncStorage.setItem(`sxb_quota_${data.configId}`, JSON.stringify(quota));
  await configStore.updateQuota(data.configId, quota.usedQuota);
  return quota;
}

/**
 * Restaure les données de quota depuis le stockage local.
 */
export async function loadQuotaData(configId?: string): Promise<QuotaData | null> {
  try {
    const active = configId ? null : await configStore.getActive();
    const id = configId || (active?.status === 'ok' ? active.value?.meta.configId : undefined);
    if (!id) return null;
    const raw = await AsyncStorage.getItem(`sxb_quota_${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaData;
    // Recalculer remainingQuota au cas où usedQuota aurait été mis à jour localement
    parsed.remainingQuota = Math.max(0, parsed.totalQuota - parsed.usedQuota);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Consomme du quota localement (mode hors-ligne).
 * @param bytes — nombre de bytes consommés depuis la dernière mesure
 * @returns QuotaData mis à jour, ou null si aucun quota en local
 */
export async function consumeLocalQuota(bytes: number, configId?: string): Promise<QuotaData | null> {
  const quota = await loadQuotaData(configId);
  if (!quota) return null;

  quota.usedQuota      = Math.min(quota.totalQuota, quota.usedQuota + bytes);
  quota.remainingQuota = Math.max(0, quota.totalQuota - quota.usedQuota);
  // lastSync n'est PAS mis à jour ici — il indique la dernière sync backend

  await AsyncStorage.setItem(`sxb_quota_${quota.configId}`, JSON.stringify(quota));
  await configStore.updateQuota(quota.configId, quota.usedQuota);
  return quota;
}

/**
 * Alias export pour la persistance locale à la déconnexion (B2).
 */
export const consumeQuotaLocally = consumeLocalQuota;

/**
 * Vérifie si le quota est épuisé.
 * Retourne true si aucun quota n'est enregistré (pas de blocage par défaut).
 */
export async function isQuotaExhausted(): Promise<boolean> {
  const quota = await loadQuotaData();
  if (!quota) return false;  // Pas de quota local → on laisse passer
  return quota.remainingQuota <= 0;
}

/**
 * Vérifie si la config est expirée selon la date locale.
 */
export async function isConfigExpired(): Promise<boolean> {
  const quota = await loadQuotaData();
  if (!quota?.expiryDate) return false;
  return new Date() > new Date(quota.expiryDate);
}

/**
 * Résumé de l'état offline à afficher dans l'UI.
 */
export async function getOfflineStatus(): Promise<{
  hasConfig:   boolean;
  quota:       QuotaData | null;
  isExpired:   boolean;
  isExhausted: boolean;
  lastSync:    string | null;
  canConnect:  boolean;
}> {
  const [hasConfig, quota, isExpired, isExhausted, lastSync] = await Promise.all([
    hasOfflineConfig(),
    loadQuotaData(),
    isConfigExpired(),
    isQuotaExhausted(),
    AsyncStorage.getItem(KEYS.LAST_SYNC),
  ]);

  return {
    hasConfig,
    quota,
    isExpired,
    isExhausted,
    lastSync,
    canConnect: hasConfig && !isExpired && !isExhausted,
  };
}

/**
 * Supprime toutes les données offline (désinscription complète).
 */
export async function clearAllOfflineData(): Promise<void> {
  await Promise.all([
    clearVpnConfig(),
    // Quotas are per-config and are removed with their config payload,
    AsyncStorage.removeItem(KEYS.LAST_SYNC),
  ]);
}

// ── Synchronisation backend ───────────────────────────────────────────────────

/**
 * Synchronise le quota depuis le backend quand internet est disponible.
 * @param fetcher — fonction qui appelle le backend et retourne les données brutes
 */
export async function syncQuotaFromBackend(
  fetcher: () => Promise<{
    configId:    string;
    totalQuota:  number;
    usedQuota:   number;
    expiryDate:  string | null;
  }>,
): Promise<QuotaData | null> {
  try {
    const data = await fetcher();
    const quota = await saveQuotaData(data);
    await AsyncStorage.setItem(KEYS.LAST_SYNC, new Date().toISOString());
    return quota;
  } catch {
    // Pas d'internet ou backend inaccessible → quota local conservé
    return loadQuotaData();
  }
}

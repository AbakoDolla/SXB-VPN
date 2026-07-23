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
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

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
}

// ── Helpers SecureStore / AsyncStorage ───────────────────────────────────────

async function secureWrite(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS !== 'web') {
      await SecureStore.setItemAsync(key, value);
    } else {
      await AsyncStorage.setItem(`@secure_${key}`, value);
    }
  } catch {
    // Fallback AsyncStorage si SecureStore indisponible (émulateur, etc.)
    await AsyncStorage.setItem(`@secure_${key}`, value);
  }
}

async function secureRead(key: string): Promise<string | null> {
  try {
    if (Platform.OS !== 'web') {
      const val = await SecureStore.getItemAsync(key);
      if (val !== null) return val;
    }
    // Fallback AsyncStorage (migration legacy ou web)
    return await AsyncStorage.getItem(`@secure_${key}`);
  } catch {
    return null;
  }
}

async function secureDelete(key: string): Promise<void> {
  try {
    if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(key);
  } catch { /* ignore */ }
  try {
    await AsyncStorage.removeItem(`@secure_${key}`);
  } catch { /* ignore */ }
}

// ── Config VPN ───────────────────────────────────────────────────────────────

/**
 * Sauvegarde la configuration VPN localement (SecureStore / AsyncStorage).
 * Appeler après validation réussie par configValidator.
 */
export async function saveVpnConfig(
  config: Record<string, any>,
  protocol: string,
  configId?: string,
): Promise<void> {
  const entry: OfflineConfig = {
    config,
    savedAt:  new Date().toISOString(),
    protocol: protocol.toLowerCase(),
    configId: configId ?? `local_${Date.now()}`,
  };
  await secureWrite(KEYS.VPN_CONFIG, JSON.stringify(entry));
  // Mettre à jour lastSync
  await AsyncStorage.setItem(KEYS.LAST_SYNC, new Date().toISOString());
}

/**
 * Restaure la configuration VPN depuis le stockage local.
 * Retourne null si aucune config n'a été sauvegardée.
 */
export async function loadVpnConfig(): Promise<OfflineConfig | null> {
  try {
    const raw = await secureRead(KEYS.VPN_CONFIG);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OfflineConfig;
    // Vérification minimale de structure
    if (!parsed.config || !parsed.protocol) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Supprime la configuration VPN du stockage local.
 * Appeler à la désinscription ou réinitialisation.
 */
export async function clearVpnConfig(): Promise<void> {
  await secureDelete(KEYS.VPN_CONFIG);
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
  await AsyncStorage.setItem(KEYS.QUOTA, JSON.stringify(quota));
  return quota;
}

/**
 * Restaure les données de quota depuis le stockage local.
 */
export async function loadQuotaData(): Promise<QuotaData | null> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.QUOTA);
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
export async function consumeLocalQuota(bytes: number): Promise<QuotaData | null> {
  const quota = await loadQuotaData();
  if (!quota) return null;

  quota.usedQuota      = Math.min(quota.totalQuota, quota.usedQuota + bytes);
  quota.remainingQuota = Math.max(0, quota.totalQuota - quota.usedQuota);
  // lastSync n'est PAS mis à jour ici — il indique la dernière sync backend

  await AsyncStorage.setItem(KEYS.QUOTA, JSON.stringify(quota));
  return quota;
}

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
    AsyncStorage.removeItem(KEYS.QUOTA),
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

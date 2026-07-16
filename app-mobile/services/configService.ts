/**
 * configService.ts
 *
 * Import de configuration VPN depuis le backend via un token de configuration.
 * Le token de config (SXB-CFG-...) est distinct du token utilisateur (SXB-USER-...).
 * La config reçue est immédiatement chiffrée et stockée.
 */

import apiClient from '@/services/apiClient';
import { saveSecureConfig, loadSecureConfig, clearSecureConfig, type SecureConfigPayload } from '@/services/secureConfig';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CONFIG_TOKEN_KEY = '@sxb_config_token_ref';

export interface ImportConfigResult {
  config: SecureConfigPayload;
  message?: string;
}

/**
 * Importe une configuration VPN depuis le backend en échangeant un token de config.
 * La configuration reçue est chiffrée et stockée localement.
 *
 * @param configToken  - Token de configuration (ex: SXB-CFG-XXXX-XXXX)
 * @param accessToken  - Token d'accès de l'utilisateur (utilisé comme clé de chiffrement)
 */
export async function importConfig(
  configToken: string,
  accessToken: string,
): Promise<ImportConfigResult> {
  const res = await apiClient.post('/mobile/config/import', {
    configToken: configToken.trim(),
  });

  const raw = res.data;

  const config: SecureConfigPayload = {
    subscriptionUrl: raw.subscriptionUrl ?? raw.subscription_url ?? undefined,
    protocols: raw.protocols ?? undefined,
    serverInfo: raw.serverInfo ?? raw.server_info ?? undefined,
    importedAt: new Date().toISOString(),
    raw: raw.raw ?? raw.link ?? undefined,
    ...raw,
  };

  await saveSecureConfig(accessToken, config);
  // Stocker une référence non-sensible du token (les 8 premiers caractères seulement)
  const tokenRef = configToken.trim().substring(0, 12) + '...';
  await AsyncStorage.setItem(CONFIG_TOKEN_KEY, tokenRef);

  return { config, message: raw.message };
}

/**
 * Charge la config chiffrée stockée localement.
 * Renvoie null si absente ou si le token est invalide.
 */
export async function getStoredConfig(
  accessToken: string,
): Promise<SecureConfigPayload | null> {
  return loadSecureConfig(accessToken);
}

/**
 * Supprime la configuration stockée (ex : logout).
 */
export async function clearStoredConfig(): Promise<void> {
  await clearSecureConfig();
  await AsyncStorage.removeItem(CONFIG_TOKEN_KEY).catch(() => {});
}

/**
 * Retourne la référence (partielle) du dernier token de config utilisé.
 */
export async function getConfigTokenRef(): Promise<string | null> {
  return AsyncStorage.getItem(CONFIG_TOKEN_KEY).catch(() => null);
}

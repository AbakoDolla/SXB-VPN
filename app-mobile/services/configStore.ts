import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { encryptAes256Gcm, decryptAes256Gcm, hexToBytes, bytesToHex, utf8Decode, utf8Encode } from './aesGcm';
import { genererLeurre, semerAppats } from './decoy';
import { requireProfileAccess } from './accessState';
import { reprendLeProfilActif } from './activeProfile';
import type { ProfileStatus } from './accessPolicy';

/** The only owner of locally provisioned VPN credentials. Registry is deliberately non-sensitive. */
const REGISTRY_KEY = 'sxb_cfg_registry_v1';
const MASTER_KEY = 'sxb_cfg_master_key_v1';
const payloadKey = (id: string) => `sxb_cfg_payload_${id}`;
const LEGACY_CONFIG = 'sxb_offline_vpn_config_v2';
const LEGACY_PROV = 'sxb_prov_config_v2';
const LEGACY_META = 'sxb_prov_meta_v2';
export type StoreStatus = 'ok' | 'missing' | 'error';
export type StoreResult<T> = { status: StoreStatus; value?: T; error?: Error };
export interface ConfigMeta {
  configId: string; name?: string; protocol?: string; displayProtocol?: string; subscriptionId?: string;
  quotaTotal?: number; quotaUsed?: number; expiryDate?: string | null; configVersion?: number;
  configHash?: string | null; isActive?: boolean; savedAt?: string; dataToken?: string;
  source?: 'backend' | 'manual'; accessStatus?: ProfileStatus;
  /**
   * Accès issu d'un ESSAI GRATUIT, recopié depuis `/mobile/connections`.
   *
   * Le serveur seul décide : il le calcule à partir de la demande d'essai
   * DÉPLOYÉE qui porte ce forfait. On le conserve ici pour que l'écran
   * d'accueil sache ce qu'il présente même hors ligne — jamais pour le déduire
   * localement du nom du forfait.
   */
  isFreeTrial?: boolean;
}
export interface StoredConfig { config: Record<string, any>; meta: ConfigMeta; }

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let last: any;
  for (let i = 0; i < 3; i++) { try { return await fn(); } catch (e) { last = e; if (i < 2) await delay(200 * (i + 1)); } }
  throw last;
}
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  // Hermes n’expose pas systématiquement globalThis.crypto. Expo Crypto est
  // fourni par Android/iOS et remplit le tableau avec un aléa cryptographiquement sûr.
  Crypto.getRandomValues(out);
  return out;
}
function encode(s: string) { return utf8Encode(s); }
async function masterKey(): Promise<Uint8Array> {
  const read = async () => Platform.OS === 'web' ? AsyncStorage.getItem(`@secure_${MASTER_KEY}`) : SecureStore.getItemAsync(MASTER_KEY);
  let key = await retry(read);
  if (!key) {
    key = bytesToHex(randomBytes(32));
    await retry(() => Platform.OS === 'web' ? AsyncStorage.setItem(`@secure_${MASTER_KEY}`, key!) : SecureStore.setItemAsync(MASTER_KEY, key!));
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Clé de stockage invalide');
  return hexToBytes(key);
}
function encrypt(value: Record<string, any>, key: Uint8Array) {
  const iv = randomBytes(12); const result = encryptAes256Gcm(key, iv, encode(JSON.stringify(value)));
  return `gcm:${bytesToHex(iv)}:${bytesToHex(result.ciphertext)}:${bytesToHex(result.authTag)}`;
}
/**
 * Déchiffre un payload, ou rend un leurre.
 *
 * Une clé fausse, un payload tronqué ou une étiquette d'authentification
 * retouchée produisent une configuration crédible mais fausse, au lieu d'une
 * exception. L'attaquant qui teste des clés au hasard ne dispose donc d'aucun
 * signal lui indiquant quand il a trouvé la bonne : tout « fonctionne ».
 *
 * Le leurre est marqué en mémoire ; `estLeurre()` le reconnaît et le chemin de
 * connexion le refuse, ce qui garantit qu'un utilisateur légitime dont le
 * stockage serait corrompu ne se connecte jamais à un serveur inventé.
 */
function decrypt(value: string, key: Uint8Array, graine = ''): Record<string, any> {
  try {
    const [prefix, iv, cipher, tag] = value.split(':');
    if (prefix !== 'gcm' || !iv || !cipher || !tag) return genererLeurre(graine || value.slice(0, 32));
    const clair = utf8Decode(decryptAes256Gcm(key, hexToBytes(iv), hexToBytes(cipher), hexToBytes(tag)));
    return JSON.parse(clair);
  } catch {
    return genererLeurre(graine || value.slice(0, 32));
  }
}
async function registry(): Promise<ConfigMeta[]> { const raw = await AsyncStorage.getItem(REGISTRY_KEY); return raw ? JSON.parse(raw) : []; }
async function putRegistry(entries: ConfigMeta[]) { await AsyncStorage.setItem(REGISTRY_KEY, JSON.stringify(entries)); }
let mutations: Promise<unknown> = Promise.resolve();
function mutate<T>(action: () => Promise<T>): Promise<T> {
  const next = mutations.then(action);
  mutations = next.catch(() => { /* Each public operation returns its own StoreResult error. */ });
  return next;
}

// ── Suppressions locales (« pierres tombales ») ──────────────────────────────
// Une configuration supprimée depuis l'application doit le RESTER. Sans trace
// persistante, le rafraîchissement suivant la reprovisionnait depuis
// /mobile/connections et elle réapparaissait aussitôt dans la liste.
// L'abonnement reste intact côté dashboard : la suppression est volontairement
// limitée à cet appareil, et une réactivation explicite du jeton la relève.
const DISMISSED_KEY = 'sxb_cfg_dismissed_v1';

async function dismissedIds(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(DISMISSED_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string' && x) : [];
  } catch { return []; }
}

export async function listDismissed(): Promise<StoreResult<string[]>> {
  try { return { status: 'ok', value: await dismissedIds() }; }
  catch (error: any) { return { status: 'error', error }; }
}

/** Marque une configuration comme supprimée sur cet appareil. */
export async function dismiss(id: string): Promise<StoreResult<void>> {
  try {
    await mutate(async () => {
      const ids = await dismissedIds();
      if (!ids.includes(id)) await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids, id]));
    });
    return { status: 'ok' };
  } catch (error: any) { return { status: 'error', error }; }
}

/** Lève la suppression — réactivation explicite du jeton par l'utilisateur. */
export async function restore(id: string): Promise<StoreResult<void>> {
  try {
    await mutate(async () => {
      requireProfileAccess({ configId: id });
      const ids = await dismissedIds();
      if (ids.includes(id)) await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.filter(x => x !== id)));
    });
    return { status: 'ok' };
  } catch (error: any) { return { status: 'error', error }; }
}

export async function migrateLegacy(): Promise<StoreResult<void>> {
  try {
    if ((await registry()).length) return { status: 'ok' };
    const [legacyOfflineAsync, legacyOfflineSecure, legacyMeta, legacyConfig] = await Promise.all([AsyncStorage.getItem(LEGACY_CONFIG), Platform.OS === 'web' ? AsyncStorage.getItem(`@secure_${LEGACY_CONFIG}`) : SecureStore.getItemAsync(LEGACY_CONFIG), AsyncStorage.getItem(LEGACY_META), Platform.OS === 'web' ? AsyncStorage.getItem(`@secure_${LEGACY_PROV}`) : SecureStore.getItemAsync(LEGACY_PROV)]);
    const legacyOffline = legacyOfflineAsync || legacyOfflineSecure;
    let config: any; let meta: any = {};
    if (legacyOffline) { const parsed = JSON.parse(legacyOffline); config = parsed.config; meta = { configId: parsed.configId, protocol: parsed.protocol, expiryDate: parsed.expiresAt, savedAt: parsed.savedAt }; }
    else if (legacyConfig && legacyMeta) { config = JSON.parse(legacyConfig); const m = JSON.parse(legacyMeta); meta = { configId: m.subscriptionId, name: m.profileName, protocol: m.protocol, displayProtocol: m.displayProtocol, subscriptionId: m.subscriptionId, quotaTotal: Math.round((m.quotaGB || 0) * 1024 ** 3), quotaUsed: Math.round((m.quotaUsedGB || 0) * 1024 ** 3), expiryDate: m.expireAt, configVersion: m.configVersion, configHash: m.configHash, savedAt: m.provisionedAt }; }
    if (config) await save(String(meta.configId || config.configId || `legacy_${Date.now()}`), config, meta);
    if (config) await Promise.all([AsyncStorage.removeItem(LEGACY_CONFIG), AsyncStorage.removeItem(LEGACY_META), Platform.OS === 'web' ? AsyncStorage.removeItem(`@secure_${LEGACY_PROV}`) : SecureStore.deleteItemAsync(LEGACY_PROV), Platform.OS === 'web' ? AsyncStorage.removeItem(`@secure_${LEGACY_CONFIG}`) : SecureStore.deleteItemAsync(LEGACY_CONFIG)]);
    return { status: 'ok' };
  } catch (error: any) { return { status: 'error', error }; }
}
export async function save(id: string, config: Record<string, any>, meta: Partial<ConfigMeta> = {}): Promise<StoreResult<StoredConfig>> {
  try { return await mutate(async () => {
    const key = await masterKey();
    const entries = await registry();
    // Equal payload hashes are not equal entitlements: A and B can share a server.
    const old = entries.find(x => x.configId === id);
    const autres = entries.filter(x => x.configId !== id);
    const candidat: ConfigMeta = { ...old, ...meta, configId: id,
      source: meta.source ?? old?.source ?? (meta.subscriptionId ? 'backend' : 'manual') };
    // Une configuration qui vient d'arriver ne vole jamais la place d'une
    // active encore utilisable ; elle la prend quand celle-ci est terminée —
    // typiquement l'essai gratuit expiré doublé d'un forfait ordinaire.
    const finalMeta: ConfigMeta = { ...candidat,
      isActive: meta.isActive ?? (old?.isActive === true ? true : reprendLeProfilActif(autres, candidat)),
      savedAt: new Date().toISOString() };
    requireProfileAccess({ ...finalMeta,
      subscriptionId: finalMeta.subscriptionId || (typeof config.subscriptionId === 'string' ? config.subscriptionId : undefined),
      configHash: finalMeta.configHash || (typeof config.configHash === 'string' ? config.configHash : undefined),
    });
    await AsyncStorage.setItem(payloadKey(id), encrypt(config, key));
    // Un seul profil actif à la fois : sans ce déclassement, `getActive()`
    // rendrait la première entrée marquée active, c'est-à-dire l'ancienne.
    await putRegistry([...(finalMeta.isActive ? autres.map(x => ({ ...x, isActive: false })) : autres), finalMeta]);
    if (finalMeta.isActive) await AsyncStorage.setItem('@sxb_active_config_id', id);
    // Les appâts sont semés en même temps que la première vraie configuration :
    // un stockage qui ne contiendrait QUE des appâts se remarquerait.
    await semerAppats();
    return { status: 'ok' as const, value: { config, meta: finalMeta } };
  }); } catch (error: any) { return { status: 'error', error }; }
}
export async function get(id: string): Promise<StoreResult<StoredConfig>> { try { await migrateLegacy(); const meta = (await registry()).find(x => x.configId === id); if (!meta) return { status: 'missing' }; const raw = await AsyncStorage.getItem(payloadKey(id)); if (!raw) return { status: 'error', error: new Error('Payload absent') }; return { status: 'ok', value: { config: decrypt(raw, await masterKey(), id), meta } }; } catch (error:any) { return { status:'error', error }; } }
export async function getActive(): Promise<StoreResult<StoredConfig>> { const migration = await migrateLegacy(); if (migration.status === 'error') return migration as StoreResult<StoredConfig>; try { const entries = await registry(); const active = entries.find(x => x.isActive) || entries[0]; return active ? get(active.configId) : { status: 'missing' }; } catch (error: any) { return { status: 'error', error }; } }
export async function list(): Promise<StoreResult<ConfigMeta[]>> { try { await migrateLegacy(); return { status:'ok', value: await registry() }; } catch(error:any) { return {status:'error', error}; } }
export async function setActive(id: string): Promise<StoreResult<void>> {
  try { return await mutate(async () => {
    const entries = await registry();
    if (!entries.some(x => x.configId === id)) return { status: 'missing' as const };
    await putRegistry(entries.map(x => ({ ...x, isActive: x.configId === id })));
    await AsyncStorage.setItem('@sxb_active_config_id', id);
    return { status: 'ok' as const };
  }); } catch (error: any) { return { status: 'error', error }; }
}
export async function remove(id: string): Promise<StoreResult<void>> {
  try { return await mutate(async () => {
    const entries = await registry();
    const remaining = entries.filter(x => x.configId !== id);
    if (remaining.length && !remaining.some(x => x.isActive)) remaining[0] = { ...remaining[0], isActive: true };
    await AsyncStorage.multiRemove([payloadKey(id), `sxb_quota_${id}`]);
    await putRegistry(remaining);
    const active = remaining.find(x => x.isActive);
    if (active) await AsyncStorage.setItem('@sxb_active_config_id', active.configId);
    else await AsyncStorage.removeItem('@sxb_active_config_id');
    return { status: 'ok' as const };
  }); } catch (error: any) { return { status: 'error', error }; }
}
/** Purge tous les payloads chiffrés et le registre après suppression/révocation. */
export async function clearAll(): Promise<StoreResult<void>> {
  try { return await mutate(async () => {
    const entries = await registry();
    await Promise.all(entries.map(entry => AsyncStorage.removeItem(payloadKey(entry.configId))));
    await putRegistry([]);
    await AsyncStorage.removeItem('@sxb_active_config_id');
    // Réinitialisation complète (déconnexion/révocation) : les pierres tombales
    // n'ont plus d'objet, sinon un profil resterait invisible après un nouvel
    // enrôlement de l'appareil.
    await AsyncStorage.removeItem(DISMISSED_KEY);
    await Promise.all([
      AsyncStorage.removeItem(LEGACY_CONFIG),
      AsyncStorage.removeItem(LEGACY_META),
      AsyncStorage.removeItem(LEGACY_PROV),
      Platform.OS === 'web' ? AsyncStorage.removeItem(`@secure_${LEGACY_CONFIG}`) : SecureStore.deleteItemAsync(LEGACY_CONFIG),
      Platform.OS === 'web' ? AsyncStorage.removeItem(`@secure_${LEGACY_PROV}`) : SecureStore.deleteItemAsync(LEGACY_PROV),
    ]);
    return { status: 'ok' as const };
  });
  } catch (error: any) { return { status: 'error', error }; }
}

export async function updateMetadata(id: string, update: Partial<Pick<ConfigMeta,
  'name' | 'quotaTotal' | 'quotaUsed' | 'expiryDate' | 'accessStatus' | 'isFreeTrial'>>): Promise<StoreResult<ConfigMeta>> {
  try { return await mutate(async () => {
    const entries = await registry();
    const old = entries.find(x => x.configId === id);
    if (!old) return { status: 'missing' as const };
    const meta = { ...old, ...update };
    await putRegistry(entries.map(x => x.configId === id ? meta : x));
    return { status: 'ok' as const, value: meta };
  }); } catch (error: any) { return { status: 'error', error }; }
}

export const updateQuota = (id: string, usedBytes: number) => updateMetadata(id, { quotaUsed: Math.max(0, usedBytes) });

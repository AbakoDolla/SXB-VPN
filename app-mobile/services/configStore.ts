import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { encryptAes256Gcm, decryptAes256Gcm, hexToBytes, bytesToHex, utf8Decode, utf8Encode } from './aesGcm';

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
function decrypt(value: string, key: Uint8Array): Record<string, any> {
  const [prefix, iv, cipher, tag] = value.split(':');
  if (prefix !== 'gcm' || !iv || !cipher || !tag) throw new Error('Payload chiffré invalide');
  return JSON.parse(utf8Decode(decryptAes256Gcm(key, hexToBytes(iv), hexToBytes(cipher), hexToBytes(tag))));
}
async function registry(): Promise<ConfigMeta[]> { const raw = await AsyncStorage.getItem(REGISTRY_KEY); return raw ? JSON.parse(raw) : []; }
async function putRegistry(entries: ConfigMeta[]) { await AsyncStorage.setItem(REGISTRY_KEY, JSON.stringify(entries)); }

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
    const ids = await dismissedIds();
    if (!ids.includes(id)) await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids, id]));
    return { status: 'ok' };
  } catch (error: any) { return { status: 'error', error }; }
}

/** Lève la suppression — réactivation explicite du jeton par l'utilisateur. */
export async function restore(id: string): Promise<StoreResult<void>> {
  try {
    const ids = await dismissedIds();
    if (ids.includes(id)) await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.filter(x => x !== id)));
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
  try { const key = await masterKey(); const entries = await registry(); const old = entries.find(x => x.configId === id || (!!meta.configHash && x.configHash === meta.configHash)); const finalId = old?.configId || id; const finalMeta: ConfigMeta = { ...old, ...meta, configId: finalId, isActive: meta.isActive ?? old?.isActive ?? entries.length === 0, savedAt: new Date().toISOString() }; await AsyncStorage.setItem(payloadKey(finalId), encrypt(config, key)); await putRegistry([...entries.filter(x => x.configId !== finalId), finalMeta]); return { status: 'ok', value: { config, meta: finalMeta } }; } catch (error: any) { return { status: 'error', error }; }
}
export async function get(id: string): Promise<StoreResult<StoredConfig>> { try { await migrateLegacy(); const meta = (await registry()).find(x => x.configId === id); if (!meta) return { status: 'missing' }; const raw = await AsyncStorage.getItem(payloadKey(id)); if (!raw) return { status: 'error', error: new Error('Payload absent') }; return { status: 'ok', value: { config: decrypt(raw, await masterKey()), meta } }; } catch (error:any) { return { status:'error', error }; } }
export async function getActive(): Promise<StoreResult<StoredConfig>> { const migration = await migrateLegacy(); if (migration.status === 'error') return migration as StoreResult<StoredConfig>; try { const entries = await registry(); const active = entries.find(x => x.isActive) || entries[0]; return active ? get(active.configId) : { status: 'missing' }; } catch (error: any) { return { status: 'error', error }; } }
export async function list(): Promise<StoreResult<ConfigMeta[]>> { try { await migrateLegacy(); return { status:'ok', value: await registry() }; } catch(error:any) { return {status:'error', error}; } }
export async function setActive(id: string): Promise<StoreResult<void>> { try { const entries=await registry(); if (!entries.some(x=>x.configId===id)) return {status:'missing'}; await putRegistry(entries.map(x=>({...x,isActive:x.configId===id}))); await AsyncStorage.setItem('@sxb_active_config_id', id); return {status:'ok'}; } catch(error:any) { return {status:'error',error}; } }
export async function remove(id: string): Promise<StoreResult<void>> { try { const entries=await registry(); await AsyncStorage.removeItem(payloadKey(id)); await putRegistry(entries.filter(x=>x.configId!==id)); return {status:'ok'}; } catch(error:any) {return {status:'error',error};} }
/** Purge tous les payloads chiffrés et le registre après suppression/révocation. */
export async function clearAll(): Promise<StoreResult<void>> {
  try {
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
    return { status: 'ok' };
  } catch (error: any) { return { status: 'error', error }; }
}

export async function updateQuota(id:string, usedBytes:number):Promise<StoreResult<ConfigMeta>> { try { const entries=await registry(); const old=entries.find(x=>x.configId===id); if(!old)return {status:'missing'}; const meta={...old,quotaUsed:Math.max(0,usedBytes)}; await putRegistry(entries.map(x=>x.configId===id?meta:x)); return {status:'ok',value:meta}; }catch(error:any){return {status:'error',error};} }

/**
 * Retire les configurations dont la date limite est dépassée.
 *
 * Le forfait défini au dashboard doit fonctionner jusqu'à son échéance, puis la
 * configuration doit disparaître de l'appareil — sans jamais désactiver
 * l'application, qui reste enrôlée et prête à recevoir un nouveau forfait.
 *
 * La purge est locale et n'appelle aucun service : elle fonctionne donc aussi
 * hors ligne, y compris si l'appareil n'a plus de données pour joindre le
 * dashboard. Retourne les configurations retirées afin que l'appelant puisse
 * l'annoncer à l'utilisateur.
 */
export async function purgeExpired(now: Date = new Date()): Promise<StoreResult<ConfigMeta[]>> {
  try {
    const entries = await registry();
    const expired = entries.filter(entry => {
      if (!entry.expiryDate) return false;
      const deadline = new Date(entry.expiryDate);
      // Une date illisible ne doit jamais provoquer une suppression.
      return !Number.isNaN(deadline.getTime()) && now > deadline;
    });
    if (expired.length === 0) return { status: 'ok', value: [] };

    await Promise.all(expired.map(entry => AsyncStorage.removeItem(payloadKey(entry.configId))));
    const remaining = entries.filter(entry => !expired.some(e => e.configId === entry.configId));
    // Si la configuration active vient d'expirer, une autre prend le relais :
    // sans cela le sélecteur resterait sur une entrée devenue introuvable.
    if (remaining.length > 0 && !remaining.some(entry => entry.isActive)) {
      remaining[0] = { ...remaining[0], isActive: true };
      await AsyncStorage.setItem('@sxb_active_config_id', remaining[0].configId);
    }
    if (remaining.length === 0) await AsyncStorage.removeItem('@sxb_active_config_id');
    await putRegistry(remaining);
    return { status: 'ok', value: expired };
  } catch (error: any) { return { status: 'error', error }; }
}

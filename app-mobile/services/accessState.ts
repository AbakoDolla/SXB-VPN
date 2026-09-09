import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AccessDeniedError, accessNotices, blocksDevice, deviceAccess, isRecord, parseAccessIssue,
  parseAccessSnapshot, profileIssue, profileRestriction, reduceIssue, reduceSnapshot,
  type AccessAuthority, type AccessIssue, type AccessNotice, type AccessSnapshot, type ProfileIdentity,
} from './accessPolicy';
import { advanceAccessRevision, advanceAccessSession } from './accessEvents';
import { nativeAccess, stopNativeAccessSession, type NativeAccessRuntime } from './nativeAccess';
import { requireVpnConsent } from './privacyConsent';

const STORAGE_KEY = '@sxb_access_authority_v1';
interface AccessState {
  ready: boolean;
  authority: AccessAuthority | null;
  notices: AccessNotice[];
  native: NativeAccessRuntime | null;
}
let state: AccessState = { ready: false, authority: null, notices: [], native: null };
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
export const getAccessState = () => state;
export const subscribeAccessState = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function publish(next: AccessState) { state = next; listeners.forEach(listener => listener()); }
function serial<T>(action: () => Promise<T>): Promise<T> {
  const next = writes.then(action);
  writes = next.catch(() => { /* The caller receives the error; later writes can retry. */ });
  return next;
}

export function parseAuthority(value: unknown): AccessAuthority {
  if (!isRecord(value) || typeof value.userId !== 'string' || !value.userId ||
      typeof value.deviceId !== 'string' || !value.deviceId || typeof value.session !== 'string' ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 ||
      !Array.isArray(value.restrictions)) throw new Error('ACCESS_CACHE_INVALID');
  const snapshot = value.snapshot === null ? null : parseAccessSnapshot(value.snapshot);
  const deviceIssue = value.deviceIssue === null ? null : parseAccessIssue(value.deviceIssue);
  if (value.deviceIssue !== null && deviceIssue?.scope !== 'device') throw new Error('ACCESS_CACHE_INVALID');
  const restrictions = value.restrictions.map(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id ||
        !['suspended', 'revoked', 'deleted'].includes(String(item.status)) ||
        !Array.isArray(item.hashes) || !item.hashes.every(hash => typeof hash === 'string') ||
        typeof item.name !== 'string') throw new Error('ACCESS_CACHE_INVALID');
    return { id: item.id, status: item.status as 'suspended' | 'revoked' | 'deleted', hashes: item.hashes as string[], name: item.name };
  });
  return { userId: value.userId, deviceId: value.deviceId, session: value.session,
    sequence: Number(value.sequence), snapshot, deviceIssue, restrictions };
}

function parseRuntime(raw: string): NativeAccessRuntime {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || typeof value.observing !== 'boolean' ||
      !['missing', 'ready', 'expired', 'invalid', 'unsupported', 'backoff'].includes(String(value.ticketStatus))) throw new Error('ACCESS_NATIVE_INVALID');
  return { authority: value.authority === null ? null : parseAuthority(value.authority),
    observing: value.observing, ticketStatus: value.ticketStatus as NativeAccessRuntime['ticketStatus'],
    ticketExpiresAt: typeof value.ticketExpiresAt === 'string' ? value.ticketExpiresAt : null,
    activeProfile: isRecord(value.activeProfile) && typeof value.activeProfile.configId === 'string' ? {
      configId: value.activeProfile.configId,
      subscriptionId: typeof value.activeProfile.subscriptionId === 'string' ? value.activeProfile.subscriptionId : undefined,
      configHash: typeof value.activeProfile.configHash === 'string' ? value.activeProfile.configHash : undefined,
      source: value.activeProfile.source === 'backend' ? 'backend' : 'manual',
    } : null,
  };
}

async function adopt(authority: AccessAuthority, runtime = state.native): Promise<void> {
  const previous = state.authority;
  if (previous && (previous.userId !== authority.userId || previous.deviceId !== authority.deviceId ||
      previous.session !== authority.session || previous.sequence > authority.sequence)) return;
  const changed = !previous || previous.sequence !== authority.sequence;
  const notices = changed ? [...state.notices, ...accessNotices(previous, authority)].slice(-12) : state.notices;
  if (changed) advanceAccessRevision();
  // Publish the barrier before any asynchronous disk operation or payload purge.
  publish({ ready: true, authority, notices, native: runtime });
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ authority, notices }));
}

export async function bindAccessState(userId: string, deviceId: string): Promise<void> {
  requireVpnConsent();
  return serial(async () => {
    if (state.ready && state.authority?.userId === userId && state.authority.deviceId === deviceId) return;
    const cached = await AsyncStorage.getItem(STORAGE_KEY);
    let authority: AccessAuthority | null = null;
    let notices: AccessNotice[] = [];
    if (cached) {
      const value: unknown = JSON.parse(cached);
      if (!isRecord(value)) throw new Error('ACCESS_CACHE_INVALID');
      const restored = parseAuthority(value.authority);
      if (restored.userId === userId && restored.deviceId === deviceId) {
        authority = restored;
        if (Array.isArray(value.notices)) notices = value.notices.filter((item): item is AccessNotice =>
          isRecord(item) && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.name === 'string');
      }
    }
    const native = nativeAccess();
    const runtime = native ? parseRuntime(await native.bindAccessSession(userId, deviceId)) : null;
    requireVpnConsent();
    // Native owns the durable ordering while installed; React never orders opaque revisions by serverTime.
    const cachedAuthority = authority;
    authority = runtime?.authority ?? authority ?? {
      userId, deviceId, session: `${Date.now()}:${userId}`, sequence: 0, snapshot: null, deviceIssue: null, restrictions: [],
    };
    if (cachedAuthority && authority.sequence > cachedAuthority.sequence) {
      notices = [...notices, ...accessNotices(cachedAuthority, authority)].slice(-12);
    }
    advanceAccessSession();
    publish({ ready: true, authority, notices, native: runtime });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ authority, notices }));
  });
}

export function captureAccessAuthority(): { session: string; sequence: number } | null {
  const a = state.authority;
  return a ? { session: a.session, sequence: a.sequence } : null;
}
function current(stamp: { session: string; sequence: number }): AccessAuthority | null {
  const a = state.authority;
  return a?.session === stamp.session && a.sequence === stamp.sequence ? a : null;
}

export async function applyAccessSnapshot(
  raw: unknown, stamp: { session: string; sequence: number }, profiles: ProfileIdentity[] = [],
): Promise<boolean> {
  const snapshot = parseAccessSnapshot(raw);
  return serial(async () => {
    const authority = current(stamp);
    if (!authority) return false;
    requireVpnConsent();
    const native = nativeAccess();
    if (native) {
      const runtime = parseRuntime(await native.applyAccessSnapshot(JSON.stringify(snapshot), JSON.stringify(profiles), stamp.session, stamp.sequence));
      if (!runtime.authority) return false;
      await adopt(runtime.authority, runtime);
      return runtime.authority.snapshot?.revision === snapshot.revision;
    }
    await adopt(reduceSnapshot(authority, snapshot, profiles));
    return true;
  });
}

export async function applyAccessIssue(
  issue: AccessIssue, stamp: { session: string; sequence: number }, profiles: ProfileIdentity[] = [],
): Promise<void> {
  return serial(async () => {
    const authority = current(stamp);
    if (!authority || issue.scope === 'session') return;
    const native = nativeAccess();
    if (native) {
      const runtime = parseRuntime(await native.applyAccessIssue(JSON.stringify(issue), JSON.stringify(profiles), stamp.session, stamp.sequence));
      if (runtime.authority) await adopt(runtime.authority, runtime);
    } else await adopt(reduceIssue(authority, issue, profiles));
  });
}

export async function syncNativeAccessState(): Promise<NativeAccessRuntime | null> {
  const native = nativeAccess();
  if (!native) return null;
  return serial(async () => {
    const runtime = parseRuntime(await native.getAccessControlState());
    if (runtime.authority && state.authority?.session === runtime.authority.session) await adopt(runtime.authority, runtime);
    return runtime;
  });
}

export async function clearAccessState(): Promise<void> {
  advanceAccessSession();
  await stopNativeAccessSession();
  return serial(async () => {
    publish({ ready: false, authority: null, notices: [], native: null });
    await AsyncStorage.removeItem(STORAGE_KEY);
  });
}

export function requireDeviceAccess(): void {
  const device = deviceAccess(state.authority);
  if (blocksDevice(device)) throw new AccessDeniedError({
    code: device!.status === 'active' ? 'DEVICE_DISABLED' : device!.code as AccessIssue['code'],
    scope: 'device', temporary: !device!.activationRequired,
  });
}
export function requireProfileAccess(profile: ProfileIdentity): void {
  const restriction = profileRestriction(state.authority, profile);
  if (restriction) throw new AccessDeniedError(profileIssue(restriction));
}

export async function dismissAccessNotices(): Promise<void> {
  return serial(async () => {
    publish({ ...state, notices: [] });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ authority: state.authority, notices: [] }));
  });
}

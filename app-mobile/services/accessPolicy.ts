export type DeviceStatus = 'active' | 'suspended' | 'disabled' | 'expired' | 'revoked' | 'deleted';
export type ProfileStatus = 'active' | 'suspended' | 'revoked' | 'deleted' | 'expired' | 'exhausted';
export type AccessCode =
  | 'DEVICE_SUSPENDED' | 'DEVICE_DISABLED' | 'DEVICE_EXPIRED' | 'DEVICE_REVOKED' | 'DEVICE_DELETED'
  | 'CONFIG_REVOKED' | 'CONFIG_DELETED' | 'CONFIG_SUSPENDED' | 'CONFIG_EXPIRED' | 'CONFIG_EXHAUSTED'
  | 'SESSION_INVALID';

export interface AccessIssue {
  code: AccessCode;
  scope: 'device' | 'subscription' | 'session';
  temporary: boolean;
  subscriptionId?: string;
}

export interface DeviceAccess {
  id: string;
  status: DeviceStatus;
  code: string;
  expireAt: string | null;
  activationRequired: boolean;
}

export interface ProfileAccess {
  id: string;
  name: string;
  status: ProfileStatus;
  quotaTotalBytes: number;
  quotaUsedBytes: number;
  expireAt: string | null;
  configVersion?: number;
  configHash?: string;
}

export interface AccessSnapshot {
  revision: string;
  serverTime: string;
  device: DeviceAccess;
  subscriptions: ProfileAccess[];
}

export interface ProfileIdentity {
  configId: string;
  subscriptionId?: string;
  configHash?: string | null;
  source?: 'backend' | 'manual';
  name?: string;
}

export interface ProfileRestriction {
  id: string;
  status: 'revoked' | 'deleted' | 'suspended';
  hashes: string[];
  name: string;
}

export interface AccessAuthority {
  userId: string;
  deviceId: string;
  session: string;
  sequence: number;
  snapshot: AccessSnapshot | null;
  deviceIssue: AccessIssue | null;
  restrictions: ProfileRestriction[];
}

export type AccessNoticeKind =
  | 'device_suspended' | 'device_disabled' | 'device_expired' | 'device_revoked' | 'device_deleted'
  | 'device_restored' | 'device_extended'
  | 'config_revoked' | 'config_deleted' | 'config_suspended' | 'config_expired' | 'config_exhausted'
  | 'config_restored' | 'config_extended' | 'config_quota_updated';
export interface AccessNotice { id: string; kind: AccessNoticeKind; name: string; }

const deviceStatuses = new Set<string>(['active', 'suspended', 'disabled', 'expired', 'revoked', 'deleted']);
const profileStatuses = new Set<string>(['active', 'suspended', 'revoked', 'deleted', 'expired', 'exhausted']);
const issueScopes: Record<AccessCode, AccessIssue['scope']> = {
  DEVICE_SUSPENDED: 'device', DEVICE_DISABLED: 'device', DEVICE_EXPIRED: 'device',
  DEVICE_REVOKED: 'device', DEVICE_DELETED: 'device',
  CONFIG_REVOKED: 'subscription', CONFIG_DELETED: 'subscription', CONFIG_SUSPENDED: 'subscription',
  CONFIG_EXPIRED: 'subscription', CONFIG_EXHAUSTED: 'subscription', SESSION_INVALID: 'session',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function safeProfileName(value: string): string {
  return value.replace(/SXB-(?:USER|DATA)-[\w-]+/gi, '[...]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u0020\u007f]/.test(value);
}
function date(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
}
function bytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whitelist the entire response before it can remove a local profile. */
export function parseAccessSnapshot(value: unknown): AccessSnapshot {
  if (!isRecord(value) || !identifier(value.revision) || typeof value.serverTime !== 'string' ||
      !date(value.serverTime) || !isRecord(value.device) || !Array.isArray(value.subscriptions) ||
      value.subscriptions.length > 10_000) throw new Error('ACCESS_SNAPSHOT_INVALID');
  const d = value.device;
  if (!identifier(d.id) || typeof d.status !== 'string' || !deviceStatuses.has(d.status) ||
      d.code !== `DEVICE_${d.status.toUpperCase()}` || !date(d.expireAt) ||
      typeof d.activationRequired !== 'boolean') throw new Error('ACCESS_DEVICE_INVALID');
  const ids = new Set<string>();
  const subscriptions = value.subscriptions.map((entry): ProfileAccess => {
    if (!isRecord(entry) || !identifier(entry.id) || ids.has(entry.id) ||
        typeof entry.name !== 'string' || typeof entry.status !== 'string' || !profileStatuses.has(entry.status) ||
        !bytes(entry.quotaTotalBytes) || !bytes(entry.quotaUsedBytes) || !date(entry.expireAt) ||
        (entry.configVersion !== undefined && !bytes(entry.configVersion)) ||
        (entry.configHash !== undefined && !identifier(entry.configHash))) throw new Error('ACCESS_PROFILE_INVALID');
    ids.add(entry.id);
    return {
      id: entry.id, name: safeProfileName(entry.name), status: entry.status as ProfileStatus,
      quotaTotalBytes: entry.quotaTotalBytes, quotaUsedBytes: entry.quotaUsedBytes, expireAt: entry.expireAt,
      ...(entry.configVersion === undefined ? {} : { configVersion: entry.configVersion as number }),
      ...(entry.configHash === undefined ? {} : { configHash: entry.configHash as string }),
    };
  });
  return {
    revision: value.revision, serverTime: value.serverTime,
    device: { id: d.id, status: d.status as DeviceStatus, code: d.code, expireAt: d.expireAt, activationRequired: d.activationRequired },
    subscriptions,
  };
}

export function parseAccessIssue(value: unknown): AccessIssue | null {
  if (!isRecord(value) || typeof value.code !== 'string' || !(value.code in issueScopes)) return null;
  const code = value.code as AccessCode;
  if (value.scope !== issueScopes[code] || typeof value.temporary !== 'boolean') return null;
  if (value.scope === 'subscription' && !identifier(value.subscriptionId)) return null;
  return {
    code, scope: issueScopes[code], temporary: value.temporary,
    ...(value.scope === 'subscription' ? { subscriptionId: value.subscriptionId as string } : {}),
  };
}

export function responseInfo(error: unknown): { status?: number; data?: unknown; retryAfter?: unknown } {
  if (!isRecord(error) || !isRecord(error.response)) return {};
  const { response } = error;
  return {
    status: typeof response.status === 'number' ? response.status : undefined,
    data: response.data,
    retryAfter: isRecord(response.headers) ? response.headers['retry-after'] : undefined,
  };
}

export function accessIssueFromError(error: unknown): AccessIssue | null {
  if (error instanceof AccessDeniedError) return error.issue;
  if (isRecord(error) && error.accessIssue) return parseAccessIssue(error.accessIssue);
  return parseAccessIssue(responseInfo(error).data);
}

/** A generic 403/404, and a 401 carrying a device/config refusal, are not logout orders. */
export function isInvalidSession(error: unknown): boolean {
  const { status, data } = responseInfo(error);
  const issue = accessIssueFromError(error);
  if (issue) return issue.scope === 'session';
  if (status !== 401 || !isRecord(data)) return false;
  if (data.scope || data.code) return false;
  // The old mobile refresh handler also returned invalid_token on DB outages.
  if (isRecord(error) && isRecord(error.config) &&
      typeof error.config.url === 'string' && error.config.url.includes('/mobile/auth/refresh')) return false;
  return ['Unauthorized', 'Token invalide ou expiré', 'Token invalide', 'Token expiré',
    'Refresh token invalide ou expiré', 'Refresh token invalide', 'Invalid or expired token',
    'Invalid refresh token', 'Token manquant', 'errors.auth.invalid_token', 'errors.auth.invalid_refresh'].includes(String(data.error ?? data.message ?? ''));
}

export class AccessDeniedError extends Error {
  constructor(readonly issue: AccessIssue) { super(issue.code); this.name = 'AccessDeniedError'; }
}

export function deviceAccess(authority: AccessAuthority | null): DeviceAccess | null {
  if (!authority) return null;
  if (!authority.deviceIssue) return authority.snapshot?.device ?? null;
  const issue = authority.deviceIssue;
  return {
    id: authority.snapshot?.device.id ?? '', status: issue.code.slice(7).toLowerCase() as DeviceStatus,
    code: issue.code, expireAt: authority.snapshot?.device.expireAt ?? null,
    activationRequired: issue.code === 'DEVICE_DELETED' || issue.code === 'DEVICE_REVOKED',
  };
}

export function blocksDevice(device: DeviceAccess | null): boolean {
  return !!device && (device.status !== 'active' || device.activationRequired);
}
export function accessRedirect(authenticated: boolean, ready: boolean, device: DeviceAccess | null, segment?: string): '/access-blocked' | '/(tabs)/' | null {
  if (!authenticated || !ready) return null;
  // `free-trial` reste joignable depuis un appareil bloqué : la demande d'essai
  // ne donne aucun accès par elle-même — elle crée une demande en attente que
  // l'exploitation doit approuver, et l'empreinte d'appareil interdit déjà un
  // second essai. L'en écarter enfermerait un appareil révoqué sans recours.
  if (blocksDevice(device)) return ['access-blocked', 'privacy', 'settings', 'activate', 'free-trial'].includes(segment || '') ? null : '/access-blocked';
  return segment === 'access-blocked' ? '/(tabs)/' : null;
}
export function blocksProfile(status: string | undefined): boolean {
  return status === 'revoked' || status === 'deleted' || status === 'suspended';
}
export function managedProfile(profile: ProfileIdentity): boolean {
  return profile.source === 'backend' || (profile.source !== 'manual' && !!profile.subscriptionId);
}

export function profileRestriction(authority: AccessAuthority | null, profile: ProfileIdentity): ProfileRestriction | null {
  if (!authority) return null;
  const ids = [profile.configId, profile.subscriptionId].filter(Boolean);
  const known = authority.restrictions.find(item =>
    ids.includes(item.id) || (!managedProfile(profile) && !profile.subscriptionId &&
      !!profile.configHash && item.hashes.includes(profile.configHash)));
  if (known) return known;
  const remote = authority.snapshot?.subscriptions.find(item => ids.includes(item.id));
  return remote && blocksProfile(remote.status)
    ? { id: remote.id, status: remote.status as ProfileRestriction['status'], hashes: remote.configHash ? [remote.configHash] : [], name: remote.name }
    : null;
}

export function profileIssue(restriction: ProfileRestriction): AccessIssue {
  return {
    code: `CONFIG_${restriction.status.toUpperCase()}` as AccessCode,
    scope: 'subscription', temporary: restriction.status === 'suspended', subscriptionId: restriction.id,
  };
}

export function reduceSnapshot(current: AccessAuthority, snapshot: AccessSnapshot, profiles: ProfileIdentity[]): AccessAuthority {
  if (current.snapshot && current.snapshot.device.id !== snapshot.device.id) throw new Error('ACCESS_CLIENT_MISMATCH');
  const restrictions = new Map(current.restrictions.map(item => [item.id, item]));
  // A deleted/lost binding returns no inventory; it does not delete each file.
  const minimalDeviceSnapshot = snapshot.subscriptions.length === 0 &&
    (snapshot.device.status === 'deleted' || (snapshot.device.status === 'revoked' && snapshot.device.activationRequired));
  const candidates = new Map<string, { name: string; hash?: string | null }>();
  for (const previous of current.snapshot?.subscriptions ?? []) candidates.set(previous.id, { name: previous.name, hash: previous.configHash });
  for (const profile of profiles) if (managedProfile(profile)) {
    candidates.set(profile.subscriptionId || profile.configId, { name: safeProfileName(profile.name ?? ''), hash: profile.configHash });
  }
  for (const [id, candidate] of candidates) {
    if (!minimalDeviceSnapshot && !snapshot.subscriptions.some(item => item.id === id)) {
      const hashes = new Set([...(restrictions.get(id)?.hashes ?? []), ...(candidate.hash ? [candidate.hash] : [])]);
      restrictions.set(id, { id, status: 'deleted', hashes: [...hashes], name: candidate.name });
    }
  }
  for (const entry of snapshot.subscriptions) {
    if (!blocksProfile(entry.status)) restrictions.delete(entry.id);
    else {
      const hashes = new Set([...(restrictions.get(entry.id)?.hashes ?? []),
        ...(candidates.get(entry.id)?.hash ? [candidates.get(entry.id)!.hash!] : []),
        ...(entry.configHash ? [entry.configHash] : [])]);
      restrictions.set(entry.id, { id: entry.id, status: entry.status as ProfileRestriction['status'], hashes: [...hashes], name: entry.name });
    }
  }
  return { ...current, sequence: current.sequence + 1, snapshot, deviceIssue: null, restrictions: [...restrictions.values()] };
}

export function reduceIssue(current: AccessAuthority, issue: AccessIssue, profiles: ProfileIdentity[]): AccessAuthority {
  if (issue.scope === 'session') return current;
  if (issue.scope === 'device') return { ...current, sequence: current.sequence + 1, deviceIssue: issue };
  const status = issue.code.slice(7).toLowerCase();
  if (!blocksProfile(status)) return current; // Expiry/quota are advisory, not a revocation.
  const id = issue.subscriptionId!;
  const previous = current.restrictions.find(item => item.id === id);
  const local = profiles.filter(item => item.configId === id || item.subscriptionId === id);
  const remote = current.snapshot?.subscriptions.find(item => item.id === id);
  const hashes = new Set([...(previous?.hashes ?? []), ...local.flatMap(item => item.configHash ? [item.configHash] : []),
    ...(remote?.configHash ? [remote.configHash] : [])]);
  const restriction: ProfileRestriction = { id, status: status as ProfileRestriction['status'],
    name: remote?.name || safeProfileName(local[0]?.name ?? ''), hashes: [...hashes] };
  return { ...current, sequence: current.sequence + 1, restrictions: [...current.restrictions.filter(item => item.id !== id), restriction] };
}

export function accessNotices(before: AccessAuthority | null, after: AccessAuthority): AccessNotice[] {
  const notices: AccessNotice[] = [];
  const add = (kind: AccessNoticeKind, id = 'device', name = '') => notices.push({
    id: `${after.session}:${after.sequence}:${id}:${kind}`, kind, name: safeProfileName(name),
  });
  const oldDevice = deviceAccess(before);
  const nextDevice = deviceAccess(after);
  if (nextDevice && nextDevice.status !== oldDevice?.status) {
    if (nextDevice.status !== 'active') add(`device_${nextDevice.status}`);
    else if (oldDevice) add('device_restored');
  } else if (oldDevice?.expireAt && nextDevice?.expireAt &&
      Date.parse(nextDevice.expireAt) > Date.parse(oldDevice.expireAt)) add('device_extended');
  for (const entry of after.restrictions) {
    if (before?.restrictions.find(item => item.id === entry.id)?.status !== entry.status) add(`config_${entry.status}`, entry.id, entry.name);
  }
  for (const entry of after.snapshot?.subscriptions ?? []) {
    const previous = before?.snapshot?.subscriptions.find(item => item.id === entry.id);
    const wasRestricted = before?.restrictions.some(item => item.id === entry.id);
    if (entry.status === 'active' && (wasRestricted || (previous && previous.status !== 'active'))) add('config_restored', entry.id, entry.name);
    else if ((entry.status === 'expired' || entry.status === 'exhausted') && previous?.status !== entry.status) add(`config_${entry.status}`, entry.id, entry.name);
    if (previous?.expireAt && (entry.expireAt === null || Date.parse(entry.expireAt) > Date.parse(previous.expireAt))) add('config_extended', entry.id, entry.name);
    if (previous && entry.quotaTotalBytes !== previous.quotaTotalBytes) add('config_quota_updated', entry.id, entry.name);
  }
  return notices;
}

export function retryDelay(attempt: number, retryAfter?: unknown, now = Date.now()): number {
  const seconds = typeof retryAfter === 'string' || typeof retryAfter === 'number' ? Number(retryAfter) : NaN;
  const headerDelay = Number.isFinite(seconds) ? seconds * 1000
    : typeof retryAfter === 'string' ? Date.parse(retryAfter) - now : 0;
  return Math.min(300_000, Math.max(1000 * 2 ** Math.min(attempt, 6), Number.isFinite(headerDelay) ? headerDelay : 0));
}

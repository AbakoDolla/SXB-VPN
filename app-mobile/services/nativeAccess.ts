import { NativeModules, Platform } from 'react-native';
import { requireVpnConsent } from './privacyConsent';
import type { AccessAuthority, ProfileIdentity } from './accessPolicy';

export interface NativeAccessRuntime {
  authority: AccessAuthority | null;
  observing: boolean;
  ticketStatus: 'missing' | 'ready' | 'expired' | 'invalid' | 'unsupported' | 'backoff';
  ticketExpiresAt: string | null;
  activeProfile: ProfileIdentity | null;
}
export interface NativeAccessModule {
  bindAccessSession(userId: string, deviceId: string): Promise<string>;
  getAccessControlState(): Promise<string>;
  applyAccessSnapshot(snapshot: string, profiles: string, session: string, sequence: number): Promise<string>;
  applyAccessIssue(issue: string, profiles: string, session: string, sequence: number): Promise<string>;
  setAccessTicket(baseUrl: string, ticket: string, expiresAt: string, session: string): Promise<void>;
  clearAccessSession(): Promise<void>;
}

export function nativeAccess(): NativeAccessModule | null {
  const module: NativeAccessModule | undefined = NativeModules.SxbVpnNative;
  return Platform.OS === 'android' && module?.bindAccessSession ? module : null;
}

export async function stopNativeAccessSession(): Promise<void> {
  await nativeAccess()?.clearAccessSession();
}

export async function storeNativeAccessTicket(baseUrl: string, ticket: string, expiresAt: string, session: string): Promise<void> {
  requireVpnConsent();
  const deadline = Date.parse(expiresAt);
  if (!ticket || ticket.length > 8192 || !Number.isFinite(deadline) ||
      deadline <= Date.now() || deadline > Date.now() + 7 * 86400_000 + 60_000) throw new Error('ACCESS_TICKET_INVALID');
  await nativeAccess()?.setAccessTicket(baseUrl, ticket, expiresAt, session);
}

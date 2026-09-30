import apiClient from './apiClient';
import { accessRequestStamp, currentIdentityRequest } from './accessEvents';
import { isRecord } from './accessPolicy';
import { sessionSecurity } from './deviceSecurity';
import { requireVpnConsent } from './privacyConsent';
import type { UsageContext } from './usageLedger';

const acknowledgements = new Map<string, string>();
let identityEpoch = -1;

/** Attribution is synchronized through the running tunnel, never before dialing. */
export async function ensureUsageSession(context: UsageContext, signal: AbortSignal): Promise<void> {
  const stamp = accessRequestStamp();
  requireVpnConsent();
  const security = await sessionSecurity();
  if (!currentIdentityRequest(stamp)) throw new Error('AUTH_SESSION_CHANGED');
  if (!security) return;
  if (signal.aborted) throw new Error('VPN_USAGE_PREPARING');
  if (!/^sess_[0-9a-f-]{36}$/i.test(context.sessionId) ||
      typeof context.configId !== 'string' || !context.configId || context.configId.length > 200 ||
      /[\u0000-\u0020\u007f]/.test(context.configId) ||
      (!context.subscriptionId && context.attribution !== 'unlinked')) {
    throw new Error('VPN_USAGE_BINDING_UNAVAILABLE');
  }
  if (identityEpoch !== stamp.epoch) {
    acknowledgements.clear();
    identityEpoch = stamp.epoch;
  }
  const binding = JSON.stringify([context.configId, context.subscriptionId]);
  const acknowledged = acknowledgements.get(context.sessionId);
  if (acknowledged) {
    if (acknowledged !== binding) throw new Error('VPN_USAGE_ATTRIBUTION_CONFLICT');
    return;
  }
  const connectionId = context.sessionId.slice('sess_'.length);
  const response = await apiClient.post('/mobile/vpn/session', {
    action: 'sync', connectionId, sessionId: context.sessionId,
    subscriptionId: context.subscriptionId, configId: context.configId,
  }, { timeout: 5000, signal });
  requireVpnConsent();
  if (!currentIdentityRequest(stamp)) throw new Error('AUTH_SESSION_CHANGED');
  if (signal.aborted) throw new Error('VPN_USAGE_PREPARING');
  const connection = isRecord(response.data) ? response.data.connection : undefined;
  if (!isRecord(connection) || connection.id !== connectionId ||
      connection.usageSessionId !== context.sessionId ||
      connection.configId !== context.configId || connection.subscriptionId !== context.subscriptionId ||
      connection.clientId !== security.clientId) throw new Error('VPN_USAGE_BINDING_INVALID');
  if (acknowledgements.size >= 256) acknowledgements.clear();
  acknowledgements.set(context.sessionId, binding);
}

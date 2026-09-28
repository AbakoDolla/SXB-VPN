import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { MobileIdentity } from './access-ticket';

export { SSH_RELAY_PATH } from './ssh-relay-transport';
const audience = 'sxb-vpn:ssh-relay';
const issuer = 'sxb-vpn:relay-control';
const maxSeconds = 7 * 86400;
const key = (secret: string) => createHmac('sha256', secret).update('SXB/ssh-relay/v1').digest();

export interface RelayIdentity extends MobileIdentity {
  subscriptionId: string;
  configHash: string;
  exp: number;
}

export function issueRelayTicket(identity: Omit<RelayIdentity, 'exp'>, secret: string, expiresAt: number) {
  if (!identity.sid || !identity.kid || !Number.isSafeInteger(identity.sg)) throw new Error('RELAY_BOUND_SESSION_REQUIRED');
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + maxSeconds, Math.floor(expiresAt / 1000));
  if (exp <= now) throw new Error('RELAY_SESSION_EXPIRED');
  return {
    ticket: jwt.sign({ ...identity, iat: now, exp }, key(secret), {
      algorithm: 'HS256', issuer, audience, subject: identity.clientId,
    }),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyRelayTicket(ticket: string, secret: string, renewal = false): RelayIdentity {
  const value = jwt.verify(ticket, key(secret), { algorithms: ['HS256'], issuer, audience, ignoreExpiration: renewal });
  if (typeof value === 'string' ||
      ['userId', 'clientId', 'deviceId', 'subscriptionId', 'configHash', 'sid', 'kid']
        .some(field => typeof value[field] !== 'string' || !value[field] || value[field].length > 256) ||
      !Number.isSafeInteger(value.sg) || value.sg < 1 ||
      typeof value.iat !== 'number' || typeof value.exp !== 'number' ||
      !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) ||
      value.exp <= value.iat || value.exp - value.iat > maxSeconds ||
      value.iat > Math.floor(Date.now() / 1000) || value.sub !== value.clientId) {
    throw new jwt.JsonWebTokenError('RELAY_TICKET_INVALID');
  }
  return {
    userId: value.userId, clientId: value.clientId, deviceId: value.deviceId,
    subscriptionId: value.subscriptionId, configHash: value.configHash,
    sid: value.sid, kid: value.kid, sg: value.sg, exp: value.exp,
  };
}

/** Roll out only profiles explicitly verified as reachable from this gateway. */
export function relayProfileEnabled(profileId: string): boolean {
  return (process.env.SXB_SSH_RELAY_PROFILE_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean).includes(profileId);
}

export function relayClientConfig(
  source: Record<string, unknown>, profileId: string,
  credential: { ticket: string; expiresAt: string },
) {
  // An allowlist, not a copy of the provider configuration: no upstream secrets.
  return {
    protocol: 'ssh', displayProtocol: source.displayProtocol ?? 'SSH',
    host: 'sxb-gateway', port: 443, username: 'sxb',
    sshRelay: { version: 1, ...credential },
    profileId, profileName: source.profileName,
    dns: source.dns,
    timeoutMs: 30000,
    udpMode: source.udpMode === 'udpgw' ? 'udpgw' : 'none',
    // The gateway maps this marker to the configured upstream UDPGW endpoint.
    udpGatewayHost: 'sxb-udpgw', udpGatewayPort: 7300,
  };
}

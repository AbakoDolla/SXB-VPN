import { isIP } from 'node:net';

export class ConnectionDnsError extends Error {
  readonly code = 'PROFILE_DNS_INVALID';
  constructor() { super('errors.profile_dns_invalid'); }
}

export function connectionDnsValue(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || value.length > 512) throw new ConnectionDnsError();
  const address = value.trim();
  if (!address) return '';
  if (address === 'local') return address;
  if (/\s|[\r\n]|[?#]/.test(address)) throw new ConnectionDnsError();
  const prefixed = address.includes('://') ? address : `tcp://${address}`;
  let url: URL;
  try { url = new URL(prefixed); } catch { throw new ConnectionDnsError(); }
  if (!['tcp:', 'udp:', 'tls:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ConnectionDnsError();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && isIP(hostname) !== 4) throw new ConnectionDnsError();
  const validHost = isIP(hostname) !== 0 || hostname.length <= 253 &&
    hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!validHost || url.port && (Number(url.port) < 1 || Number(url.port) > 65535) ||
      url.protocol !== 'https:' && url.pathname && url.pathname !== '/') throw new ConnectionDnsError();
  return address.includes('://') ? url.protocol + address.slice(address.indexOf(':') + 1) : address;
}

import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { once } from 'node:events';
import { substitutePayload, sshPayloadChunks, writeSshPayload as writeRelayPayload } from './transport-probe';
export { writeRelayPayload };

export interface RelayUpstream {
  host: string; port: number; username: string; password?: string;
  privateKey?: Buffer; passphrase?: string; fingerprint: string;
  tls: boolean; sni: string; payload: string; proxyHost?: string; proxyPort?: number;
  udpHost?: string; udpPort?: number;
  userAgent?: string;
}

export function publicRelayAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19));
  }
  // Resolve only IPv4 here; IPv6 must never bypass IPv4/private-network checks.
  return false;
}

export function relayUpstream(config: Record<string, unknown>): RelayUpstream {
  const text = (key: string) => typeof config[key] === 'string' ? config[key] as string : '';
  const protocol = text('protocol').toLowerCase();
  const transport = text('sshTransport').toLowerCase();
  if (!['ssh', 'ssh+payload'].includes(protocol) || config.slowDns || transport === 'slowdns' ||
      config.insecure || config.allowInsecure) throw new Error('RELAY_TRANSPORT_UNSUPPORTED');
  const host = text('host'), port = Number(config.port ?? 22);
  const username = text('username'), fingerprint = text('fingerprint');
  if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !username || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) throw new Error('RELAY_UPSTREAM_UNVERIFIED');
  const usePayload = config.usePayload === true || /payload|http|proxy/.test(protocol) ||
    ['payload', 'payload-tls', 'http-connect'].includes(transport);
  const payload = text('payload');
  if (usePayload && (!payload || payload.length > 32768)) throw new Error('RELAY_PAYLOAD_REQUIRED');
  // Rotation depends on the originating client's state, unlike deterministic splits.
  if (/\[(?:rotate|random)[^\]]*\]/i.test(payload)) {
    throw new Error('RELAY_PAYLOAD_UNSUPPORTED');
  }
  if (usePayload && !sshPayloadChunks(payload).length) throw new Error('RELAY_PAYLOAD_REQUIRED');
  const proxy = config.proxyEnabled === true || /http-connect|proxy/.test(protocol) || transport === 'http-connect';
  const proxyHost = proxy ? text('proxyHost') || host : undefined;
  const proxyPort = proxy ? Number(config.proxyPort || port) : undefined;
  if (proxyPort !== undefined && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) {
    throw new Error('RELAY_PROXY_INVALID');
  }
  const privateKey = text('privateKeyBase64');
  if (privateKey.length > 262144 || (!privateKey && !text('password'))) throw new Error('RELAY_CREDENTIAL_INVALID');
  const udpPort = Number(config.udpGatewayPort || 7300);
  if (config.udpMode === 'udpgw' && (!Number.isInteger(udpPort) || udpPort < 1 || udpPort > 65535)) {
    throw new Error('RELAY_UDPGW_INVALID');
  }
  if (config.sslPort && Number(config.sslPort) !== port ||
      config.payloadTargetPort && Number(config.payloadTargetPort) !== port) throw new Error('RELAY_PORT_OVERRIDE_UNSUPPORTED');
  return {
    host, port, username, password: text('password') || undefined,
    privateKey: privateKey ? Buffer.from(privateKey, 'base64') : undefined,
    passphrase: text('privateKeyPassphrase') || undefined, fingerprint,
    tls: config.tls === true || config.tlsEnabled === true || /tls|ssl/.test(protocol) || /tls/.test(transport),
    sni: text('sni') || proxyHost || host, payload: usePayload ? payload : '', proxyHost, proxyPort,
    userAgent: text('userAgent') || 'SXB-VPN/Android',
    ...(config.udpMode === 'udpgw' ? { udpHost: text('udpGatewayHost') || '127.0.0.1', udpPort } : {}),
  };
}

/** Return a paused SSH byte stream; no redirect or caller-selected destination. */
export async function openRelayUpstream(config: RelayUpstream, signal: AbortSignal): Promise<net.Socket> {
  signal.throwIfAborted();
  const host = config.proxyHost || config.host, port = config.proxyPort || config.port;
  const addresses = await dns.lookup(host, { all: true, family: 4 });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(value => !publicRelayAddress(value.address))) throw new Error('RELAY_ADDRESS_DENIED');
  let socket: net.Socket = new net.Socket({ allowHalfOpen: true });
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  socket.once('close', () => signal.removeEventListener('abort', abort));
  const deadline = setTimeout(() => socket.destroy(new Error('RELAY_CONNECT_TIMEOUT')), 15000);
  try {
    socket.connect(port, addresses[0].address);
    await once(socket, 'connect', { signal });
    socket.setNoDelay(true);
    if (config.tls) {
      socket = tls.connect({
        socket, servername: net.isIP(config.sni) ? undefined : config.sni,
        rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity(config.sni, cert),
      });
      await once(socket, 'secureConnect', { signal });
    }
    if (config.payload) {
      const payload = substitutePayload(config.payload, config.host, config.sni, config.port, config.userAgent);
      const chunks = sshPayloadChunks(payload);
      const requestCount = chunks.map(chunk => chunk.text).join('').split('\r\n\r\n')
        .filter(request => /^[A-Z]+\s+\S+\s+HTTP\/\d(?:\.\d)?$/i.test(request.split('\r\n')[0].trim())).length;
      await writeRelayPayload(socket, payload, signal);
      await stripRelayHttp(socket, signal, Math.max(1, requestCount));
    }
    clearTimeout(deadline);
    return socket;
  } catch (error) {
    clearTimeout(deadline);
    socket.destroy();
    throw error;
  }
}

/** Bounded HTTP facade parsing. A real WebSocket is rejected, never treated as SSH. */
export async function stripRelayHttp(socket: net.Socket, signal: AbortSignal, requestCount = 1): Promise<void> {
  if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 16) throw new Error('RELAY_REQUEST_COUNT_INVALID');
  let bytes = 0, responses = 0;
  let answeredRequests = 0, pendingRejection: Error | undefined;
  const deadline = Date.now() + 15000;
  function readable(timeout: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('readable', ready); socket.off('end', ended);
        socket.off('close', ended); socket.off('error', failed);
        signal.removeEventListener('abort', cancelled);
      };
      const ready = () => { cleanup(); resolve(true); };
      const ended = () => { cleanup(); reject(pendingRejection ?? new Error('RELAY_RESPONSE_TRUNCATED')); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cancelled = () => { cleanup(); reject(new Error('RELAY_ABORTED')); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeout);
      socket.once('readable', ready); socket.once('end', ended);
      socket.once('close', ended); socket.once('error', failed);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      else if (socket.destroyed || socket.readableEnded) ended();
    });
  }
  async function read(count: number): Promise<Buffer> {
    if ((bytes += count) > 131072) throw new Error('RELAY_RESPONSE_TOO_LARGE');
    const chunks: Buffer[] = [];
    let remainingBytes = count;
    while (remainingBytes) {
      signal.throwIfAborted();
      const value: Buffer | null = socket.read(Math.min(remainingBytes, socket.readableLength) || remainingBytes);
      if (value) {
        chunks.push(value); remainingBytes -= value.length;
        continue;
      }
      if (socket.destroyed || socket.readableEnded) throw pendingRejection ?? new Error('RELAY_RESPONSE_TRUNCATED');
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !await readable(remaining)) throw pendingRejection ?? new Error('RELAY_RESPONSE_TIMEOUT');
    }
    return Buffer.concat(chunks, count);
  }
  async function line(): Promise<string> {
    let value = '';
    while (value.length < 8192) {
      value += (await read(1)).toString('latin1');
      if (value.endsWith('\r\n')) return value.slice(0, -2);
    }
    throw new Error('RELAY_HEADERS_TOO_LARGE');
  }
  let accepted = true;
  while (true) {
    if (accepted && responses && !socket.readableLength && !await readable(250)) return;
    const first = await read(1);
    socket.unshift(first); bytes--;
    if (first[0] === 83 && accepted) return;
    if (first[0] !== 72) throw pendingRejection ?? new Error('RELAY_RESPONSE_INVALID');
    if (++responses > 16) throw new Error('RELAY_RESPONSE_INVALID');
    let headers = (await line()) + '\r\n';
    while (!headers.endsWith('\r\n\r\n')) {
      headers += (await line()) + '\r\n';
      if (headers.length > 8192) throw new Error('RELAY_HEADERS_TOO_LARGE');
    }
    const code = Number(/^HTTP\/1\.[01] (\d{3})(?: |\r)/.exec(headers)?.[1]);
    if (code === 101 || code >= 200) answeredRequests++;
    accepted = code === 101 || (code >= 200 && code <= 299);
    const rejection = !accepted && ![100, 301, 302, 303, 307, 308].includes(code)
      ? new Error('RELAY_HTTP_REJECTED') : undefined;
    const intermediateRefusal = code === 403 && answeredRequests < requestCount &&
      headers.startsWith('HTTP/1.1 ') && !/^connection:\s*[^\r\n]*\bclose\b/im.test(headers) &&
      /^(?:content-length|transfer-encoding)\s*:/im.test(headers);
    if (rejection && !intermediateRefusal) throw rejection;
    if (/^location:[^\r\n]*(?:captive|portal|nointernet)/im.test(headers)) throw new Error('RELAY_PORTAL');
    if (/^sec-websocket-accept:/im.test(headers)) throw new Error('RELAY_WEBSOCKET_UNSUPPORTED');
    const lengths = [...headers.matchAll(/^content-length:\s*(.*?)\r$/gim)];
    const transfers = [...headers.matchAll(/^transfer-encoding:\s*(.*?)\r$/gim)];
    if (lengths.length > 1 || transfers.length > 1 || (lengths.length && transfers.length)) throw new Error('RELAY_FRAMING_INVALID');
    let body: Buffer = Buffer.alloc(0);
    if (lengths.length) {
      const size = lengths[0][1];
      if (!/^\d+$/.test(size) || Number(size) > 65536) throw new Error('RELAY_FRAMING_INVALID');
      if (Number(size)) body = await read(Number(size));
    }
    if (transfers.length) {
      if (transfers[0][1].toLowerCase() !== 'chunked') throw new Error('RELAY_FRAMING_INVALID');
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const chunk = (await line()).split(';')[0];
        if (!/^[a-f0-9]+$/i.test(chunk)) throw new Error('RELAY_FRAMING_INVALID');
        const count = parseInt(chunk, 16);
        if (!Number.isSafeInteger(count) || (size += count) > 65536) throw new Error('RELAY_BODY_TOO_LARGE');
        if (!count) {
          let trailers = 0, trailer: string;
          do { trailer = await line(); trailers += trailer.length + 2; if (trailers > 8192) throw new Error('RELAY_HEADERS_TOO_LARGE'); } while (trailer);
          break;
        }
        chunks.push(await read(count));
        if ((await read(2)).toString() !== '\r\n') throw new Error('RELAY_FRAMING_INVALID');
      }
      body = Buffer.concat(chunks);
    }
    if (/<html/i.test(body.toString()) && /captive|portal|nointernet/i.test(body.toString())) throw new Error('RELAY_PORTAL');
    pendingRejection = rejection;
  }
}
export const SSH_RELAY_PATH = '/api/mobile/ssh-relay';

/**
 * transport-probe.ts — Préflight SXB « Tester la configuration importée »
 *
 * Règles (mission §7) :
 *   - Ne crée/configure AUCUN serveur : teste uniquement le serveur EXTERNE fourni.
 *   - Aucune authentification par défaut (AUTH_* réservés, jamais de credential
 *     utilisé ni loggé dans ce module — la sonde est transport-only).
 *   - Résultats structurés : DNS_RESOLVED, TCP_CONNECTED, TLS_HANDSHAKE_OK,
 *     TLS_FAILED, SSH_BANNER_RECEIVED, SSH_BANNER_MISSING, HTTP_STATUS_101,
 *     HTTP_STATUS_200, HTTP_STATUS_UNEXPECTED, LATENCY_MS.
 *   - ssh direct : exige une bannière "SSH-" pour être déclaré compatible.
 *   - ssh+payload : substitue le payload ([crlf], [host], [ua]…), vérifie la
 *     réponse (101/200), et confirme que le flux sous-jacent devient SSH.
 *   - Une config inaccessible depuis la sonde ≠ invalide (géo/opérateur
 *     restreinte) : verdict 'unreachable_from_probe' distinct de 'invalid'.
 *   - Jamais de secret dans les résultats/logs.
 */
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

export type ProbeEvent =
  | 'DNS_RESOLVED' | 'TCP_CONNECTED'
  | 'TLS_HANDSHAKE_OK' | 'TLS_FAILED'
  | 'SSH_BANNER_RECEIVED' | 'SSH_BANNER_MISSING'
  | 'HTTP_STATUS_101' | 'HTTP_STATUS_200' | 'HTTP_STATUS_UNEXPECTED'
  | 'LATENCY_MS';

export interface ProbeStep {
  event: ProbeEvent | string;
  ok: boolean;
  detail?: string;      // jamais de credential — bannière serveur tronquée autorisée
}

export interface ProbeReport {
  verdict: 'transport_ok' | 'invalid' | 'unreachable_from_probe' | 'unsupported';
  steps: ProbeStep[];
  latencyMs?: number;
  startedAt: string;
  durationMs: number;
  hint?: string;        // conseil d'action, sans données sensibles
}

const DEF_TIMEOUT = 8000;
export const DEFAULT_SSH_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36';

// ── Substitution du payload (SSH+Payload) ────────────────────────────────────
export function substitutePayload(
  template: string, host: string, sni?: string | null, port = 443,
  userAgent = DEFAULT_SSH_USER_AGENT,
): string {
  const tlsServerName = (sni && sni.trim()) || host;
  const random = crypto.randomBytes(6).toString('hex');
  return template
    .replace(/\[method\]/gi, 'CONNECT')
    .replace(/\[protocol\]/gi, 'HTTP/1.0')
    .replace(/\[ssh\]/gi, `${host}:${port}`)
    .replace(/\[crlf\]/gi, '\r\n')
    .replace(/\[lfcr\]/gi, '\n\r')
    .replace(/\[lf\]/gi, '\n')
    .replace(/\[cr\]/gi, '\r')
    .replace(/\[host_port\]/gi, `${host}:${port}`)
    .replace(/\[port\]/gi, String(port))
    .replace(/\[host\]/gi, host)
    .replace(/\[ua\]/gi, userAgent)
    .replace(/\[host_header\]/gi, host)
    .replace(/\[sni\]/gi, tlsServerName)
    .replace(/%HOST%/gi, host)
    .replace(/%SNI%/gi, tlsServerName)
    .replace(/%IP%/gi, host)
    .replace(/%PORT%/gi, String(port))
    .replace(/%RAND%/gi, random);
}

export function sshPayloadChunks(payload: string): Array<{ text: string; delayMs: number }> {
  const directive = /\[(delay_split|instant_split|split)\]/gi;
  const stripped = payload.replace(directive, '');
  if (/\[(?:split|instant_split|delay_split)/i.test(stripped)) throw new Error('PAYLOAD_TOKEN_INVALID');
  const chunks: Array<{ text: string; delayMs: number }> = [];
  let offset = 0, delayMs = 0;
  const append = (text: string) => {
    if (!text) return;
    chunks.push({ text, delayMs });
    delayMs = 0;
    if (chunks.length > 32) throw new Error('PAYLOAD_SPLIT_LIMIT');
  };
  for (const split of payload.matchAll(directive)) {
    append(payload.slice(offset, split.index));
    if (split[1].toLowerCase() === 'delay_split') delayMs = 1000;
    offset = split.index! + split[0].length;
  }
  append(payload.slice(offset));
  return chunks;
}

export async function writeSshPayload(socket: net.Socket, payload: string, signal: AbortSignal): Promise<number> {
  const chunks = sshPayloadChunks(payload);
  signal.throwIfAborted();
  if (socket.destroyed) throw new Error('RELAY_PAYLOAD_CLOSED');
  let failed!: (error: Error) => void;
  const transportFailure = new Promise<never>((_, reject) => { failed = reject; });
  const closed = () => failed(new Error('RELAY_PAYLOAD_CLOSED'));
  socket.once('error', failed);
  socket.once('close', closed);
  const operation = (async () => {
    let bytes = 0;
    for (const chunk of chunks) {
      signal.throwIfAborted();
      if (socket.destroyed) throw new Error('RELAY_PAYLOAD_CLOSED');
      if (chunk.delayMs) await pause(chunk.delayMs, undefined, { signal });
      signal.throwIfAborted();
      if (socket.destroyed) throw new Error('RELAY_PAYLOAD_CLOSED');
      const encoded = Buffer.from(chunk.text, 'latin1');
      await new Promise<void>((resolve, reject) => {
        socket.write(encoded, error => error ? reject(error) : resolve());
      });
      bytes += encoded.length;
    }
    return bytes;
  })();
  try { return await Promise.race([operation, transportFailure]); }
  finally {
    socket.off('error', failed);
    socket.off('close', closed);
  }
}

// ── Lecture bornée d'un préfixe de flux ──────────────────────────────────────
/**
 * `stopWhen` permet de rendre la main dès que le préfixe lu suffit (fin d'un
 * bloc d'en-têtes HTTP, par exemple). Sans lui, la lecture attendait toujours
 * l'expiration du délai, ce qui immobilisait le préflight une douzaine de
 * secondes alors que la réponse était arrivée en 200 ms.
 */
function readUpTo(
  sock: net.Socket | tls.TLSSocket,
  maxBytes: number,
  timeoutMs: number,
  stopWhen?: (buf: Buffer) => boolean,
): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(done, timeoutMs);
    const onData = (b: Buffer) => {
      chunks.push(b); total += b.length;
      if (total >= maxBytes) return done();
      if (stopWhen && stopWhen(Buffer.concat(chunks))) done();
    };
    const onErr = () => done();
    function done() {
      clearTimeout(timer);
      sock.off('data', onData); sock.off('error', onErr); sock.off('timeout', onErr);
      resolve(Buffer.concat(chunks));
    }
    sock.on('data', onData); sock.on('error', onErr); sock.setTimeout(timeoutMs, onErr);
  });
}

/** Vrai dès que le bloc d'en-têtes HTTP est complet (CRLF CRLF ou LF LF). */
const HTTP_HEAD_COMPLETE = (buf: Buffer): boolean => {
  const s = buf.toString('latin1');
  return s.includes('\r\n\r\n') || s.includes('\n\n');
};

function resolveAll(host: string): Promise<string[]> {
  // dns.lookup n'a pas de timeout natif (résolveurs pouvant ignorer les NXDOMAIN
  // derrière certains sandbox/proxy) → race bornée à 3 s.
  const probeDns = dns.lookup(host, { all: true }).then((r) => r.map((x) => x.address)).catch(() => []);
  const timeout = new Promise<string[]>((res) => setTimeout(() => res([]), 3000));
  return Promise.race([probeDns, timeout]);
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<{ sock: net.Socket; latencyMs: number } | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => resolve({ sock, latencyMs: Date.now() - started }));
    sock.once('timeout', () => { sock.destroy(); resolve(null); });
    sock.once('error', () => { sock.destroy(); resolve(null); });
    sock.connect(port, host);
  });
}

function tlsUpgrade(
  plain: net.Socket, host: string, sni: string | undefined, timeoutMs: number, insecure = false,
): Promise<{ sock: tls.TLSSocket; subject?: string; issuer?: string } | { error: string }> {
  return new Promise((resolve) => {
    const s = tls.connect({
      socket: plain,
      servername: sni || host,
      // Même contrat que le mobile : chaîne et identité TLS vérifiées par
      // défaut ; désactivation uniquement si le profil le demande explicitement.
      rejectUnauthorized: !insecure,
      ALPNProtocols: ['http/1.1'],
      timeout: timeoutMs,
      servernameCallback: undefined as any,
    } as tls.ConnectionOptions);
    const to = setTimeout(() => { s.destroy(); resolve({ error: `timeout TLS après ${timeoutMs}ms` }); }, timeoutMs);
    s.once('secureConnect', () => {
      clearTimeout(to);
      let subject: string | undefined; let issuer: string | undefined;
      try {
        const cert = s.getPeerCertificate();
        subject = (cert?.subject as any)?.CN; issuer = (cert?.issuer as any)?.CN;
      } catch { /* sans objet */ }
      resolve({ sock: s, subject, issuer });
    });
    s.once('error', (e) => { clearTimeout(to); resolve({ error: e.message }); });
  });
}

// ── WS handshake pour ssh+payload (après 101 → le flux doit devenir SSH) ─────
async function probeWsTunnel(
  sock: net.Socket | tls.TLSSocket,
  payload: string,
  timeoutMs: number,
  steps: ProbeStep[],
): Promise<void> {
  const requests = payload.replace(/\[(?:delay_split|instant_split|split)\]/gi, '').split('\r\n\r\n')
    .filter(request => /^[A-Z]+\s+\S+\s+HTTP\/\d(?:\.\d)?$/i.test(request.split('\r\n')[0].trim()));
  if (requests.length > 16) throw new Error('PAYLOAD_REQUEST_LIMIT');
  const finalHeaders = requests.at(-1) || '';
  const wantsWebsocket = !/^CONNECT /i.test(finalHeaders) && /^upgrade\s*:\s*websocket\s*$/im.test(finalHeaders);
  let request = payload;
  if (requests.length <= 1 && wantsWebsocket && !/^sec-websocket-key\s*:/im.test(finalHeaders)) {
    request = payload.replace('\r\n\r\n',
      `\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}` +
      '\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n');
  }
  // Subscribe through readable before writing: even an immediate response stays buffered.
  sock.pause();
  sock.setTimeout(0);
  const deadline = performance.now() + timeoutMs;
  let total = 0, responses = 0, answered = 0, preambleLines = 0, preambleBytes = 0;
  let held: Buffer | undefined;
  let accepted = false, websocket = false, advertisedWebsocket = false, bannerSent = false;
  let pendingRefusal = false;
  const fail = (code: string): never => { throw new Error(code); };
  const waitReadable = (until: number): Promise<void> => new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      sock.off('readable', ready); sock.off('end', ended); sock.off('close', ended); sock.off('error', failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const ended = () => { cleanup(); reject(new Error(pendingRefusal ? 'SSH_PROBE_HTTP_REFUSED' : 'SSH_PROBE_TRUNCATED')); };
    const failed = () => { cleanup(); reject(new Error('SSH_PROBE_CLOSED')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('SSH_PROBE_TIMEOUT')); }, Math.max(1, until - performance.now()));
    sock.once('readable', ready); sock.once('end', ended); sock.once('close', ended); sock.once('error', failed);
    if (sock.readableLength) ready();
    else if (sock.destroyed || sock.readableEnded) ended();
  });
  const read = async (count: number, until = deadline): Promise<Buffer> => {
    if (performance.now() >= until) fail(pendingRefusal ? 'SSH_PROBE_HTTP_REFUSED' : 'SSH_PROBE_TIMEOUT');
    if (count < 0 || total + count > 131072) fail('SSH_PROBE_TOO_LARGE');
    const chunks: Buffer[] = [];
    let left = count;
    if (held && left) { chunks.push(held); held = undefined; left--; }
    while (left) {
      if (performance.now() >= until) fail(pendingRefusal ? 'SSH_PROBE_HTTP_REFUSED' : 'SSH_PROBE_TIMEOUT');
      const bytes = sock.read(Math.min(left, sock.readableLength) || left) as Buffer | null;
      if (bytes) { chunks.push(bytes); left -= bytes.length; continue; }
      if (sock.destroyed || sock.readableEnded) fail(pendingRefusal ? 'SSH_PROBE_HTTP_REFUSED' : 'SSH_PROBE_TRUNCATED');
      await waitReadable(until);
    }
    total += count;
    return Buffer.concat(chunks, count);
  };
  const peek = async (until = deadline): Promise<number> => {
    const byte = await read(1, until);
    held = byte; total--;
    return byte[0];
  };
  const line = async (limit = 8192): Promise<string> => {
    let text = '';
    while (text.length < limit) {
      const byte = (await read(1))[0];
      if (byte === 10) return text.replace(/\r$/, '');
      if (byte !== 13 && byte !== 9 && (byte < 32 || byte > 126)) fail('SSH_PROBE_INVALID');
      text += String.fromCharCode(byte);
    }
    return fail('SSH_PROBE_HEADERS_TOO_LARGE');
  };
  const consumeBody = async (headers: string): Promise<void> => {
    const lengths = [...headers.matchAll(/^content-length\s*:\s*([^\r\n]+)/gim)];
    const encodings = [...headers.matchAll(/^transfer-encoding\s*:\s*([^\r\n]+)/gim)];
    if (lengths.length > 1 || encodings.length > 1 || lengths.length && encodings.length) fail('SSH_PROBE_FRAMING_INVALID');
    const chunks: Buffer[] = [];
    let size = 0;
    const take = async (count: number) => {
      if (!Number.isSafeInteger(count) || count < 0 || (size += count) > 65536) fail('SSH_PROBE_BODY_TOO_LARGE');
      if (count) chunks.push(await read(count));
    };
    if (lengths.length) {
      const value = lengths[0][1].trim();
      if (!/^\d+$/.test(value)) fail('SSH_PROBE_FRAMING_INVALID');
      await take(Number(value));
    } else if (encodings.length) {
      if (encodings[0][1].trim().toLowerCase() !== 'chunked') fail('SSH_PROBE_FRAMING_INVALID');
      while (true) {
        const value = (await line()).split(';')[0].trim();
        if (!/^[a-f0-9]+$/i.test(value)) fail('SSH_PROBE_FRAMING_INVALID');
        const count = Number.parseInt(value, 16);
        if (!count) {
          let trailerBytes = 0;
          while (true) {
            const trailer = await line();
            if ((trailerBytes += trailer.length + 2) > 8192) fail('SSH_PROBE_HEADERS_TOO_LARGE');
            if (!trailer) break;
            if (!trailer.includes(':')) fail('SSH_PROBE_FRAMING_INVALID');
          }
          break;
        }
        await take(count);
        if ((await read(2)).toString('latin1') !== '\r\n') fail('SSH_PROBE_FRAMING_INVALID');
      }
    }
    const body = Buffer.concat(chunks).toString('latin1');
    if (/<html/i.test(body) && /captive|portal|nointernet/i.test(body)) fail('SSH_PROBE_PORTAL');
  };
  const writeFrame = async (opcode: number, bytes: Buffer): Promise<void> => {
    if (bytes.length > 125) fail('SSH_PROBE_WS_INVALID');
    const mask = crypto.randomBytes(4), data = Buffer.from(bytes);
    for (let index = 0; index < data.length; index++) data[index] ^= mask[index % 4];
    await new Promise<void>((resolve, reject) => sock.write(
      Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | bytes.length]), mask, data]),
      error => error ? reject(new Error('SSH_PROBE_CLOSED')) : resolve()));
  };
  const banner = (value: string): void => {
    if (value.length > 253 || !/^SSH-(?:2\.0|1\.99)-[!-~][ -~]*$/.test(value)) fail('SSH_PROBE_INVALID');
    steps.push({ event: 'SSH_BANNER_RECEIVED', ok: true, detail: value.slice(0, 48) });
  };
  try {
    await writeSshPayload(sock, request, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))));
    while (true) {
      let first: number;
      try { first = await peek(accepted && !bannerSent ? Math.min(deadline, performance.now() + 2000) : deadline); }
      catch (error) {
        if (!accepted || bannerSent || performance.now() >= deadline ||
          !(error instanceof Error) || error.message !== 'SSH_PROBE_TIMEOUT') throw error;
        // Transport-only identification, never a username, password or authentication request.
        const identification = Buffer.from('SSH-2.0-SXB_Transport_Probe\r\n');
        websocket = advertisedWebsocket;
        if (websocket) await writeFrame(2, identification);
        else await new Promise<void>((resolve, reject) => sock.write(identification,
          error => error ? reject(new Error('SSH_PROBE_CLOSED')) : resolve()));
        bannerSent = true;
        first = await peek();
      }
      if (websocket || accepted && wantsWebsocket && [1, 2, 129, 130, 136, 137, 138].includes(first)) {
        websocket = true;
        if (!bannerSent) {
          await writeFrame(2, Buffer.from('SSH-2.0-SXB_Transport_Probe\r\n'));
          bannerSent = true;
        }
        let prefix = '';
        let fragmented = false;
        for (let frame = 0; frame < 32; frame++) {
          const header = await read(2), opcode = header[0] & 15, fin = (header[0] & 128) !== 0;
          if (header[0] & 112) fail('SSH_PROBE_WS_INVALID');
          let size = header[1] & 127;
          if (size === 126) size = (await read(2)).readUInt16BE();
          else if (size === 127) {
            const wide = (await read(8)).readBigUInt64BE();
            if (wide > 65536n) fail('SSH_PROBE_WS_INVALID');
            size = Number(wide);
          }
          if (size > 65536 || opcode >= 8 && (!fin || size > 125)) fail('SSH_PROBE_WS_INVALID');
          const mask = header[1] & 128 ? await read(4) : undefined;
          const bytes = await read(size);
          if (mask) for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index % 4];
          if (opcode === 8) fail('SSH_PROBE_CLOSED');
          if (opcode === 9) { await writeFrame(10, bytes); continue; }
          if (opcode === 10) continue;
          if (![0, 1, 2].includes(opcode) || opcode === 0 && !fragmented || opcode !== 0 && fragmented) fail('SSH_PROBE_WS_INVALID');
          fragmented = !fin;
          prefix += bytes.toString('latin1');
          if (prefix.length > 8192) fail('SSH_PROBE_HEADERS_TOO_LARGE');
          while (prefix.includes('\n')) {
            const end = prefix.indexOf('\n'), value = prefix.slice(0, end).replace(/\r$/, '');
            prefix = prefix.slice(end + 1);
            if (value.startsWith('SSH-')) { banner(value); return; }
            if (++preambleLines > 32 || /[^\t\r -~]/.test(value) || value.trimStart().startsWith('<')) fail('SSH_PROBE_INVALID');
          }
        }
        fail('SSH_PROBE_WS_INVALID');
      }
      if (first === 83 && (responses === 0 || accepted)) {
        banner(await line(255));
        return;
      }
      if (first !== 72) {
        if (!accepted || first !== 9 && first !== 10 && first !== 13 && (first < 32 || first > 126)) {
          fail(pendingRefusal ? 'SSH_PROBE_HTTP_REFUSED' : 'SSH_PROBE_INVALID');
        }
        const text = await line();
        if (++preambleLines > 32 || (preambleBytes += text.length + 2) > 8192) fail('SSH_PROBE_HEADERS_TOO_LARGE');
        if (text.trimStart().startsWith('<') || /captive|portal|nointernet/i.test(text)) fail('SSH_PROBE_PORTAL');
        if (/^content-length:/i.test(text) && !/^\d+$/.test(text.slice(text.indexOf(':') + 1).trim())) fail('SSH_PROBE_FRAMING_INVALID');
        continue;
      }
      const status = await line();
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(status);
      if (!match && accepted && !status.startsWith('HTTP/')) {
        if (++preambleLines > 32 || (preambleBytes += status.length + 2) > 8192) fail('SSH_PROBE_HEADERS_TOO_LARGE');
        continue;
      }
      if (!match) fail('SSH_PROBE_INVALID');
      if (++responses > 16) fail('SSH_PROBE_TOO_MANY_RESPONSES');
      let headers = status + '\r\n';
      while (true) {
        const value = await line();
        headers += value + '\r\n';
        if (headers.length > 8192) fail('SSH_PROBE_HEADERS_TOO_LARGE');
        if (!value) break;
      }
      const code = Number(match[1]);
      if (code === 101 || code >= 200) answered++;
      const intermediateRefusal = code === 403 && answered < Math.max(1, requests.length) &&
        status.startsWith('HTTP/1.1 ') && !/^connection\s*:[^\r\n]*\bclose\b/im.test(headers) &&
        /^(?:content-length|transfer-encoding)\s*:/im.test(headers);
      accepted = code === 101 || code >= 200 && code < 300;
      const redirect = [301, 302, 303, 307, 308].includes(code);
      const rejected = !accepted && !(code >= 100 && code < 200) && !redirect;
      steps.push({
        event: code === 101 ? 'HTTP_STATUS_101' : accepted ? 'HTTP_STATUS_200' :
          redirect ? 'HTTP_REDIRECT_INTERMEDIATE' : intermediateRefusal ? 'HTTP_METHOD_INTERMEDIATE' : 'HTTP_STATUS_UNEXPECTED',
        ok: accepted || redirect || intermediateRefusal || code >= 100 && code < 200,
        detail: `HTTP ${code}`,
      });
      if (rejected && !intermediateRefusal) fail('SSH_PROBE_HTTP_REFUSED');
      if (/^location:[^\r\n]*(?:captive|portal|nointernet)/im.test(headers)) fail('SSH_PROBE_PORTAL');
      await consumeBody(headers);
      pendingRefusal = rejected;
      advertisedWebsocket = code === 101 && wantsWebsocket && /^upgrade\s*:\s*websocket\s*$/im.test(headers) &&
        /^connection\s*:[^\r\n]*\bupgrade\b/im.test(headers);
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (!/^SSH_PROBE_[A-Z_]+$/.test(code) && !(error instanceof Error && error.name === 'TimeoutError')) throw error;
    steps.push({ event: 'SSH_BANNER_MISSING', ok: false,
      detail: /^SSH_PROBE_[A-Z_]+$/.test(code) ? code : 'SSH_PROBE_TIMEOUT' });
  }
}

// ── Sonde WebSocket des proxys (VLESS / VMess / Trojan) ─────────────────────

/**
 * Chemin réellement demandé par le moteur mobile.
 *
 * Un lien de partage écrit souvent l'early data dans le chemin
 * (`/relais?ed=2048`) : Xray et l'application le retirent avant la requête,
 * le relais ne connaît que `/relais`. Sonder le chemin brut donnait donc un 404
 * trompeur sur un profil qui fonctionne.
 */
export function websocketRequestPath(raw: string): string {
  const value = String(raw || '/');
  const path = value.startsWith('/') ? value : `/${value}`;
  const question = path.indexOf('?');
  if (question < 0) return path;
  const params = path.slice(question + 1).split('&');
  const early = params.find(part => part.split('=')[0].toLowerCase() === 'ed');
  const size = Number(early?.split('=')[1]);
  if (!early || !Number.isInteger(size) || size < 1 || size > 65_535) return path;
  const kept = params.filter(part => !['ed', 'eh'].includes(part.split('=')[0].toLowerCase()) && part !== '');
  const base = path.slice(0, question) || '/';
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

/**
 * Rejoue l'Upgrade WebSocket exactement comme le fera le moteur mobile.
 * L'authentification (UUID, mot de passe) n'est JAMAIS tentée : le dashboard
 * ne s'authentifie pas auprès d'un fournisseur. Seul le transport est jugé.
 *
 * C'est la seule sonde capable de départager les trois noms d'hôte d'un lien
 * VLESS — adresse TCP après « @ », en-tête Host, SNI — dont la confusion est la
 * première cause d'un profil importé « valide » mais inutilisable sur mobile.
 */
async function probeWebsocketUpgrade(
  sock: net.Socket | tls.TLSSocket,
  opts: { path: string; hostHeader: string },
  timeoutMs: number,
  steps: ProbeStep[],
): Promise<number | null> {
  const path = websocketRequestPath(opts.path);
  const request =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${opts.hostHeader}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
    'Sec-WebSocket-Version: 13\r\n' +
    'User-Agent: Mozilla/5.0\r\n' +
    '\r\n';
  sock.write(request);
  const text = (await readUpTo(sock, 8192, timeoutMs, HTTP_HEAD_COMPLETE)).toString('latin1');
  const m = text.match(/^HTTP\/\d\.\d (\d{3})/);
  const code = m ? Number(m[1]) : null;
  const where = `Host: ${opts.hostHeader}, path: ${path}`;
  steps.push(code === 101
    ? { event: 'HTTP_STATUS_101', ok: true, detail: `upgrade accepté (${where})` }
    : { event: 'HTTP_STATUS_UNEXPECTED', ok: false, detail: code ? `code ${code} (${where})` : `réponse non-HTTP/vide (${where})` });
  return code;
}


/**
 * Point d'entrée réellement composé par l'appareil, pour une configuration
 * sing-box (importée telle quelle, ou traduite depuis Xray).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE FONCTION EXISTE
 * ═══════════════════════════════════════════════════════════════════════════
 * Ces configurations ne portent pas `host`/`port` à leur racine : tout est dans
 * `outbounds`, et la sonde les déclarait donc « non applicables ». L'exploitant
 * n'avait aucun moyen de vérifier un profil AVANT de le distribuer — c'est-à-
 * dire précisément la forme que prennent les profils de fournisseur, chaînés
 * derrière un proxy d'opérateur.
 *
 * Ce qu'on sonde, c'est le PREMIER saut : quand la sortie principale possède un
 * `detour`, l'appareil ouvre d'abord sa connexion vers CE maillon, pas vers le
 * serveur final. Sonder le serveur final donnerait un verdict sur une adresse
 * que l'appareil ne compose jamais directement — souvent injoignable depuis un
 * VPS, et donc un faux négatif.
 */
export function pointEntreeSingbox(canonical: Record<string, any>): {
  host: string; port: number; tls: boolean; sni: string;
  network: string; path: string; wsHost: string; insecure: boolean; chaine: boolean;
} | null {
  const sorties = Array.isArray(canonical.outbounds) ? canonical.outbounds : null;
  if (!sorties || sorties.length === 0) return null;
  const parTag = new Map<string, any>();
  for (const o of sorties) {
    const tag = String(o?.tag ?? '').trim();
    if (tag) parTag.set(tag, o);
  }

  const speciaux = new Set(['direct', 'block', 'dns']);
  const principal = String(canonical.route?.final ?? '').trim();
  let courant = parTag.get(principal)
    ?? sorties.find((o: any) => !speciaux.has(String(o?.type ?? '')));
  if (!courant) return null;

  // On suit la chaîne jusqu'au maillon composé en premier. La borne empêche
  // qu'un profil malformé — un détour circulaire — fasse tourner la sonde.
  let chaine = false;
  for (let saut = 0; saut < 8; saut++) {
    const detour = String(courant.detour ?? '').trim();
    if (!detour || !parTag.has(detour)) break;
    courant = parTag.get(detour);
    chaine = true;
  }

  const host = String(courant.server ?? '').trim();
  const port = Number(courant.server_port ?? 0);
  if (!host || !Number.isInteger(port) || port <= 0) return null;

  const tlsObj = courant.tls && typeof courant.tls === 'object' ? courant.tls : null;
  const transport = courant.transport && typeof courant.transport === 'object' ? courant.transport : null;
  return {
    host,
    port,
    tls: tlsObj?.enabled === true,
    sni: String(tlsObj?.server_name ?? host),
    network: String(transport?.type ?? 'tcp').toLowerCase(),
    path: String(transport?.path ?? '/'),
    wsHost: String(transport?.headers?.Host ?? tlsObj?.server_name ?? host),
    insecure: tlsObj?.insecure === true,
    chaine,
  };
}

/**
 * Sonde le point d'entrée d'une configuration sing-box.
 *
 * Trois étapes au plus, et chacune ne s'exécute que si elle a un sens :
 *  • DNS et TCP toujours — c'est ce que l'appareil fait en premier ;
 *  • TLS seulement si le premier saut en présente ;
 *  • l'Upgrade WebSocket seulement si ce premier saut EST le WebSocket, donc
 *    jamais derrière une chaîne : le maillon d'entrée est alors un proxy HTTP
 *    ordinaire, qui ne répondrait pas 101 et dont un 400 ne prouverait rien.
 */
async function probeEntreeSingbox(
  entree: NonNullable<ReturnType<typeof pointEntreeSingbox>>,
  timeoutMs: number,
  steps: ProbeStep[],
  finish: (verdict: ProbeReport['verdict'], hint?: string) => ProbeReport,
): Promise<ProbeReport> {
  const resolved = await resolveAll(entree.host);
  if (resolved.length === 0) {
    steps.push({ event: 'DNS_RESOLVED', ok: false, detail: 'aucune adresse' });
    return finish('unreachable_from_probe',
      'DNS non résolu depuis la sonde — peut être géo/opérateur-restreint ; l\'import reste possible');
  }
  steps.push({ event: 'DNS_RESOLVED', ok: true, detail: `${resolved.length} adresse(s)` });

  const conn = await tcpConnect(entree.host, entree.port, timeoutMs);
  if (!conn) {
    steps.push({ event: 'TCP_CONNECTED', ok: false, detail: `échec ${timeoutMs}ms` });
    return finish('unreachable_from_probe',
      'TCP inaccessible depuis la sonde — serveur éteint, filtré, ou joignable seulement depuis le réseau de l\'opérateur');
  }
  steps.push({ event: 'TCP_CONNECTED', ok: true, detail: `${conn.latencyMs}ms` });
  steps.push({ event: 'LATENCY_MS', ok: true, detail: String(conn.latencyMs) });

  let sock: net.Socket | tls.TLSSocket = conn.sock;
  if (entree.tls) {
    const up = await tlsUpgrade(conn.sock, entree.host, entree.sni, timeoutMs, entree.insecure);
    if ('error' in up) {
      steps.push({ event: 'TLS_FAILED', ok: false, detail: up.error.slice(0, 120) });
      try { conn.sock.destroy(); } catch { /* ignore */ }
      return finish('unreachable_from_probe',
        'handshake TLS impossible — vérifiez que le serveur attend bien TLS sur ce port');
    }
    steps.push({ event: 'TLS_HANDSHAKE_OK', ok: true, detail: up.subject ? `CN=${up.subject}` : 'handshake OK' });
    sock = up.sock;
  }

  // Derrière une chaîne, le premier saut est un proxy d'opérateur : il n'a
  // aucune raison de répondre 101, et le sonder plus loin fabriquerait un
  // échec là où le chemin fonctionne. Ce qu'on a établi — il est joignable —
  // est déjà ce que l'appareil a besoin de savoir en premier.
  if (entree.chaine || (entree.network !== 'ws' && entree.network !== 'websocket')) {
    try { sock.destroy(); } catch { /* ignore */ }
    steps.push({
      event: 'CHAIN_ENTRY_REACHED', ok: true,
      detail: entree.chaine ? 'premier saut de la chaîne joignable' : `transport ${entree.network}`,
    });
    return finish('transport_ok', entree.chaine
      ? 'Premier saut de la chaîne joignable. Les maillons suivants passent par lui et ne sont pas sondables depuis le serveur : testez depuis l’application sur le réseau visé.'
      : undefined);
  }

  const code = await probeWebsocketUpgrade(
    sock, { path: entree.path, hostHeader: entree.wsHost }, timeoutMs, steps,
  );
  try { sock.destroy(); } catch { /* ignore */ }
  if (code === 101) return finish('transport_ok');
  // Jamais « invalid » : un fournisseur peut légitimement masquer son endpoint
  // aux requêtes non authentifiées. On rapporte donc un doute, pas un rejet.
  if (code === null) {
    return finish('unreachable_from_probe',
      'Aucune réponse HTTP à l\'Upgrade WebSocket — le port répond mais ne sert pas ce transport');
  }
  return finish('unreachable_from_probe',
    `Le serveur répond ${code} sur « ${entree.path} » avec l'en-tête Host « ${entree.wsHost} » : ` +
    'vérifiez le path et le host du fournisseur (le SNI et l\'adresse TCP, eux, ont bien répondu)');
}

export async function probeConfig(
  canonical: Record<string, any>,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeReport> {
  const timeoutMs = opts.timeoutMs ?? DEF_TIMEOUT;
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const steps: ProbeStep[] = [];
  const proto = String(canonical.protocol ?? '').toLowerCase();
  const sshTransport = String(canonical.sshTransport ?? '').toLowerCase();
  const effectiveSlowDns = canonical.slowDns === true || sshTransport === 'slowdns';

  const finish = (verdict: ProbeReport['verdict'], hint?: string): ProbeReport => ({
    verdict, steps, latencyMs: steps.find(s => s.event === 'LATENCY_MS') ? Number(steps.find(s => s.event === 'LATENCY_MS')!.detail) : undefined,
    startedAt, durationMs: Date.now() - started, hint,
  });

  // Proxys à transport WebSocket : la chaîne DNS → TCP → TLS(SNI) → Upgrade est
  // celle que rejoue le moteur mobile, donc réellement sondable. Elle était
  // classée « non applicable », ce qui laissait passer sans un mot un profil
  // dont l'en-tête Host ou le path ne correspondait pas au fournisseur.
  const network = String(canonical.network ?? '').toLowerCase();
  const isWsProxy = ['vless', 'vmess', 'trojan'].includes(proto)
    && (network === 'ws' || network === 'websocket');

  // ── sing-box : sonder le PREMIER SAUT, pas la racine du JSON ──────────────
  //
  // Ces configurations n'ont ni `host` ni `port` à la racine : tout vit dans
  // `outbounds`. Elles étaient donc déclarées « non applicables », et
  // l'exploitant n'avait aucun moyen de vérifier un profil avant de le
  // distribuer — alors que c'est exactement la forme des profils de
  // fournisseur, chaînés derrière un proxy d'opérateur.
  if (proto === 'singbox') {
    const entree = pointEntreeSingbox(canonical);
    if (!entree) {
      return finish('unsupported',
        'aucun point d’entrée exploitable dans cette configuration sing-box — validation syntaxique stricte effectuée à l’import');
    }
    return probeEntreeSingbox(entree, timeoutMs, steps, finish);
  }

  // Protocoles non sondables en v1 (validation syntaxique seule, hors transport)
  if (!isWsProxy && ['wireguard', 'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria1', 'hysteria2', 'tuic'].includes(proto)) {
    return finish('unsupported', `sonde transport v1 non applicable à ${proto} — validation syntaxique stricte effectuée à l'import`);
  }
  if (!isWsProxy && proto !== 'ssh' && proto !== 'ssh+payload') {
    return finish('invalid', `protocol inconnu : ${proto}`);
  }

  // SlowDNS (DNSTT) ne peut pas être sondé comme une socket TCP depuis le VPS :
  // le serveur SSH est atteint à travers des requêtes DNS émises depuis le
  // réseau/opérateur du téléphone. Une sonde directe donnerait systématiquement
  // un faux négatif. La syntaxe stricte a déjà été validée à l'import ; le test
  // de transport réel est effectué par le moteur Android.
  if (effectiveSlowDns) {
    steps.push({
      event: 'SLOWDNS_DEVICE_REQUIRED',
      ok: true,
      detail: 'DNSTT nécessite le résolveur et le réseau réels de l’appareil',
    });
    return finish(
      'unsupported',
      'SlowDNS validé syntaxiquement — lancez le test depuis l’application Android sur le réseau cible',
    );
  }

  const host = String(canonical.host ?? '');
  const port = Number(canonical.port ?? 0);
  if (!host || !port) return finish('invalid', 'host/port manquants');
  const explicitProxy = canonical.proxyEnabled === true && String(canonical.proxyHost ?? '').trim();
  const connectHost = explicitProxy ? String(canonical.proxyHost).trim() : host;
  const connectPort = explicitProxy && Number(canonical.proxyPort) > 0
    ? Number(canonical.proxyPort)
    : port;
  const tlsServerName = String(canonical.sni || connectHost);

  // 1. DNS
  const resolved = await resolveAll(connectHost);
  if (resolved.length === 0) {
    steps.push({ event: 'DNS_RESOLVED', ok: false, detail: 'aucune adresse' });
    return finish('unreachable_from_probe', 'DNS non résolu depuis la sonde — peut être géo/opérateur-restreint ; l\'import reste possible en statut unreachable_from_probe');
  }
  steps.push({ event: 'DNS_RESOLVED', ok: true, detail: `${resolved.length} adresse(s)` });

  // 2. TCP (+ latence)
  const conn = await tcpConnect(connectHost, connectPort, timeoutMs);
  if (!conn) {
    steps.push({ event: 'TCP_CONNECTED', ok: false, detail: `échec ${timeoutMs}ms` });
    return finish('unreachable_from_probe', 'TCP inaccessible depuis la sonde — serveur éteint, filtré, ou géo-restreint');
  }
  steps.push({ event: 'TCP_CONNECTED', ok: true, detail: `${conn.latencyMs}ms` });
  steps.push({ event: 'LATENCY_MS', ok: true, detail: String(conn.latencyMs) });

  let sock: net.Socket | tls.TLSSocket = conn.sock;

  // 3. TLS éventuel — `ssh+payload` avec TLS, et `ssh` direct encapsulé dans TLS
  // (« SSL Tunnel »), désormais pris en charge par le moteur mobile.
  if (canonical.tls === true) {
    const up = await tlsUpgrade(
      conn.sock,
      connectHost,
      tlsServerName,
      timeoutMs,
      canonical.insecure === true,
    );
    if ('error' in up) {
      steps.push({ event: 'TLS_FAILED', ok: false, detail: up.error.slice(0, 120) });
      try { conn.sock.destroy(); } catch { /* ignore */ }
      return finish('unreachable_from_probe', 'handshake TLS impossible — vérifiez que le serveur attend bien TLS sur ce port');
    }
    steps.push({ event: 'TLS_HANDSHAKE_OK', ok: true, detail: up.subject ? `CN=${up.subject}` : 'handshake OK' });
    sock = up.sock;
  }

  // 3bis. Proxy WebSocket : Upgrade avec l'en-tête Host et le path du profil.
  if (isWsProxy) {
    const hostHeader = String(canonical.wsHost || canonical.sni || host);
    const code = await probeWebsocketUpgrade(
      sock, { path: String(canonical.path || '/'), hostHeader }, timeoutMs, steps,
    );
    try { sock.destroy(); } catch { /* ignore */ }
    if (code === 101) return finish('transport_ok');
    // Jamais « invalid » : un fournisseur peut légitimement masquer son endpoint
    // aux requêtes non authentifiées. On rapporte donc un doute, pas un rejet.
    if (code === 400 || code === 404) {
      return finish('unreachable_from_probe',
        `Le serveur répond ${code} sur « ${canonical.path || '/'} » avec l'en-tête Host « ${hostHeader} » : ` +
        'vérifiez le path et le paramètre host du fournisseur (le SNI et l\'adresse TCP, eux, ont bien répondu)');
    }
    if (code === null) {
      return finish('unreachable_from_probe',
        'Aucune réponse HTTP à l\'Upgrade WebSocket — le port répond mais ne sert pas ce transport');
    }
    return finish('unreachable_from_probe',
      `Le serveur répond ${code} au lieu de 101 — endpoint possiblement masqué aux requêtes non authentifiées, ` +
      'ou path/Host incorrects');
  }

  // 4a. SSH direct : bannière obligatoire (en clair, ou dans le tunnel TLS
  // quand le profil active le « SSL Tunnel »).
  if (proto === 'ssh') {
    const buf = await readUpTo(sock, 512, Math.min(timeoutMs, 8000));
    const m = buf.toString('latin1').match(/SSH-[0-9A-Za-z.\-_ ]+/);
    if (m) {
      steps.push({
        event: 'SSH_BANNER_RECEIVED',
        ok: true,
        detail: (canonical.tls === true ? 'dans le tunnel TLS : ' : '') + m[0].slice(0, 48),
      });
      try { sock.destroy(); } catch { /* ignore */ }
      return finish('transport_ok');
    }
    const dansTls = canonical.tls === true;
    steps.push({
      event: 'SSH_BANNER_MISSING',
      ok: false,
      detail: dansTls
        ? 'handshake TLS réussi mais aucun flux SSH derrière — ce port sert probablement autre chose'
        : 'aucune bannière SSH- en clair (le serveur attend probablement TLS ou WebSocket)',
    });
    try { sock.destroy(); } catch { /* ignore */ }
    return finish('unreachable_from_probe',
      dansTls
        ? 'TLS établi, mais rien de SSH derrière : vérifiez le port, ou passez en ssh+payload si le fournisseur impose un en-tête HTTP'
        : 'Pas de bannière SSH en clair : activez TLS sur le profil (SSL Tunnel), ou importez en ssh+payload avec le payload du fournisseur');
  }

  // 4b. SSH+Payload : substitutions → envoi → 101/200 → flux SSH
  const payloadTpl = String(canonical.payload ?? 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]');
  const payload = substitutePayload(payloadTpl, host, tlsServerName, port,
    typeof canonical.userAgent === 'string' && canonical.userAgent.trim() ? canonical.userAgent.trim() : DEFAULT_SSH_USER_AGENT);
  try {
    await probeWsTunnel(sock, payload, timeoutMs, steps);
  } finally {
    try { sock.destroy(); } catch { /* ignore */ }
  }
  const okAll = steps.some(s => s.event === 'SSH_BANNER_RECEIVED' && s.ok);
  if (!okAll && payload.trimStart().toUpperCase().startsWith('CONNECT ')) {
    return finish(
      'unsupported',
      'Payload CONNECT non prouvé depuis ce serveur. L’application conserve le transport déclaré, sans ajouter de TLS ; vérifiez sur le réseau de l’appareil.',
    );
  }
  return finish(okAll ? 'transport_ok' : 'unreachable_from_probe',
    okAll ? undefined : 'Le payload n\'a pas abouti à un flux SSH — vérifiez le payload exact du fournisseur (Host, path, en-têtes)');
}

// ── Verdict d'import consolidé (syntaxe + transport) → validationStatus DB ───
export function statusFromProbe(report: ProbeReport): 'transport_ok' | 'invalid' | 'unreachable_from_probe' | 'unsupported' | 'unknown' {
  switch (report.verdict) {
    case 'transport_ok': return 'transport_ok';
    case 'invalid': return 'invalid';
    case 'unreachable_from_probe': return 'unreachable_from_probe';
    case 'unsupported': return 'unsupported';
    default: return 'unknown';
  }
}

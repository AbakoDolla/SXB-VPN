import { createHash, generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Socket } from 'node:net';
import { Transform } from 'node:stream';
import { Client, Server as SshServer, type Connection } from 'ssh2';
import { SSH_RELAY_PATH, openRelayUpstream, type RelayUpstream } from './ssh-relay-transport';

export interface RelayGrant {
  clientId: string;
  upstream: RelayUpstream;
  expiresAt: number;
  revalidate(): Promise<boolean>;
  account(upload: number, download: number): Promise<void>;
}
export interface RelayDependencies {
  authorize(request: IncomingMessage): Promise<RelayGrant>;
  open?: typeof openRelayUpstream;
  leaseMs?: number;
}

/** Never listens on another port. Only authenticated TLS-proxied HTTP upgrades enter. */
export function installSshRelay(server: HttpServer, deps: RelayDependencies) {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs1', format: 'pem' });
  const active = new Set<() => void>();
  const clients = new Map<string, number>();
  const peers = new Map<string, number>();
  server.on('close', () => { for (const close of active) close(); });
  server.on('upgrade', (request, socket, head) => {
    if (!(socket instanceof Socket) || request.url?.split('?')[0] !== SSH_RELAY_PATH || request.method !== 'GET' ||
        request.headers.upgrade?.toLowerCase() !== 'sxb-ssh-relay' || head.length ||
        request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // This is normally the reverse proxy. Limit only unauthenticated handshakes
    // here; authenticated capacity is scoped by client, not a forged forwarded IP.
    const peer = request.socket.remoteAddress || 'unknown';
    if (active.size >= 128 || (peers.get(peer) || 0) >= 32) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    peers.set(peer, (peers.get(peer) || 0) + 1);
    const abort = new AbortController();
    const upstream = new Client();
    const sshServer = new SshServer({ hostKeys: [hostKey], ident: 'SXB-Relay', banner: '' });
    let incoming: Connection | undefined, clientId: string | undefined, upgraded = false, closed = false;
    let pendingPeer = true;
    const releasePeer = () => {
      if (!pendingPeer) return;
      pendingPeer = false;
      const count = (peers.get(peer) || 1) - 1;
      if (count) peers.set(peer, count); else peers.delete(peer);
    };
    let lease: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const handshake = setTimeout(() => close(), 20000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshake); clearTimeout(lease); clearTimeout(expiry);
      abort.abort();
      upstream.destroy(); incoming?.end(); socket.destroy();
      active.delete(close);
      if (clientId) {
        const count = (clients.get(clientId) || 1) - 1;
        if (count) clients.set(clientId, count); else clients.delete(clientId);
      }
      releasePeer();
    };
    const fail = () => {
      if (closed) return;
      console.warn('[SSH_RELAY] CONNECTION_REFUSED');
      if (!upgraded) socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      close();
    };
    active.add(close);
    socket.on('error', close); socket.on('close', close);
    upstream.on('error', fail); upstream.on('close', close);
    socket.pause();
    void (async () => {
      const grant = await deps.authorize(request);
      if (closed) return;
      releasePeer();
      if ((clients.get(grant.clientId) || 0) >= 2 || grant.expiresAt <= Date.now()) throw new Error('RELAY_LIMIT');
      clientId = grant.clientId;
      clients.set(clientId, (clients.get(clientId) || 0) + 1);
      const transport = await (deps.open || openRelayUpstream)(grant.upstream, abort.signal);
      if (closed) { transport.destroy(); return; }
      const expected = Buffer.from(grant.upstream.fingerprint.slice(7), 'base64');
      upstream.once('ready', () => {
        if (closed) return;
        upgraded = true;
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: sxb-ssh-relay\r\n\r\n');
        sshServer.once('connection', connection => {
          incoming = connection;
          connection.on('error', close);
          connection.on('close', close);
          connection.on('authentication', auth => {
            if (auth.method === 'none' && auth.username === 'sxb') auth.accept();
            else auth.reject();
          });
          connection.on('ready', () => {
            clearTimeout(handshake);
            let channels = 0;
            connection.on('tcpip', (accept, reject, destination) => {
              if (closed || ++channels > 64 || !destination.destIP || destination.destIP.length > 253 ||
                  !Number.isInteger(destination.destPort) || destination.destPort < 1 || destination.destPort > 65535) {
                channels--; reject(); return;
              }
              const udp = destination.destIP === 'sxb-udpgw';
              if (udp && (!grant.upstream.udpHost || !grant.upstream.udpPort || destination.destPort !== 7300)) {
                channels--; reject(); return;
              }
              upstream.forwardOut('127.0.0.1', 0, udp ? grant.upstream.udpHost! : destination.destIP,
                udp ? grant.upstream.udpPort! : destination.destPort, (error, remote) => {
                  if (error || closed) { channels--; if (remote) remote.destroy(); reject(); return; }
                  const local = accept();
                  if (!local) { channels--; remote.destroy(); return; }
                  let released = false;
                  let remoteClosed = false, localClosed = false, drained = false, uploadDrained = false;
                  const release = () => {
                    if (!released && localClosed && remoteClosed) { released = true; channels--; }
                  };
                  local.on('error', () => remote.destroy()); remote.on('error', () => local.destroy());
                  const metered = (upload: boolean) => new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                      if (closed) { callback(new Error('RELAY_CLOSED')); return; }
                      void bounded(grant.account(upload ? chunk.length : 0, upload ? 0 : chunk.length), 10000)
                        .then(() => callback(closed ? new Error('RELAY_CLOSED') : null, chunk))
                        .catch(error => { callback(error); fail(); });
                    },
                  });
                  const up = metered(true), down = metered(false);
                  up.on('error', close); down.on('error', close);
                  local.on('close', () => {
                    localClosed = true; release(); down.destroy();
                    if (uploadDrained) remote.close();
                  });
                  remote.on('close', () => {
                    remoteClosed = true; release();
                    if (drained) local.close();
                  });
                  local.pipe(up).pipe(remote, { end: false });
                  up.on('end', () => remote.write(Buffer.alloc(0), err => {
                    if (err) { remote.destroy(); return; }
                    uploadDrained = true; remote.eof();
                    if (localClosed) remote.close();
                  }));
                  // ssh2 server streams send CLOSE on end(); preserve a remote half-close.
                  remote.pipe(down).pipe(local, { end: false });
                  down.on('end', () => local.write(Buffer.alloc(0), err => {
                    if (err) { local.destroy(); return; }
                    drained = true; local.eof();
                    if (remoteClosed) local.close();
                  }));
                });
            });
          });
        });
        sshServer.injectSocket(socket);
        socket.resume();
        expiry = setTimeout(close, Math.min(2147483647, grant.expiresAt - Date.now()));
        const renew = async () => {
          try {
            if (closed) return;
            if (!await bounded(grant.revalidate(), 10000)) { fail(); return; }
            if (!closed) lease = setTimeout(() => void renew(), deps.leaseMs ?? 30000);
          } catch { fail(); }
        };
        lease = setTimeout(() => void renew(), deps.leaseMs ?? 30000);
      });
      upstream.connect({
        sock: transport, host: grant.upstream.host, port: grant.upstream.port,
        username: grant.upstream.username, password: grant.upstream.password,
        privateKey: grant.upstream.privateKey, passphrase: grant.upstream.passphrase,
        readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
        hostVerifier: (publicKey: Buffer) => {
          const actual = createHash('sha256').update(publicKey).digest();
          return actual.length === expected.length && timingSafeEqual(actual, expected);
        },
      });
    })().catch(fail);
  });
  return { close: () => { for (const close of active) close(); }, activeCount: () => active.size };
}

async function bounded<T>(operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('RELAY_AUTHORITY_TIMEOUT')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

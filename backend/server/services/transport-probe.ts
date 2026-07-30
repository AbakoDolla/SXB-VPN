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

// ── Substitution du payload (SSH+Payload) ────────────────────────────────────
export function substitutePayload(template: string, host: string, sni?: string | null): string {
  const effectiveHost = (sni && sni.trim()) || host;
  return template
    .replace(/\[crlf\]/gi, '\r\n')
    .replace(/\[host\]/gi, effectiveHost)
    .replace(/\[ua\]/gi, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    .replace(/\[host_header\]/gi, effectiveHost);
}

// ── Lecture bornée d'un préfixe de flux ──────────────────────────────────────
function readUpTo(sock: net.Socket | tls.TLSSocket, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(done, timeoutMs);
    const onData = (b: Buffer) => {
      chunks.push(b); total += b.length;
      if (total >= maxBytes) done();
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
  plain: net.Socket, host: string, sni: string | undefined, timeoutMs: number,
): Promise<{ sock: tls.TLSSocket; subject?: string; issuer?: string } | { error: string }> {
  return new Promise((resolve) => {
    const s = tls.connect({
      socket: plain,
      servername: sni || host,
      rejectUnauthorized: false,   // sonde informatique — on rapporte le cert, on n'authentifie pas la chaîne
      ALPNProtocols: ['http/1.1'],
      timeout: timeoutMs,
      servernameCallback: undefined as any,
    });
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
  host: string,
  timeoutMs: number,
  steps: ProbeStep[],
): Promise<void> {
  const hasUpgrade = /upgrade:\s*websocket/i.test(payload);
  let request = payload;
  if (hasUpgrade && !/sec-websocket-key/i.test(payload)) {
    // Compléter un handshake WS incomplet avec une clé aléatoire jetable
    request = payload.replace(/(\r\n)(\r\n)/,
      `\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n$2`);
  }
  sock.write(request);
  const head = await readUpTo(sock, 8192, timeoutMs);
  const text = head.toString('latin1');
  const statusMatch = text.match(/^HTTP\/\d\.\d (\d{3})/);
  const code = statusMatch ? Number(statusMatch[1]) : null;

  if (code === 101) steps.push({ event: 'HTTP_STATUS_101', ok: true, detail: 'upgrade accepté' });
  else if (code === 200) steps.push({ event: 'HTTP_STATUS_200', ok: true, detail: 'tunnel HTTP accepté' });
  else steps.push({ event: 'HTTP_STATUS_UNEXPECTED', ok: false, detail: code ? `code ${code}` : 'réponse non-HTTP/vide' });

  if (code === 101 || code === 200) {
    // Le flux sous-jacent doit devenir SSH : chercher 'SSH-' (frames WS incluses)
    const m = text.match(/SSH-[0-9A-Za-z.\-_ ]+/);
    if (m) {
      steps.push({ event: 'SSH_BANNER_RECEIVED', ok: true, detail: `derrière tunnel : ${m[0].slice(0, 48)}` });
    } else {
      const more = await readUpTo(sock, 8192, Math.min(timeoutMs, 5000));
      const m2 = more.toString('latin1').match(/SSH-[0-9A-Za-z.\-_ ]+/);
      steps.push(m2
        ? { event: 'SSH_BANNER_RECEIVED', ok: true, detail: `derrière tunnel : ${m2[0].slice(0, 48)}` }
        : { event: 'SSH_BANNER_MISSING', ok: false, detail: 'tunnel ouvert mais aucun flux SSH détecté (8s)' });
    }
  }
}

// ── Sonde principale ─────────────────────────────────────────────────────────

export async function probeConfig(
  canonical: Record<string, any>,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeReport> {
  const timeoutMs = opts.timeoutMs ?? DEF_TIMEOUT;
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const steps: ProbeStep[] = [];
  const proto = String(canonical.protocol ?? '').toLowerCase();

  const finish = (verdict: ProbeReport['verdict'], hint?: string): ProbeReport => ({
    verdict, steps, latencyMs: steps.find(s => s.event === 'LATENCY_MS') ? Number(steps.find(s => s.event === 'LATENCY_MS')!.detail) : undefined,
    startedAt, durationMs: Date.now() - started, hint,
  });

  // Protocoles non sondables en v1 (validation syntaxique seule, hors transport)
  if (['wireguard', 'shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'singbox'].includes(proto)) {
    return finish('unsupported', `sonde transport v1 non applicable à ${proto} — validation syntaxique stricte effectuée à l'import`);
  }
  if (proto !== 'ssh' && proto !== 'ssh+payload') {
    return finish('invalid', `protocol inconnu : ${proto}`);
  }
  if (proto === 'ssh' && canonical.tls === true) {
    return finish('invalid', 'ssh direct + tls=true : le moteur ignore TLS — corrigez le profil (ssh+payload ou tls=false) avant tout test');
  }

  const host = String(canonical.host ?? '');
  const port = Number(canonical.port ?? 0);
  if (!host || !port) return finish('invalid', 'host/port manquants');

  // 1. DNS
  const resolved = await resolveAll(host);
  if (resolved.length === 0) {
    steps.push({ event: 'DNS_RESOLVED', ok: false, detail: 'aucune adresse' });
    return finish('unreachable_from_probe', 'DNS non résolu depuis la sonde — peut être géo/opérateur-restreint ; l\'import reste possible en statut unreachable_from_probe');
  }
  steps.push({ event: 'DNS_RESOLVED', ok: true, detail: `${resolved.length} adresse(s)` });

  // 2. TCP (+ latence)
  const conn = await tcpConnect(host, port, timeoutMs);
  if (!conn) {
    steps.push({ event: 'TCP_CONNECTED', ok: false, detail: `échec ${timeoutMs}ms` });
    return finish('unreachable_from_probe', 'TCP inaccessible depuis la sonde — serveur éteint, filtré, ou géo-restreint');
  }
  steps.push({ event: 'TCP_CONNECTED', ok: true, detail: `${conn.latencyMs}ms` });
  steps.push({ event: 'LATENCY_MS', ok: true, detail: String(conn.latencyMs) });

  let sock: net.Socket | tls.TLSSocket = conn.sock;

  // 3. TLS éventuel (ssh+payload TLS ; ssh direct TLS a déjà été rejeté)
  if (canonical.tls === true) {
    const up = await tlsUpgrade(conn.sock, host, canonical.sni || undefined, timeoutMs);
    if ('error' in up) {
      steps.push({ event: 'TLS_FAILED', ok: false, detail: up.error.slice(0, 120) });
      try { conn.sock.destroy(); } catch { /* ignore */ }
      return finish('unreachable_from_probe', 'handshake TLS impossible — vérifiez que le serveur attend bien TLS sur ce port');
    }
    steps.push({ event: 'TLS_HANDSHAKE_OK', ok: true, detail: up.subject ? `CN=${up.subject}` : 'handshake OK' });
    sock = up.sock;
  }

  // 4a. SSH direct : bannière obligatoire
  if (proto === 'ssh') {
    const buf = await readUpTo(sock, 512, Math.min(timeoutMs, 8000));
    const m = buf.toString('latin1').match(/SSH-[0-9A-Za-z.\-_ ]+/);
    if (m) {
      steps.push({ event: 'SSH_BANNER_RECEIVED', ok: true, detail: m[0].slice(0, 48) });
      try { sock.destroy(); } catch { /* ignore */ }
      return finish('transport_ok');
    }
    steps.push({ event: 'SSH_BANNER_MISSING', ok: false, detail: 'aucune bannière SSH- en clair (le serveur attend probablement TLS ou WebSocket)' });
    try { sock.destroy(); } catch { /* ignore */ }
    return finish('unreachable_from_probe',
      'Pas de bannière SSH en clair : si le serveur exige WS/TLS, importez en ssh+payload avec le payload du fournisseur');
  }

  // 4b. SSH+Payload : substitutions → envoi → 101/200 → flux SSH
  const payloadTpl = String(canonical.payload ?? 'GET / HTTP/1.1[crlf]Host: [host][crlf]Upgrade: websocket[crlf]Connection: Upgrade[crlf][crlf]');
  const payload = substitutePayload(payloadTpl, host, canonical.sni);
  try {
    await probeWsTunnel(sock, payload, host, timeoutMs, steps);
  } finally {
    try { sock.destroy(); } catch { /* ignore */ }
  }
  const okAll = steps.some(s => s.event === 'SSH_BANNER_RECEIVED' && s.ok);
  return finish(okAll ? 'transport_ok' : 'unreachable_from_probe',
    okAll ? undefined : 'Le payload n\'a pas abouti à un flux SSH — vérifiez le payload exact du fournisseur (Host, path, en-têtes)');
}

// ── Verdict d'import consolidé (syntaxe + transport) → validationStatus DB ───
export function statusFromProbe(report: ProbeReport): 'valid' | 'invalid' | 'unreachable_from_probe' | 'unknown' {
  switch (report.verdict) {
    case 'transport_ok': return 'valid';
    case 'invalid': return 'invalid';
    case 'unreachable_from_probe': return 'unreachable_from_probe';
    default: return 'unknown';
  }
}

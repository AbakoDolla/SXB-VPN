/**
 * secureLogger.ts — Logger sécurisé côté React Native / TypeScript
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * RÈGLES DE SÉCURITÉ
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * EN PRODUCTION (__DEV__ === false) :
 *   — Tous les appels sont des no-ops. Aucun log ne sort.
 *   — Aucune donnée sensible (host, port, UUID, token, clé) n'est jamais
 *     transmise à console.log / console.warn / console.error.
 *
 * EN DÉVELOPPEMENT (__DEV__ === true) :
 *   — Les logs passent mais les champs sensibles sont masqués.
 *   — Utiliser les méthodes typées (vpn.*, auth.*, api.*) plutôt que log.debug
 *     pour éviter les fuites accidentelles.
 *
 * NE JAMAIS appeler console.log/warn/error directement dans le code VPN.
 * NE JAMAIS passer host, port, uuid, password, token comme argument de log.
 *
 * UTILISATION :
 *   import { slog } from '@/services/secureLogger';
 *   slog.vpn.connected();
 *   slog.api.error('/endpoint', err);    // masque l'URL automatiquement
 *   slog.debug('message safe');          // no-op en prod
 */

// ── Patterns de masquage (debug uniquement) ───────────────────────────────────

const MASK_PATTERNS: Array<[RegExp, string]> = [
  // IPv4 + port optionnel
  [/(\d{1,3}\.){3}\d{1,3}(:\d+)?/g,                        '[ip:****]'],
  // IPv6
  [/[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}/g,           '[ipv6:****]'],
  // UUID
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[uuid:****]'],
  // password=, key=, token=, secret=, uuid=
  [/(password|passwd|key|token|secret|uuid|user)[=:\s]+\S+/gi, '$1=[****]'],
  // Base64 longue (clés, blobs chiffrés)
  [/[A-Za-z0-9+/]{20,}={0,2}/g,                            '[b64:****]'],
  // Hostname apparent (domain.tld ou sous-domaine)
  [/([a-zA-Z0-9-]{2,63}\.){1,3}[a-zA-Z]{2,6}(:\d+)?(\/\S*)?/g, '[host:****]'],
  // Bearer token dans Authorization header
  [/Bearer\s+\S+/gi,                                        'Bearer [****]'],
];

function mask(value: unknown): string {
  if (typeof value !== 'string') {
    try { return mask(JSON.stringify(value)); } catch { return '[object]'; }
  }
  let result = value;
  for (const [pattern, replacement] of MASK_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Codes d'événements opaques (miroir de VpnEvent.kt) ───────────────────────
// Ces codes ne révèlent rien de l'infrastructure en cas de fuite de logs.

const VPN_EVENTS = {
  CONNECTING:    'E10',
  CONNECTED:     'E11',
  DISCONNECTED:  'E12',
  FAILED:        'E13',
  TIMEOUT:       'E14',
  KILLSWITCH_ON: 'E40',
  KILLSWITCH_OFF:'E41',
  CONFIG_LOADED: 'E30',
  CONFIG_STALE:  'E31',
  PROVISION_OK:  'E32',
  PROVISION_FAIL:'E33',
} as const;

const AUTH_EVENTS = {
  LOGIN:         'A01',
  LOGOUT:        'A02',
  TOKEN_REFRESH: 'A03',
  TOKEN_EXPIRED: 'A04',
  ERROR:         'A05',
} as const;

// ── Logger principal ──────────────────────────────────────────────────────────

const IS_DEV = __DEV__;

export const slog = {

  // ── VPN ────────────────────────────────────────────────────────────────────
  vpn: {
    connecting: ()            => IS_DEV && console.info(`[SXB] ${VPN_EVENTS.CONNECTING}`),
    connected:  (ms?: number) => IS_DEV && console.info(`[SXB] ${VPN_EVENTS.CONNECTED}${ms != null ? ` t=${ms}ms` : ''}`),
    disconnected:(reason?: string) => IS_DEV && console.warn(`[SXB] ${VPN_EVENTS.DISCONNECTED}${reason ? ` — ${mask(reason)}` : ''}`),
    failed:     (err?: Error)  => IS_DEV && console.error(`[SXB] ${VPN_EVENTS.FAILED}`, err?.name ?? ''),
    timeout:    ()             => IS_DEV && console.warn(`[SXB] ${VPN_EVENTS.TIMEOUT}`),
    killswitch: (on: boolean)  => IS_DEV && console.info(`[SXB] ${on ? VPN_EVENTS.KILLSWITCH_ON : VPN_EVENTS.KILLSWITCH_OFF}`),
  },

  // ── Config / Provision ─────────────────────────────────────────────────────
  config: {
    loaded:  (protocol?: string) => IS_DEV && console.info(`[SXB] ${VPN_EVENTS.CONFIG_LOADED} proto=${protocol ?? '?'}`),
    stale:   (reason?: string)   => IS_DEV && console.warn(`[SXB] ${VPN_EVENTS.CONFIG_STALE} ${reason ?? ''}`),
    provisionOk:  ()             => IS_DEV && console.info(`[SXB] ${VPN_EVENTS.PROVISION_OK}`),
    provisionFail:(err?: Error)  => IS_DEV && console.warn(`[SXB] ${VPN_EVENTS.PROVISION_FAIL}`, err?.name ?? ''),
  },

  // ── Auth ───────────────────────────────────────────────────────────────────
  auth: {
    login:        ()            => IS_DEV && console.info(`[SXB] ${AUTH_EVENTS.LOGIN}`),
    logout:       ()            => IS_DEV && console.info(`[SXB] ${AUTH_EVENTS.LOGOUT}`),
    tokenRefresh: ()            => IS_DEV && console.info(`[SXB] ${AUTH_EVENTS.TOKEN_REFRESH}`),
    tokenExpired: ()            => IS_DEV && console.warn(`[SXB] ${AUTH_EVENTS.TOKEN_EXPIRED}`),
    error:        (err?: Error) => IS_DEV && console.error(`[SXB] ${AUTH_EVENTS.ERROR}`, err?.name ?? ''),
  },

  // ── API calls ──────────────────────────────────────────────────────────────
  // IMPORTANT : ne jamais passer l'URL complète ni le corps de la requête.
  api: {
    /** Loguer uniquement la méthode et le code de statut — jamais l'URL complète. */
    response: (method: string, status: number, ms?: number) =>
      IS_DEV && console.debug(`[SXB] API ${method} ${status}${ms != null ? ` ${ms}ms` : ''}`),
    error: (method: string, status?: number) =>
      IS_DEV && console.warn(`[SXB] API_ERR ${method} ${status ?? '?'}`),
  },

  // ── Debug libre — no-op en prod ────────────────────────────────────────────
  /**
   * Log debug générique. Masquage automatique appliqué.
   * Complètement silencieux en production.
   * Éviter de passer des objets de config VPN ici.
   */
  debug: (message: string, ...args: unknown[]) => {
    if (!IS_DEV) return;
    console.debug(`[SXB] ${mask(message)}`, ...args.map(a => mask(String(a))));
  },

  warn: (message: string) => {
    if (!IS_DEV) return;
    console.warn(`[SXB] ${mask(message)}`);
  },

  error: (message: string, err?: Error) => {
    if (!IS_DEV) return;
    console.error(`[SXB] ${mask(message)}`, err?.name ?? '');
  },
};

// ── Compatibilité legacy — remplace addLog('[SXB_DEBUG]...') ─────────────────
/**
 * Remplace les anciens appels addLog('[SXB_DEBUG] ...') dans VpnContext.
 * Utiliser slog.* en priorité pour les nouveaux développements.
 * En production : no-op total.
 */
export function legacyDebugLog(message: string): void {
  if (!IS_DEV) return;
  // Supprimer le préfixe [SXB_DEBUG] pour uniformiser le format
  const clean = message.replace(/^\[SXB_DEBUG\]\s*/, '');
  console.debug(`[SXB] ${mask(clean)}`);
}

export default slog;

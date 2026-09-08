/// client.ts — Client HTTP partagé pour toutes les vraies requêtes
/// vers le backend Express (/api/*). Injecte le token JWT, gère le
/// rafraîchissement automatique en cas d'expiration, et normalise les
/// erreurs.

// Base URL — utilise /xapi (proxifié par Vite → vpnsxb.afrihall.com/api)
// On évite /api/* car l'artifact api-server Replit l'intercepte en priorité.
import { ResellerAccessSummary } from "../types";
import { getLanguage } from "../lib/language";
import { apiErrorMessage } from "../lib/errors";

const API_BASE = "/xapi";

const ACCESS_TOKEN_KEY = "sxb_access_token";
const REFRESH_TOKEN_KEY = "sxb_refresh_token";

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

class ApiError extends Error {
  status: number;
  responseData?: any;
  /** Code stable du serveur (`data.code`) ou, à défaut, sa clé i18n. */
  code?: string;
  /** Clé i18n brute (`data.error`), conservée séparément du code stable. */
  errorKey?: string;
  /** Contrat d'accès revendeur porté par les refus (validité + plafond). */
  resellerAccess?: ResellerAccessSummary;
  retryAfterSeconds?: number;
  constructor(
    message: string,
    status: number,
    code?: string,
    responseData?: any,
    extra?: { errorKey?: string; resellerAccess?: ResellerAccessSummary; retryAfterSeconds?: number }
  ) {
    super(message);
    this.status = status;
    this.responseData = responseData ?? (message ? { message } : undefined);
    this.code = code;
    this.errorKey = extra?.errorKey;
    this.resellerAccess = extra?.resellerAccess;
    this.retryAfterSeconds = extra?.retryAfterSeconds;
    Object.defineProperty(this, "message", {
      configurable: true,
      get: () => apiErrorMessage(this.responseData, this.status, getLanguage(), this.code ?? this.errorKey, this.retryAfterSeconds),
    });
  }
}

/**
 * Diffusion centrale de l'état d'accès revendeur.
 *
 * Le serveur joint `resellerAccess` à ses refus ET à ses indicateurs. Chaque
 * écran traitait ces refus comme un échec générique : l'exploitant voyait
 * « Erreur 403 » sans jamais apprendre que son agrément avait expiré. L'état
 * est désormais republié ici, à chaque réponse qui le porte, pour que
 * l'interface se mette à jour SANS rechargement ni redirection — la session
 * reste valide, c'est l'agrément qui ne l'est plus.
 */
type ResellerAccessListener = (access: ResellerAccessSummary, code?: string) => void;
const resellerAccessListeners = new Set<ResellerAccessListener>();

export function subscribeResellerAccess(listener: ResellerAccessListener): () => void {
  resellerAccessListeners.add(listener);
  return () => { resellerAccessListeners.delete(listener); };
}

function looksLikeAccessSummary(value: any): value is ResellerAccessSummary {
  return !!value && typeof value === "object" && typeof value.accessState === "string" && typeof value.quotaState === "string";
}

function publishResellerAccess(data: any, code?: string) {
  const access = data?.resellerAccess;
  if (!looksLikeAccessSummary(access)) return;
  resellerAccessListeners.forEach((listener) => {
    try { listener(access, code); } catch { /* un abonné défaillant n'interrompt pas les autres */ }
  });
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * Ramène l'utilisateur à l'écran de connexion après la perte d'une session.
 *
 * BOUCLE CORRIGÉE — cette fonction rechargeait la page dès qu'une réponse 401
 * arrivait, y compris au tout premier appel d'un visiteur non connecté. Or
 * l'application est servie à la racine et n'a pas de route « /login » : la
 * condition `pathname !== "/login"` était donc toujours vraie. Chargement →
 * 401 → rechargement → 401… le dashboard restait bloqué sur « Initialisation… »
 * et devenait inaccessible.
 *
 * Le rechargement n'a de sens que si une session existait VRAIMENT : sans
 * jeton, il n'y a rien à invalider, et le composant racine sait déjà afficher
 * le formulaire de connexion.
 */
function forceLoginRedirect() {
  const hadSession = typeof window !== "undefined" && !!getAccessToken();
  clearTokens();
  if (hadSession && typeof window !== "undefined") {
    window.location.assign("/");
  }
}

async function tryRefreshToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": getLanguage() },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) return false;
        if (!res.ok) {
          if (res.status === 429) throw rateLimitError(res);
          throw new ApiError("", res.status, "SESSION_REFRESH_UNAVAILABLE");
        }
        const data = await res.json();
        setTokens(data.accessToken, data.refreshToken);
        return true;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  skipAuth?: boolean;
  headers?: Record<string, string>;
}

function rateLimitError(response: Response, data?: unknown): ApiError {
  const header = response.headers.get("Retry-After");
  const seconds = header !== null && /^\d+$/.test(header.trim())
    ? Number(header)
    : header ? Math.ceil((Date.parse(header) - Date.now()) / 1000) : Number.NaN;
  const bodyDelay = data && typeof data === "object" && "retryAfterSeconds" in data
    ? data.retryAfterSeconds
    : undefined;
  const delay = Number.isFinite(seconds) ? Math.max(0, seconds) : bodyDelay;
  const retryAfterSeconds = typeof delay === "number" && Number.isFinite(delay) && delay >= 0
    ? Math.ceil(delay)
    : undefined;
  return new ApiError(
    "",
    429,
    "RATE_LIMITED",
    data,
    { errorKey: "errors.rate_limit", retryAfterSeconds }
  );
}

/// Effectue une vraie requête HTTP vers le backend. Rafraîchit
/// automatiquement le token une fois si la première tentative échoue
/// avec 401 (token expiré), puis réessaie une seule fois.
export async function apiRequest<T>(path: string, options: RequestOptions = {}, _isRetry = false): Promise<T> {
  const { method = "GET", body, skipAuth = false } = options;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!["authorization", "content-type", "accept-language"].includes(name.toLowerCase())) headers[name] = value;
  }
  headers["Content-Type"] = "application/json";
  headers["Accept-Language"] = getLanguage();
  if (!skipAuth) {
    const token = getAccessToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !skipAuth && !_isRetry) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      return apiRequest<T>(path, options, true);
    }
    forceLoginRedirect();
    throw new ApiError("", 401, "session_expired");
  }

  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    if (res.status === 429) throw rateLimitError(res, data);
    // Un refus d'agrément (expiré, suspendu, plafond atteint) n'est PAS une
    // perte de session : la déconnexion forcée reste réservée au 401 et à la
    // suspension du compte lui-même. Confondre les deux renvoyait le revendeur
    // sur l'écran de connexion, où plus rien n'expliquait le refus.
    if (!skipAuth && (res.status === 401 || (res.status === 403 && data?.error === "errors.auth.suspended"))) {
      forceLoginRedirect();
    }
    publishResellerAccess(data, data?.code);
    throw new ApiError("", res.status, data?.code ?? data?.error, data, {
      errorKey: data?.error,
      resellerAccess: looksLikeAccessSummary(data?.resellerAccess) ? data.resellerAccess : undefined,
    });
  }

  publishResellerAccess(data);
  return data as T;
}

export { ApiError };

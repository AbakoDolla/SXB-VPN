/// client.ts — Client HTTP partagé pour toutes les vraies requêtes
/// vers le backend Express (/api/*). Injecte le token JWT, gère le
/// rafraîchissement automatique en cas d'expiration, et normalise les
/// erreurs.

// Base URL — utilise /xapi (proxifié par Vite → vpnsxb.afrihall.com/api)
// On évite /api/* car l'artifact api-server Replit l'intercepte en priorité.
import { ResellerAccessSummary } from "../types";

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
  constructor(
    message: string,
    status: number,
    code?: string,
    responseData?: any,
    extra?: { errorKey?: string; resellerAccess?: ResellerAccessSummary }
  ) {
    super(message);
    this.status = status;
    this.responseData = responseData;
    this.code = code;
    this.errorKey = extra?.errorKey;
    this.resellerAccess = extra?.resellerAccess;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = await res.json();
        setTokens(data.accessToken, data.refreshToken);
        return true;
      })
      .catch(() => false)
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
}

/// Effectue une vraie requête HTTP vers le backend. Rafraîchit
/// automatiquement le token une fois si la première tentative échoue
/// avec 401 (token expiré), puis réessaie une seule fois.
export async function apiRequest<T>(path: string, options: RequestOptions = {}, _isRetry = false): Promise<T> {
  const { method = "GET", body, skipAuth = false } = options;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
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
    throw new ApiError("Session expirée, veuillez vous reconnecter", 401, "session_expired");
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
    // Un refus d'agrément (expiré, suspendu, plafond atteint) n'est PAS une
    // perte de session : la déconnexion forcée reste réservée au 401 et à la
    // suspension du compte lui-même. Confondre les deux renvoyait le revendeur
    // sur l'écran de connexion, où plus rien n'expliquait le refus.
    if (!skipAuth && (res.status === 401 || (res.status === 403 && data?.error === "errors.auth.suspended"))) {
      forceLoginRedirect();
    }
    publishResellerAccess(data, data?.code);
    const message = data?.message
      ? (Array.isArray(data.message) ? data.message.map((m: any) => m.message).join(", ") : data.message)
      : `Erreur ${res.status}`;
    throw new ApiError(message, res.status, data?.code ?? data?.error, data, {
      errorKey: data?.error,
      resellerAccess: looksLikeAccessSummary(data?.resellerAccess) ? data.resellerAccess : undefined,
    });
  }

  publishResellerAccess(data);
  return data as T;
}

export { ApiError };

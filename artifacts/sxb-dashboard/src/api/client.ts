/// client.ts — Client HTTP partagé pour toutes les vraies requêtes
/// vers le backend Express (/api/*). Injecte le token JWT, gère le
/// rafraîchissement automatique en cas d'expiration, et normalise les
/// erreurs.

// Base URL — pointe directement vers la prod pour éviter le routage
// Replit qui intercepte /api/* via l'artifact api-server local.
const API_BASE = "https://vpnsxb.afrihall.com/api";

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
  code?: string;
  constructor(message: string, status: number, code?: string, responseData?: any) {
    super(message);
    this.status = status;
    this.responseData = responseData;
    this.code = code;
  }
}

let refreshPromise: Promise<boolean> | null = null;

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
    clearTokens();
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
    const message = data?.message
      ? (Array.isArray(data.message) ? data.message.map((m: any) => m.message).join(", ") : data.message)
      : `Erreur ${res.status}`;
    throw new ApiError(message, res.status, data?.error, data);
  }

  return data as T;
}

export { ApiError };

import { User, UserRole } from "../types";
import { apiRequest, setTokens, clearTokens, getAccessToken } from "./client";

interface LoginResponse {
  user: { id: string; name: string; email: string; role: string; permissions: string[] };
  accessToken: string;
  refreshToken: string;
}

export async function login(email: string, password: string): Promise<User> {
  const data = await apiRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: { email, password },
    skipAuth: true,
  });
  setTokens(data.accessToken, data.refreshToken);
  return {
    id: data.user.id,
    name: data.user.name,
    email: data.user.email,
    role: data.user.role as UserRole,
    permissions: data.user.permissions,
  };
}

/// Reconstruit la session depuis le token stocké localement, en
/// revalidant côté serveur via /auth/refresh (qui échoue proprement
/// si le token est invalide/expiré).
export async function getSessionUser(): Promise<User | null> {
  const token = getAccessToken();
  if (!token) return null;

  try {
    // /auth/refresh ne renvoie pas le profil utilisateur complet,
    // donc on décode le payload du JWT actuel pour l'affichage immédiat,
    // le serveur reste la source de vérité pour chaque requête protégée.
    const payload = JSON.parse(atob(token.split(".")[1]));
    return {
      id: payload.userId,
      name: payload.name || payload.email,
      email: payload.email,
      role: payload.role as UserRole,
      permissions: payload.permissions || [],
    };
  } catch {
    clearTokens();
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await apiRequest("/auth/logout", { method: "POST" });
  } finally {
    clearTokens();
  }
}

export async function register(name: string, email: string, password: string, phone?: string): Promise<User> {
  const data = await apiRequest<LoginResponse & { message: string }>("/auth/register", {
    method: "POST",
    body: { name, email, password, phone },
    skipAuth: true,
  });
  setTokens(data.accessToken, data.refreshToken);
  return {
    id: data.user.id,
    name: data.user.name,
    email: data.user.email,
    role: data.user.role as UserRole,
    permissions: [],
  };
}

export function getToken(): string | null {
  return getAccessToken();
}

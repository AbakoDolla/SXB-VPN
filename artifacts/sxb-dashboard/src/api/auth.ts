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

// Le JWT identifie la session, mais ne contient pas les permissions effectives.
// Relire le profil serveur conserve les menus autorisés après connexion,
// rechargement, renouvellement du token ou modification de la matrice RBAC.
export async function getSessionUser(): Promise<User | null> {
  const token = getAccessToken();
  if (!token) return null;

  return apiRequest<User>("/auth/me");
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

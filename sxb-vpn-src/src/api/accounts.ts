/**
 * Accounts API — Gestion des comptes dashboard (admin tokens, users)
 */
import { apiRequest } from './client';
import { User } from '../types';

export interface AdminTokenInfo {
  id: string;
  token: string;
  status: 'active' | 'used' | 'revoked';
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
}

export interface CreateAccountPayload {
  name: string;
  email: string;
  phone?: string;
  password?: string; // auto-generated if absent
  roleId: string;
  status?: 'active' | 'suspended';
}

export interface CreateAccountResult {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: { id: string; name: string };
  status: string;
  generatedPassword?: string;
  createdAt: string;
}

// Fetch all dashboard users
export async function fetchAccounts(): Promise<User[]> {
  try {
    const data = await apiRequest<{ users: any[] }>('/users');
    const users = data.users || (Array.isArray(data) ? (data as any[]) : []);
    return users.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role?.name || u.role,
      status: u.status,
      permissions: u.permissions || [],
      createdAt: u.createdAt,
    }));
  } catch (err) {
    console.error('Error fetching accounts:', err);
    return [];
  }
}

// Create a new dashboard account
export async function createAccount(payload: CreateAccountPayload): Promise<CreateAccountResult> {
  return apiRequest<CreateAccountResult>('/users', {
    method: 'POST',
    body: payload,
  });
}

// Update account status / role
export async function updateAccount(id: string, updates: Partial<CreateAccountPayload>): Promise<any> {
  return apiRequest(`/users/${id}`, { method: 'PATCH', body: updates });
}

// Delete an account
export async function deleteAccount(id: string): Promise<void> {
  await apiRequest(`/users/${id}`, { method: 'DELETE' });
}

// Generate an admin token for a user
export async function generateAdminToken(
  userId: string,
  expiresInHours = 24
): Promise<{ token: string; expiresAt: string; message: string }> {
  return apiRequest('/admin-tokens/generate', {
    method: 'POST',
    body: { userId, expiresInHours },
  });
}

// Activate with admin token (first login)
export async function activateWithAdminToken(
  token: string,
  newPassword?: string
): Promise<{ user: User; accessToken: string; refreshToken: string }> {
  return apiRequest('/admin-tokens/activate', {
    method: 'POST',
    body: { token, newPassword },
    skipAuth: true,
  });
}

// List admin tokens
export async function listAdminTokens(): Promise<AdminTokenInfo[]> {
  try {
    const data = await apiRequest<{ tokens: AdminTokenInfo[] }>('/admin-tokens');
    return data.tokens || [];
  } catch {
    return [];
  }
}

// Revoke an admin token
export async function revokeAdminToken(id: string): Promise<void> {
  await apiRequest(`/admin-tokens/${id}/revoke`, { method: 'POST' });
}

// Fetch available roles
export async function fetchRolesForCreation(): Promise<Array<{ id: string; name: string; description: string }>> {
  try {
    const data = await apiRequest<any>('/rbac/roles');
    const raw = Array.isArray(data) ? data : data.roles || [];
    return raw.map((r: any) => ({ id: r.id, name: r.name, description: r.description || '' }));
  } catch {
    return [];
  }
}

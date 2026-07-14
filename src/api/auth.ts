import { User, UserRole } from '../types';

const API_URL = '/api';

export async function login(email: string, password: string): Promise<User> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Erreur de connexion');
  }

  const data = await response.json();
  
  // Stocker le token
  localStorage.setItem('sxb_accessToken', data.accessToken);
  if (data.refreshToken) {
    localStorage.setItem('sxb_refreshToken', data.refreshToken);
  }

  // Utiliser les données utilisateur du login
  const userData = data.user;
  
  const user: User = {
    id: userData.id,
    name: userData.name,
    email: userData.email,
    phone: userData.phone,
    role: userData.role as UserRole,
    permissions: userData.permissions || [],
  };

  // Sauvegarder en local
  localStorage.setItem('sxb_user', JSON.stringify(user));
  
  return user;
}

export async function getSessionUser(): Promise<User | null> {
  const token = localStorage.getItem('sxb_accessToken');
  const storedUser = localStorage.getItem('sxb_user');
  
  if (!token) return null;
  
  // Retourner l'utilisateur stocké
  if (storedUser) {
    try {
      return JSON.parse(storedUser);
    } catch {
      return null;
    }
  }
  
  return null;
}

export async function logout(): Promise<void> {
  const token = localStorage.getItem('sxb_accessToken');
  
  if (token) {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch (e) {
      console.error('Logout error:', e);
    }
  }

  localStorage.removeItem('sxb_accessToken');
  localStorage.removeItem('sxb_refreshToken');
  localStorage.removeItem('sxb_user');
}

export async function updateProfile(name: string, email: string): Promise<User> {
  const token = localStorage.getItem('sxb_accessToken');
  const storedUser = localStorage.getItem('sxb_user');
  if (!token || !storedUser) throw new Error('Non authentifié');

  const currentUser = JSON.parse(storedUser);
  currentUser.name = name;
  currentUser.email = email;
  
  localStorage.setItem('sxb_user', JSON.stringify(currentUser));
  return currentUser;
}

export function getToken(): string | null {
  return localStorage.getItem('sxb_accessToken');
}

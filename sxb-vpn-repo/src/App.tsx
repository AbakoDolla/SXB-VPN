import React from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import DashboardView from "./components/DashboardView";
import ClientsView from "./components/ClientsView";
import TokensView from "./components/TokensView";
import RBACView from "./components/RBACView";
import SettingsView from "./components/SettingsView";
import AccountsView from "./components/AccountsView";
import DevicesView from "./components/DevicesView";
import SSHManagerView from "./components/SSHManagerView";
import XrayManagerView from "./components/XrayManagerView";
import SingboxManagerView from "./components/SingboxManagerView";
import SubscriptionsView from "./components/SubscriptionsView";
import VpnProfilesView from "./components/VpnProfilesView";
import ProtocolManagerView from "./components/ProtocolManagerView";
import Layout from "./components/Layout";
import { useEffect, useState } from 'react';
import { I18nProvider, useTranslation } from './contexts/I18nContext';
import { getSessionUser, login, logout } from './api/auth';
import { activateWithAdminToken } from './api/accounts';
import { setTokens } from './api/client';
import { User } from './types';
import { ShieldAlert, RefreshCw, LogIn, Eye, EyeOff, KeyRound, Mail } from 'lucide-react';

function LoginForm({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Erreur de connexion');
    } finally {
      setLoading(false);
    }
  };

  const handleTokenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const normalized = accessToken.trim().toUpperCase();
      const result = await activateWithAdminToken(normalized);
      setTokens(result.accessToken, result.refreshToken);
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Token invalide ou expiré');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#07090e] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/assets/images/logo_sxb_2026.png"
            alt="SXB VPN Logo"
            className="w-24 h-24 rounded-2xl mx-auto mb-4 object-contain"
          />
          <h1 className="text-3xl font-bold text-white mb-2">SXB VPN</h1>
          <p className="text-gray-400">Plateforme de gestion VPN</p>
        </div>

        <div className="flex gap-2 mb-4 bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-1">
          <button
            type="button"
            onClick={() => { setMode('password'); setError(''); }}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === 'password' ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Mail className="w-4 h-4" />
            Email / mot de passe
          </button>
          <button
            type="button"
            onClick={() => { setMode('token'); setError(''); }}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === 'token' ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <KeyRound className="w-4 h-4" />
            Token d'accès
          </button>
        </div>

        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl p-8">
          {error && (
            <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl">
              <p className="text-rose-400 text-sm text-center">{error}</p>
            </div>
          )}

          {mode === 'password' ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors"
                  placeholder="admin@sxbvpn.com"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Mot de passe</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors pr-12"
                    placeholder="••••••••"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-blue-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : (<><LogIn className="w-5 h-5" />Connexion</>)}
              </button>
            </form>
          ) : (
            <form onSubmit={handleTokenSubmit} className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Token d'accès</label>
                <input
                  type="text"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors font-mono tracking-wider text-center"
                  placeholder="SXB-ADMIN-XXXX-XXXX"
                  autoCapitalize="characters"
                  required
                />
                <p className="text-xs text-gray-500 mt-2 text-center">
                  Ce token t'a été communiqué par un super administrateur.
                </p>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 px-4 bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-blue-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <RefreshCw className="w-5 h-5 animate-spin" /> : (<><KeyRound className="w-5 h-5" />Se connecter avec le token</>)}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-gray-500 text-sm mt-6">
          Accès réservé aux utilisateurs autorisés
        </p>
      </div>
    </div>
  );
}

function MainApp() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeRoute, setActiveRoute] = useState('dashboard');
  const [loading, setLoading] = useState(true);

  const fetchUserSession = async () => {
    try {
      const user = await getSessionUser();
      setCurrentUser(user);
    } catch {
      // not logged in
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUserSession(); }, []);

  const handleUserChanged = (updatedUser: User) => setCurrentUser(updatedUser);
  const handleRolePermissionsUpdated = async () => { await fetchUserSession(); };
  const handleLogout = async () => { await logout(); setCurrentUser(null); };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#07090e] flex flex-col items-center justify-center text-gray-400">
        <RefreshCw className="h-8 w-8 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm font-mono">Chargement du dashboard SXB VPN...</p>
      </div>
    );
  }

  if (!currentUser) return <LoginForm onLogin={fetchUserSession} />;

  const role = currentUser.role;

  const renderView = () => {
    switch (activeRoute) {
      case 'dashboard':
      case 'analytics':
        return <DashboardView onNavigate={(r) => setActiveRoute(r)} />;
      case 'clients':
        return <ClientsView currentUserRole={role} actorName={currentUser.name} />;
      case 'subscriptions':
        return <SubscriptionsView currentUserRole={role} />;
      case 'tokens':
        return <TokensView currentUserRole={role} />;
      case 'devices':
        return <DevicesView />;
      case 'vpn-profiles':
        return <VpnProfilesView currentUserRole={role} />;
      case 'protocols':
        return <ProtocolManagerView currentUserRole={role} />;
      case 'ssh':
        return <SSHManagerView currentUserRole={role} />;
      case 'xray':
        return <XrayManagerView currentUserRole={role} />;
      case 'singbox':
        return <SingboxManagerView currentUserRole={role} />;
      case 'accounts':
        return <AccountsView currentUserRole={role} currentUserId={currentUser.id} />;
      case 'rbac':
        return (
          <RBACView
            currentUserRole={role}
            onRolePermissionsUpdated={handleRolePermissionsUpdated}
          />
        );
      case 'settings':
        return <SettingsView currentUser={currentUser} onUserUpdated={handleUserChanged} />;
      default:
        return <DashboardView onNavigate={(r) => setActiveRoute(r)} />;
    }
  };

  return (
    <Layout
      activeRoute={activeRoute}
      onNavigate={(route) => setActiveRoute(route)}
      currentUser={currentUser}
      onUserChanged={handleUserChanged}
      onLogout={handleLogout}
    >
      <ErrorBoundary resetKey={activeRoute}>
        {renderView()}
      </ErrorBoundary>
    </Layout>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <MainApp />
    </I18nProvider>
  );
}

import React from "react";
import { Toaster } from "sonner";
import ErrorBoundary from "./components/ErrorBoundary";
import DashboardView from "./components/DashboardView";
import ClientsView from "./components/ClientsView";
import ResellersView from "./components/ResellersView";
import ServersView from "./components/ServersView";
import TokensView from "./components/TokensView";
import VouchersView from "./components/VouchersView";
import SupportView from "./components/SupportView";
import RBACView from "./components/RBACView";
import SettingsView from "./components/SettingsView";
import AccountsView from "./components/AccountsView";
import DevicesView from "./components/DevicesView";
import SSHManagerView from "./components/SSHManagerView";
import PayloadManagerView from "./components/PayloadManagerView";
import XrayManagerView from "./components/XrayManagerView";
import SingboxManagerView from "./components/SingboxManagerView";
import SessionsView from "./components/SessionsView";
import VpnEngineView from "./components/VpnEngineView";
import MonitoringView from "./components/MonitoringView";
import SubscriptionsView from "./components/SubscriptionsView";
import VpnProfilesView from "./components/VpnProfilesView";
import OwnerLogView from "./components/OwnerLogView";
import AnnouncementsView from "./components/AnnouncementsView";
import AppUpdatesView from "./components/AppUpdatesView";
import MaintenancePage from "./components/MaintenancePage";
import Layout from "./components/Layout";
import { useEffect, useState, useCallback } from 'react';
import { I18nProvider, useTranslation } from './contexts/I18nContext';
import { getSessionUser, login, logout } from './api/auth';
import { activateWithAdminToken } from './api/accounts';
import { setTokens } from './api/client';
import { fetchMaintenanceState, setMaintenanceMode } from './api/owner';
import { User, UserRole } from './types';
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
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 mx-auto mb-4 flex items-center justify-center shadow-xl shadow-cyan-500/20">
            <img src="/assets/images/logo_sxb_2026.png" alt="SXB VPN Logo" className="w-11 h-11 object-contain" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">SXB VPN</h1>
          <p className="text-sm text-gray-500">Plateforme de gestion VPN</p>
        </div>

        {/* Card */}
        <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl p-6 shadow-2xl">
          {/* Tabs */}
          <div className="flex gap-1.5 mb-5 bg-[#07090e] border border-[#1a1f2e] rounded-xl p-1">
            <button
              type="button"
              onClick={() => { setMode('password'); setError(''); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                mode === 'password' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Mail className="w-3.5 h-3.5" />
              Email / Mot de passe
            </button>
            <button
              type="button"
              onClick={() => { setMode('token'); setError(''); }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                mode === 'token' ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              Token Admin
            </button>
          </div>

          {mode === 'password' ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">Email</label>
                <input
                  type="email"
                  placeholder="admin@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">Mot de passe</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 pr-10 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40"
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 cursor-pointer">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              {error && <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 text-sm font-semibold rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black transition-all disabled:opacity-60 cursor-pointer flex items-center justify-center gap-2"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                {loading ? 'Connexion…' : 'Se connecter'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleTokenSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">Token d'accès admin</label>
                <input
                  type="text"
                  placeholder="SXB-XXXX-XXXX-XXXX"
                  value={accessToken}
                  onChange={e => setAccessToken(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 font-mono tracking-wider"
                />
              </div>
              {error && <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 text-sm font-semibold rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black transition-all disabled:opacity-60 cursor-pointer flex items-center justify-center gap-2"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                {loading ? 'Vérification…' : 'Activer avec le token'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-gray-600 mt-4">SXB VPN Control Panel · v2.1</p>
      </div>
    </div>
  );
}

function MainApp() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [activeRoute, setActiveRoute] = useState('dashboard');
  const [showOwnerLogin, setShowOwnerLogin] = useState(false);
  // Mode maintenance : l'état réel vient du serveur (/ops/maintenance).
  // Pour l'OWNER → état courant ; pour les autres rôles pendant une pause,
  // le serveur répond 503 { error: 'maintenance' } → page publique propre.
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);

  const refreshMaintenance = useCallback(async () => {
    try {
      const state = await fetchMaintenanceState();
      setMaintenanceEnabled(state.enabled);
    } catch (err: any) {
      // 503 { error: 'maintenance' } = maintenance active (non-OWNER)
      if (err?.code === 'maintenance') setMaintenanceEnabled(true);
      else setMaintenanceEnabled(false); // 403/401 = service normal
    }
  }, []);

  const checkSession = async () => {
    try {
      const user = await getSessionUser();
      setCurrentUser(user);
    } catch {
      setCurrentUser(null);
    } finally {
      // Toujours interroger l'état maintenance (même sans session) :
      // le frontend public affiche la page « Maintenance en cours ».
      await refreshMaintenance();
      setChecking(false);
    }
  };

  useEffect(() => { checkSession(); }, []);

  // Bannière « MODE MAINTENANCE ACTIF » persistante pour l'OWNER :
  // rafraîchissement périodique tant que la session est ouverte.
  //
  // Réservé à l'OWNER : /ops/maintenance lui est exclusif, donc tout autre rôle
  // recevait un 403 toutes les 45 secondes. Fonctionnellement inoffensif (le
  // catch retombait sur « service normal »), mais la console se remplissait
  // d'erreurs et masquait les vraies. L'état d'une maintenance déclenchée
  // pendant la session reste connu : le serveur répond alors 503 sur les appels
  // ordinaires, ce que l'intercepteur traite déjà.
  useEffect(() => {
    if (!currentUser || currentUser.role !== UserRole.OWNER) return;
    const interval = setInterval(() => { refreshMaintenance(); }, 45000);
    return () => clearInterval(interval);
  }, [currentUser, refreshMaintenance]);

  const handleLogin = () => { checkSession(); setShowOwnerLogin(false); };
  const handleLogout = async () => {
    try { await logout(); } catch { /* ignore */ }
    setCurrentUser(null);
    setActiveRoute('dashboard');
    setMaintenanceEnabled(false);
    setShowOwnerLogin(false);
    await refreshMaintenance();
  };
  const handleUserChanged = (user: User) => setCurrentUser(user);
  const handleRolePermissionsUpdated = () => { checkSession(); };

  const handleMaintenanceToggle = async (enabled: boolean) => {
    const state = await setMaintenanceMode(enabled);
    setMaintenanceEnabled(state.enabled);
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-[#07090e] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="h-7 w-7 animate-spin text-cyan-400" />
          <p className="text-sm text-gray-500 font-mono">Initialisation…</p>
        </div>
      </div>
    );
  }

  // Maintenance active + session non-OWNER (ou aucune session) :
  // page publique « Maintenance en cours » sans fuite d'information.
  // L'OWNER garde l'accès (login + dashboard + bannière) via le lien
  // discret « Espace propriétaire » de la page.
  if (maintenanceEnabled && currentUser?.role !== UserRole.OWNER && !showOwnerLogin) {
    return <MaintenancePage onOwnerLogin={() => setShowOwnerLogin(true)} />;
  }

  if (!currentUser) return <LoginForm onLogin={handleLogin} />;

  const role = currentUser.role;

  const renderView = () => {
    switch (activeRoute) {
      case 'dashboard':
        return (
          <DashboardView
            onNavigate={(route) => setActiveRoute(route)}
            currentUserRole={role}
            maintenanceEnabled={maintenanceEnabled}
            onMaintenanceToggle={handleMaintenanceToggle}
          />
        );
      case 'clients':
        return <ClientsView currentUserRole={role} actorName={currentUser.name} />;
      case 'subscriptions':
        return <SubscriptionsView currentUserRole={role} />;
      case 'vpn-profiles':
        return <VpnProfilesView currentUserRole={role} />;
      case 'resellers':
        return <ResellersView currentUserRole={role} actorName={currentUser.name} />;
      case 'servers':
        return <ServersView currentUserRole={role} />;
      case 'tokens':
        return <TokensView currentUserRole={role} />;
      case 'vouchers':
        return <VouchersView currentUserRole={role} />;
      case 'support':
        return <SupportView />;
      case 'announcements':
        return <AnnouncementsView />;
      case 'app-updates':
        return <AppUpdatesView currentUserRole={role} />;
      case 'rbac':
        return <RBACView currentUserRole={role} onRolePermissionsUpdated={handleRolePermissionsUpdated} />;
      case 'accounts':
        return <AccountsView currentUserRole={role} currentUserId={currentUser.id} />;
      case 'settings':
        return <SettingsView currentUser={currentUser} onUserUpdated={handleUserChanged} onNavigate={(route) => setActiveRoute(route)} />;
      case 'devices':
        return <DevicesView />;
      case 'sessions':
        return <SessionsView />;
      case 'ssh':
        return <SSHManagerView currentUserRole={role} />;
      case 'payload':
        return <PayloadManagerView currentUserRole={role} />;
      case 'xray':
        return <XrayManagerView currentUserRole={role} />;
      case 'singbox':
        return <SingboxManagerView currentUserRole={role} />;
      case 'vpn-engine':
        return <VpnEngineView currentUserRole={role} />;
      case 'analytics':
        return <MonitoringView currentUserRole={role} defaultTab="logs" />;
      case 'monitoring':
        return <MonitoringView currentUserRole={role} defaultTab="sessions" />;
      case 'owner-log':
        // Garde côté route React : « Journal propriétaire » réservé à l'OWNER.
        // La sécurité réelle est le filtre serveur (/api/audit-logs/owner).
        if (role !== UserRole.OWNER) {
          return <DashboardView onNavigate={(route) => setActiveRoute(route)} currentUserRole={role} />;
        }
        return <OwnerLogView />;
      default:
        return (
          <DashboardView
            onNavigate={(route) => setActiveRoute(route)}
            currentUserRole={role}
            maintenanceEnabled={maintenanceEnabled}
            onMaintenanceToggle={handleMaintenanceToggle}
          />
        );
    }
  };

  return (
    <Layout
      activeRoute={activeRoute}
      onNavigate={(route) => setActiveRoute(route)}
      currentUser={currentUser}
      onUserChanged={handleUserChanged}
      onLogout={handleLogout}
      maintenanceEnabled={maintenanceEnabled}
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
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          style: {
            background: '#0f1218',
            border: '1px solid #1a1f2e',
            color: '#e2e8f0',
          },
        }}
      />
      <MainApp />
    </I18nProvider>
  );
}

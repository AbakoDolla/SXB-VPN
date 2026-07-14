import Layout from "./components/Layout";
import DashboardView from "./views/DashboardView";
import ClientsView from "./views/ClientsView";
import ResellersView from "./views/ResellersView";
import ServersView from "./views/ServersView";
import XPanelView from "./views/XPanelView";
import TokensView from "./views/TokensView";
import VouchersView from "./views/VouchersView";
import SupportView from "./views/SupportView";
import RBACView from "./views/RBACView";
import SettingsView from "./views/SettingsView";
import Layout from "./components/Layout";
import { useEffect, useState } from 'react';
import { I18nProvider, useTranslation } from './contexts/I18nContext';
import { getSessionUser, login, logout } from './api/auth';
import { User, UserRole } from './types';
import { ShieldAlert, RefreshCw, LogIn, Eye, EyeOff } from 'lucide-react';

function LoginForm({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
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

  return (
    <div className="min-h-screen bg-[#07090e] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 mb-4">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">SXB VPN</h1>
          <p className="text-gray-400">Plateforme de gestion VPN</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl p-8">
          {error && (
            <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl">
              <p className="text-rose-400 text-sm text-center">{error}</p>
            </div>
          )}

          <div className="space-y-6">
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
              className="w-full py-3 px-4 bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  Connexion
                </>
              )}
            </button>
          </div>
        </form>

        <p className="text-center text-gray-500 text-sm mt-6">
          Accès réservé aux utilisateurs autorisés
        </p>
      </div>
    </div>
  );
}

function MainApp() {
  const { t } = useTranslation();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeRoute, setActiveRoute] = useState('dashboard');
  const [loading, setLoading] = useState(true);

  const fetchUserSession = async () => {
    try {
      const user = await getSessionUser();
      setCurrentUser(user);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUserSession();
  }, []);

  const handleUserChanged = (updatedUser: User) => {
    setCurrentUser(updatedUser);
  };

  const handleRolePermissionsUpdated = async () => {
    await fetchUserSession();
  };

  const handleLogout = async () => {
    await logout();
    setCurrentUser(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#07090e] flex flex-col items-center justify-center text-gray-400">
        <RefreshCw className="h-8 w-8 animate-spin text-cyan-400 mb-4" />
        <p className="text-sm font-mono">Chargement du dashboard SXB VPN...</p>
      </div>
    );
  }

  // Si pas connecté, afficher le formulaire de connexion
  if (!currentUser) {
    return <LoginForm onLogin={fetchUserSession} />;
  }

  // RBAC Client-Side Route guard checks
  const renderView = () => {
    const role = currentUser.role;

    switch (activeRoute) {
      case 'dashboard':
        return <DashboardView onNavigate={(route) => setActiveRoute(route)} />;
      case 'clients':
        return <ClientsView currentUserRole={role} actorName={currentUser.name} />;
      case 'resellers':
        return <ResellersView currentUserRole={role} actorName={currentUser.name} />;
      case 'servers':
        return <ServersView currentUserRole={role} />;
      case 'xpanel':
        return <XPanelView currentUserRole={role} />;
      case 'tokens':
        return <TokensView currentUserRole={role} />;
      case 'vouchers':
        return <VouchersView currentUserRole={role} />;
      case 'support':
        return <SupportView />;
      case 'rbac':
        return (
          <RBACView
            currentUserRole={role}
            onRolePermissionsUpdated={handleRolePermissionsUpdated}
          />
        );
      case 'settings':
        return <SettingsView />;
      default:
        return <DashboardView onNavigate={(route) => setActiveRoute(route)} />;
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
      {renderView()}
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

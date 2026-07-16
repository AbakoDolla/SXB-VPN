import DashboardView from "./components/DashboardView";
import ClientsView from "./components/ClientsView";
import ResellersView from "./components/ResellersView";
import ServersView from "./components/ServersView";
import XPanelView from "./components/XPanelView";
import TokensView from "./components/TokensView";
import VouchersView from "./components/VouchersView";
import SupportView from "./components/SupportView";
import RBACView from "./components/RBACView";
import SettingsView from "./components/SettingsView";
import AccountsView from "./components/AccountsView";
import Layout from "./components/Layout";
import { useEffect, useState } from 'react';
import { I18nProvider, useTranslation } from './contexts/I18nContext';
import { getSessionUser, login, logout } from './api/auth';
import { apiRequest } from './api/client';
import { User, UserRole } from './types';
import { ShieldAlert, RefreshCw, LogIn, Eye, EyeOff, Key } from 'lucide-react';

type LoginTab = 'email' | 'token';

function LoginForm({ onLogin }: { onLogin: () => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<LoginTab>('email');

  // Email/password tab
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Token tab
  const [adminToken, setAdminToken] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Identifiants incorrects');
    } finally {
      setLoading(false);
    }
  };

  const handleTokenLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = adminToken.trim().toUpperCase();
    if (!/^SXB-ADMIN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(trimmed)) {
      setError('Format invalide. Attendu : SXB-ADMIN-XXXX-XXXX');
      return;
    }

    setLoading(true);
    try {
      const result = await apiRequest<{
        success: boolean;
        accessToken: string;
        refreshToken: string;
        user: { id: string; name: string; email: string };
      }>('/auth/token-login', {
        method: 'POST',
        body: { token: trimmed },
      });

      if (result.accessToken) {
        localStorage.setItem('accessToken', result.accessToken);
        localStorage.setItem('refreshToken', result.refreshToken);
        onLogin();
      } else {
        throw new Error('Token invalide ou expiré');
      }
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
          <img
            src="/assets/images/logo_sxb_2026.png"
            alt="SXB VPN Logo"
            className="w-24 h-24 rounded-2xl mx-auto mb-4 object-contain"
          />
          <h1 className="text-3xl font-bold text-white mb-2">SXB VPN</h1>
          <p className="text-gray-400">Plateforme de gestion VPN</p>
        </div>

        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-[#1a1f2e]">
            <button
              onClick={() => { setActiveTab('email'); setError(''); }}
              className={`flex-1 py-3.5 text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                activeTab === 'email'
                  ? 'text-cyan-400 border-b-2 border-cyan-400 bg-cyan-500/5'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <LogIn className="w-4 h-4" />
              Email & Mot de passe
            </button>
            <button
              onClick={() => { setActiveTab('token'); setError(''); }}
              className={`flex-1 py-3.5 text-sm font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                activeTab === 'token'
                  ? 'text-cyan-400 border-b-2 border-cyan-400 bg-cyan-500/5'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Key className="w-4 h-4" />
              Token Admin
            </button>
          </div>

          <div className="p-8">
            {/* Error */}
            {error && (
              <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl">
                <p className="text-rose-400 text-sm text-center">{error}</p>
              </div>
            )}

            {/* Email / Password tab */}
            {activeTab === 'email' && (
              <form onSubmit={handleEmailLogin} className="space-y-6">
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
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 cursor-pointer"
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-semibold rounded-xl hover:from-cyan-600 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
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
              </form>
            )}

            {/* Token Admin tab */}
            {activeTab === 'token' && (
              <form onSubmit={handleTokenLogin} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Token d'accès unique
                  </label>
                  <input
                    type="text"
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value.toUpperCase())}
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors font-mono tracking-widest"
                    placeholder="SXB-ADMIN-XXXX-XXXX"
                    maxLength={20}
                    required
                  />
                  <p className="mt-2 text-xs text-gray-500">
                    Token à usage unique fourni par votre administrateur système. Valide 24h.
                  </p>
                </div>

                <div className="p-3 rounded-xl bg-cyan-500/5 border border-cyan-500/20">
                  <p className="text-xs text-cyan-400/80">
                    🔐 Après connexion via token, vous serez invité à définir un mot de passe permanent.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 bg-gradient-to-r from-violet-500 to-purple-600 text-white font-semibold rounded-xl hover:from-violet-600 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
                >
                  {loading ? (
                    <RefreshCw className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      <Key className="w-5 h-5" />
                      Connexion par Token
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>

        <p className="text-center text-gray-500 text-sm mt-6">
          Accès réservé aux utilisateurs autorisés SXB VPN
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

  if (!currentUser) {
    return <LoginForm onLogin={fetchUserSession} />;
  }

  const role = currentUser.role;

  const renderView = () => {
    switch (activeRoute) {
      case 'dashboard':
        return <DashboardView onNavigate={(route) => setActiveRoute(route)} />;
      case 'clients':
        return <ClientsView currentUserRole={role} />;
      case 'resellers':
        return <ResellersView currentUserRole={role} />;
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
      case 'accounts':
        return (
          <AccountsView
            currentUserRole={role}
            currentUserId={currentUser.id}
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

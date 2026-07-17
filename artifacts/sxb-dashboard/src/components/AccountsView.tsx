import React, { useEffect, useState } from 'react';
import { useTranslation } from '../contexts/I18nContext';
import {
  fetchAccounts, createAccount, deleteAccount, generateAdminToken,
  listAdminTokens, revokeAdminToken, fetchRolesForCreation,
  AdminTokenInfo, CreateAccountPayload,
} from '../api/accounts';
import { User, UserRole } from '../types';
import {
  UserPlus, Key, RefreshCw, Trash2, Copy, Check, ShieldAlert,
  Search, Eye, EyeOff, ChevronDown, X, Shield, Clock, BadgeCheck,
} from 'lucide-react';

interface AccountsViewProps {
  currentUserRole: UserRole;
  currentUserId?: string;
}

interface Role { id: string; name: string; description: string; }

const ROLE_COLORS: Record<string, string> = {
  SUPER_ADMIN: 'text-red-400 bg-red-500/10 border-red-500/30',
  ADMIN:       'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  SUPPORT:     'text-amber-400 bg-amber-500/10 border-amber-500/30',
  RESELLER:    'text-violet-400 bg-violet-500/10 border-violet-500/30',
};

export default function AccountsView({ currentUserRole, currentUserId }: AccountsViewProps) {
  const { t } = useTranslation();

  // Data
  const [accounts, setAccounts] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [adminTokens, setAdminTokens] = useState<AdminTokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Create account form
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState<CreateAccountPayload>({
    name: '', email: '', phone: '', roleId: '', status: 'active',
  });
  const [formPassword, setFormPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [autoGenPassword, setAutoGenPassword] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Post-creation result
  const [createdResult, setCreatedResult] = useState<{
    name: string; email: string; role: string;
    generatedPassword?: string; adminToken?: string; expiresAt?: string;
  } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Token generation
  const [generatingTokenFor, setGeneratingTokenFor] = useState<string | null>(null);
  const [tokenResult, setTokenResult] = useState<{ userId: string; token: string; expiresAt: string } | null>(null);

  const isSuperAdmin = currentUserRole === UserRole.SUPER_ADMIN;
  const isAdmin = currentUserRole === UserRole.ADMIN || isSuperAdmin;

  // ── Load data ──────────────────────────────────────────────────
  const loadAll = async () => {
    setLoading(true);
    try {
      const [acc, rls, toks] = await Promise.all([
        fetchAccounts(),
        fetchRolesForCreation(),
        listAdminTokens(),
      ]);
      setAccounts(acc);
      setRoles(rls.filter(r => isSuperAdmin ? true : r.name !== 'SUPER_ADMIN'));
      setAdminTokens(toks);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  // ── Create account ─────────────────────────────────────────────
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      const payload: CreateAccountPayload = {
        ...form,
        password: autoGenPassword ? undefined : formPassword || undefined,
      };
      const result = await createAccount(payload);

      // Auto-generate an admin token for the new user
      let adminToken: string | undefined;
      let expiresAt: string | undefined;
      try {
        const tokenData = await generateAdminToken(result.id, 48);
        adminToken = tokenData.token;
        expiresAt = tokenData.expiresAt;
      } catch (_) { /* non-blocking */ }

      setCreatedResult({
        name: result.name,
        email: result.email,
        role: result.role?.name || '',
        generatedPassword: result.generatedPassword,
        adminToken,
        expiresAt,
      });
      setShowCreateModal(false);
      setForm({ name: '', email: '', phone: '', roleId: '', status: 'active' });
      setFormPassword('');
      await loadAll();
    } catch (err: any) {
      setCreateError(err?.message || 'Erreur lors de la création');
    } finally {
      setCreating(false);
    }
  };

  // ── Generate admin token ───────────────────────────────────────
  const handleGenerateToken = async (userId: string) => {
    setGeneratingTokenFor(userId);
    try {
      const data = await generateAdminToken(userId, 24);
      setTokenResult({ userId, token: data.token, expiresAt: data.expiresAt });
      await loadAll();
    } catch (err: any) {
      alert(err?.message || 'Erreur lors de la génération du token');
    } finally {
      setGeneratingTokenFor(null);
    }
  };

  // ── Delete account ─────────────────────────────────────────────
  const handleDelete = async (id: string, name: string) => {
    if (id === currentUserId) return alert('Vous ne pouvez pas supprimer votre propre compte');
    if (!confirm(`Supprimer le compte de "${name}" ? Cette action est irréversible.`)) return;
    try {
      await deleteAccount(id);
      await loadAll();
    } catch (err: any) {
      alert(err?.message || 'Erreur lors de la suppression');
    }
  };

  // ── Revoke token ───────────────────────────────────────────────
  const handleRevokeToken = async (id: string) => {
    if (!confirm('Révoquer ce token d\'accès ?')) return;
    try {
      await revokeAdminToken(id);
      await loadAll();
    } catch (err: any) {
      alert(err?.message || 'Erreur');
    }
  };

  // ── Copy helper ────────────────────────────────────────────────
  const copy = (field: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const filtered = accounts.filter(
    (a) =>
      (a.name || '').toLowerCase().includes(search.toLowerCase()) ||
      (a.email || '').toLowerCase().includes(search.toLowerCase()) ||
      ((a as any).role?.name || (a as any).role || '').toLowerCase().includes(search.toLowerCase())
  );

  // Role badge
  const RoleBadge = ({ role }: { role: string }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-semibold ${ROLE_COLORS[role] || 'text-gray-400 bg-gray-500/10 border-gray-500/30'}`}>
      <Shield className="w-3 h-3" />
      {role}
    </span>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Gestion des Comptes</h1>
          <p className="text-sm text-gray-400 mt-1">
            Créez et gérez les comptes d'accès au dashboard SXB VPN
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => { setShowCreateModal(true); setCreateError(''); }}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg transition-all"
          >
            <UserPlus className="h-4 w-4" />
            Créer un compte
          </button>
        )}
      </div>

      {/* Post-creation success banner */}
      {createdResult && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <BadgeCheck className="w-5 h-5 text-emerald-400 shrink-0" />
              <span className="text-emerald-400 font-semibold">
                Compte créé — {createdResult.name} ({createdResult.role})
              </span>
            </div>
            <button onClick={() => setCreatedResult(null)} className="text-gray-500 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2">
            <p className="text-sm text-gray-300">Transmettez ces informations de façon sécurisée :</p>

            {/* Email */}
            <div className="flex items-center gap-2 bg-gray-900/60 rounded-lg px-3 py-2">
              <span className="text-xs text-gray-400 w-24 shrink-0">Email</span>
              <code className="text-sm text-white font-mono flex-1 truncate">{createdResult.email}</code>
              <button onClick={() => copy('email', createdResult.email)} className="text-gray-400 hover:text-white">
                {copiedField === 'email' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            {/* Password */}
            {createdResult.generatedPassword && (
              <div className="flex items-center gap-2 bg-gray-900/60 rounded-lg px-3 py-2">
                <span className="text-xs text-gray-400 w-24 shrink-0">Mot de passe</span>
                <code className="text-sm text-amber-300 font-mono flex-1 truncate">{createdResult.generatedPassword}</code>
                <button onClick={() => copy('pass', createdResult.generatedPassword!)} className="text-gray-400 hover:text-white">
                  {copiedField === 'pass' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            )}

            {/* Admin Token */}
            {createdResult.adminToken && (
              <div className="flex items-center gap-2 bg-gray-900/60 rounded-lg px-3 py-2">
                <span className="text-xs text-gray-400 w-24 shrink-0">Token admin</span>
                <code className="text-sm text-cyan-300 font-mono flex-1 truncate">{createdResult.adminToken}</code>
                <button onClick={() => copy('adminToken', createdResult.adminToken!)} className="text-gray-400 hover:text-white">
                  {copiedField === 'adminToken' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            )}
            {createdResult.expiresAt && (
              <p className="text-xs text-gray-500 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Token valide jusqu'au {new Date(createdResult.expiresAt).toLocaleString('fr-FR')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Token result banner */}
      {tokenResult && (
        <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-cyan-400" />
              <span className="text-cyan-400 font-semibold text-sm">Token admin généré</span>
            </div>
            <button onClick={() => setTokenResult(null)} className="text-gray-500 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 bg-gray-900/60 rounded-lg px-3 py-2">
            <code className="text-sm text-cyan-300 font-mono flex-1">{tokenResult.token}</code>
            <button onClick={() => copy('newToken', tokenResult.token)} className="text-gray-400 hover:text-white">
              {copiedField === 'newToken' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Expire le {new Date(tokenResult.expiresAt).toLocaleString('fr-FR')}
          </p>
        </div>
      )}

      {/* Search */}
      <div className="relative w-full md:w-80">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher par nom, email, rôle..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm bg-gray-900/60 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        />
      </div>

      {/* Accounts table */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <RefreshCw className="h-6 w-6 animate-spin text-cyan-400 mr-3" />
          Chargement...
        </div>
      ) : (
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1a1f2e]">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Compte</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Rôle</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Statut</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Créé le</th>
                  <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-12 text-gray-500">Aucun compte trouvé</td>
                  </tr>
                )}
                {filtered.map((account) => {
                  const roleName = (account as any).role?.name || (account as any).role || '';
                  const isOwn = account.id === currentUserId;
                  return (
                    <tr key={account.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shrink-0">
                            <span className="text-white text-xs font-bold">
                              {account.name?.charAt(0)?.toUpperCase() || '?'}
                            </span>
                          </div>
                          <div>
                            <p className="text-white font-medium">{account.name}</p>
                            <p className="text-gray-500 text-xs">{account.email}</p>
                            {(account as any).phone && (
                              <p className="text-gray-600 text-xs">{(account as any).phone}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <RoleBadge role={roleName} />
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${
                          (account as any).status === 'active'
                            ? 'text-emerald-400 bg-emerald-500/10'
                            : 'text-rose-400 bg-rose-500/10'
                        }`}>
                          {(account as any).status === 'active' ? '● Actif' : '● Suspendu'}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-gray-500 text-xs">
                        {(account as any).createdAt
                          ? new Date((account as any).createdAt).toLocaleDateString('fr-FR')
                          : '—'}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-2">
                          {isAdmin && !isOwn && (
                            <>
                              <button
                                onClick={() => handleGenerateToken(account.id)}
                                disabled={generatingTokenFor === account.id}
                                title="Générer un token d'accès"
                                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
                              >
                                {generatingTokenFor === account.id
                                  ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                  : <Key className="w-3.5 h-3.5" />}
                                Token
                              </button>
                              {roleName !== 'SUPER_ADMIN' && (
                                <button
                                  onClick={() => handleDelete(account.id, account.name)}
                                  title="Supprimer ce compte"
                                  className="p-1.5 text-gray-600 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </>
                          )}
                          {isOwn && (
                            <span className="text-xs text-gray-600 italic">Vous</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Admin tokens section */}
      {isAdmin && adminTokens.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Tokens admin actifs récents
          </h2>
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1f2e]">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Token</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Utilisateur</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Statut</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Expire</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1f2e]">
                  {adminTokens.slice(0, 15).map((tok) => (
                    <tr key={tok.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-cyan-300 font-mono">{tok.token}</code>
                          <button onClick={() => copy(tok.id, tok.token)} className="text-gray-600 hover:text-gray-300">
                            {copiedField === tok.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-gray-300 text-xs">{tok.user.email}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-medium ${
                          tok.status === 'active' ? 'text-emerald-400' :
                          tok.status === 'used'   ? 'text-blue-400' :
                          'text-gray-500'
                        }`}>
                          {tok.status === 'active' ? '● Actif' : tok.status === 'used' ? '✓ Utilisé' : '✗ Révoqué'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">
                        {new Date(tok.expiresAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {tok.status === 'active' && (
                          <button
                            onClick={() => handleRevokeToken(tok.id)}
                            className="text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-2 py-1 rounded"
                          >
                            Révoquer
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Create Account Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-[#0d111b] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e]">
              <div className="flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-cyan-400" />
                <h2 className="text-base font-semibold text-white">Créer un compte</h2>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-gray-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="px-6 py-5 space-y-4">
              {createError && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-sm">
                  {createError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                  Nom complet *
                </label>
                <input
                  required
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Jean Dupont"
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                  Email *
                </label>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="jean@example.com"
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                  Téléphone
                </label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="+225 07 XX XX XX"
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                  Rôle *
                </label>
                <div className="relative">
                  <select
                    required
                    value={form.roleId}
                    onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                    className="w-full appearance-none px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 pr-8"
                  >
                    <option value="">Sélectionner un rôle...</option>
                    {roles.map(r => (
                      <option key={r.id} value={r.id}>{r.name} — {r.description}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Mot de passe
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoGenPassword}
                      onChange={(e) => setAutoGenPassword(e.target.checked)}
                      className="rounded border-gray-700 bg-gray-900 text-cyan-500"
                    />
                    <span className="text-xs text-gray-500">Auto-générer</span>
                  </label>
                </div>
                {!autoGenPassword && (
                  <div className="relative">
                    <input
                      required
                      type={showPassword ? 'text' : 'password'}
                      value={formPassword}
                      onChange={(e) => setFormPassword(e.target.value)}
                      minLength={6}
                      placeholder="Min. 6 caractères"
                      className="w-full px-3 py-2 pr-10 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                )}
                {autoGenPassword && (
                  <p className="text-xs text-gray-600 mt-1">
                    Un mot de passe sécurisé sera généré automatiquement et affiché après création.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Statut</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as any })}
                  className="px-2 py-1.5 text-xs bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none"
                >
                  <option value="active">Actif</option>
                  <option value="suspended">Suspendu</option>
                </select>
              </div>

              <div className="flex gap-2 justify-end pt-2 border-t border-gray-900 mt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg disabled:opacity-50"
                >
                  {creating && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  Créer le compte
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

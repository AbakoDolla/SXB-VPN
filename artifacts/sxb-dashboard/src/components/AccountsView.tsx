import { useTranslation } from '../contexts/I18nContext';
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import Pagination from './ui/Pagination';
import {
  fetchAccounts, createAccount, deleteAccount, generateAdminToken,
  listAdminTokens, revokeAdminToken, fetchRolesForCreation,
  AdminTokenInfo, CreateAccountPayload, DashboardAccount,
} from '../api/accounts';
import { fetchResellerReconciliation } from '../api/resellers';
import { isSuperAdmin as isSuperAdminRole, isAdmin as isAdminRole } from '../lib/roles';
import { UserRole, ResellerReconciliation } from '../types';
import { usePermissions } from '../contexts/PermissionsContext';
import { useActionLock } from '../hooks/useActionLock';
import { useBulkDelete } from '../hooks/useBulkDelete';
import BulkDeleteControls from './BulkDeleteControls';
import ResellersView from './ResellersView';
import RBACView from './RBACView';
import {
  UserPlus, Key, RefreshCw, Trash2, Copy, Check, ShieldAlert,
  Search, Eye, EyeOff, ChevronDown, X, Shield, Clock, BadgeCheck,
  Users, Store, KeyRound, AlertTriangle,
} from 'lucide-react';

/**
 * Gestion des comptes — SURFACE UNIQUE.
 *
 * Comptes de connexion, agréments revendeurs et habilitations vivaient sur
 * trois écrans séparés qui se renvoyaient les uns aux autres, et deux d'entre
 * eux proposaient chacun leur propre « création de revendeur ». Résultat en
 * production : 70 comptes portant le rôle RESELLER pour 6 fiches revendeur
 * réelles, parce qu'une des deux portes ne créait que le compte.
 *
 * Les trois sections sont désormais réunies ici, et la création d'un revendeur
 * n'a plus qu'un seul chemin : l'onglet « Revendeurs », qui appelle le flux
 * canonique du serveur (compte + rôle + fiche dans une seule transaction).
 */
type TabId = 'accounts' | 'resellers' | 'rbac';

interface AccountsViewProps {
  currentUserRole: UserRole;
  currentUserId?: string;
  actorName?: string;
  initialTab?: TabId;
  onRolePermissionsUpdated?: () => void;
}

interface Role { id: string; name: string; description: string; }

const ROLE_COLORS: Record<string, string> = {
  OWNER:       'text-rose-300 bg-rose-500/10 border-rose-500/30',
  SUPER_ADMIN: 'text-red-400 bg-red-500/10 border-red-500/30',
  ADMIN:       'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  SUPPORT:     'text-amber-400 bg-amber-500/10 border-amber-500/30',
  RESELLER:    'text-violet-400 bg-violet-500/10 border-violet-500/30',
};

export default function AccountsView({
  currentUserRole,
  currentUserId,
  actorName = '',
  initialTab = 'accounts',
  onRolePermissionsUpdated,
}: AccountsViewProps) {
  const { t, locale, formatNumber, message, errorMessage, errorText } = useTranslation();
  const [tab, setTab] = useState<TabId>(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  // Data
  const [accounts, setAccounts] = useState<DashboardAccount[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [adminTokens, setAdminTokens] = useState<AdminTokenInfo[]>([]);
  const [reconciliation, setReconciliation] = useState<ResellerReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { pending, run } = useActionLock();
  const can = usePermissions();

  // Formulaire de création de compte
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [form, setForm] = useState<CreateAccountPayload>({
    name: '', email: '', phone: '', roleId: '', status: 'active',
  });
  const [formPassword, setFormPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [autoGenPassword, setAutoGenPassword] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  // Résultat de création
  const [createdResult, setCreatedResult] = useState<{
    name: string; email: string; role: string;
    generatedPassword?: string; adminToken?: string; expiresAt?: string;
  } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Jetons d'accès
  const [generatingTokenFor, setGeneratingTokenFor] = useState<string | null>(null);
  const [tokenResult, setTokenResult] = useState<{ userId: string; token: string; expiresAt: string } | null>(null);

  const isSuperAdmin = isSuperAdminRole(currentUserRole);
  const isAdmin = currentUserRole === UserRole.ADMIN || isSuperAdmin;
  const canDelete = isAdmin && can('users.delete');
  const selectableAccount = (account: DashboardAccount) => account.id !== currentUserId && !isAdminRole(account.role);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [acc, rls, toks] = await Promise.all([
        fetchAccounts(),
        fetchRolesForCreation(),
        listAdminTokens(),
      ]);
      setAccounts(acc);
      setRoles(rls.filter(r => (isSuperAdmin ? true : r.name !== 'SUPER_ADMIN')));
      setAdminTokens(toks);
      // Le rapport d'écart est réservé aux rôles qui peuvent trancher : un
      // ADMIN n'y peut rien et le lirait comme une alarme sans recours.
      if (isSuperAdmin) setReconciliation(await fetchResellerReconciliation());
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorLoad'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const roleNameOf = (roleId: string) => roles.find(r => r.id === roleId)?.name ?? '';
  // La création d'un revendeur exige une échéance d'accès et un plafond : elle
  // passe exclusivement par l'onglet dédié, jamais par ce formulaire générique.
  const selectedRoleIsReseller = roleNameOf(form.roleId) === 'RESELLER';

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (selectedRoleIsReseller) {
      setCreateError('commerce.accounts.resellerCreationError');
      return;
    }
    setCreateError('');
    setCreating(true);
    try {
      await run('create-account', async () => {
        const payload: CreateAccountPayload = {
          ...form,
          password: autoGenPassword ? undefined : formPassword || undefined,
        };
        const result = await createAccount(payload);

        let adminToken: string | undefined;
        let expiresAt: string | undefined;
        try {
          const tokenData = await generateAdminToken(result.id, 48);
          adminToken = tokenData.token;
          expiresAt = tokenData.expiresAt;
        } catch { /* le compte est créé ; le jeton reste optionnel */ }

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
      });
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  };

  const handleGenerateToken = async (userId: string) => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    setGeneratingTokenFor(userId);
    try {
      await run(`generate-token:${userId}`, async () => {
        const data = await generateAdminToken(userId, 24);
        setTokenResult({ userId, token: data.token, expiresAt: data.expiresAt });
        toast.success(message('commerce.accounts.tokenGenerated'));
        await loadAll();
      });
    } catch (err) {
      toast.error(errorText(err, 'commerce.accounts.tokenError'));
    } finally {
      setGeneratingTokenFor(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (!canDelete) { toast.error(message('errors.auth.forbidden_permission')); return; }
    if (id === currentUserId) { toast.error(message('commerce.accounts.cannotDeleteSelf')); return; }
    const target = accounts.find(account => account.id === id);
    if (!target || isSuperAdminRole(target.role)) { toast.error(message('errors.bulkDelete.unavailable')); return; }
    if (!window.confirm(t('commerce.accounts.confirmDelete', { name }))) return;
    try {
      await run(`delete-account:${id}`, async () => {
        await deleteAccount(id);
        setAccounts(current => current.filter(account => account.id !== id));
        setSelected(current => new Set([...current].filter(selectedId => selectedId !== id)));
        toast.success(message('commerce.accounts.deleted'));
        await loadAll();
      });
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorDelete'));
    }
  };

  const handleRevokeToken = async (id: string) => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (!window.confirm(t('commerce.accounts.confirmRevoke'))) return;
    try {
      await run(`revoke-token:${id}`, async () => {
        await revokeAdminToken(id);
        toast.success(message('commerce.accounts.tokenRevoked'));
        await loadAll();
      });
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.error'));
    }
  };

  const copy = (field: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return accounts;
    return accounts.filter(
      (a) =>
        (a.name || '').toLowerCase().includes(needle) ||
        (a.email || '').toLowerCase().includes(needle) ||
        a.role.toLowerCase().includes(needle)
    );
  }, [accounts, search]);

  const bulkDelete = useBulkDelete({
    items: accounts, filtered, selected, setSelected,
    label: account => account.name || account.email || account.id,
    eligible: selectableAccount, canDelete, remove: account => deleteAccount(account.id),
    onDeleted: ids => setAccounts(current => current.filter(account => !ids.has(account.id))),
    afterDelete: isSuperAdmin ? async () => setReconciliation(await fetchResellerReconciliation()) : undefined,
    pending, run, busy: loading || showCreateModal || creating || !!generatingTokenFor,
    scopeKey: `${currentUserRole}:${currentUserId ?? ""}`, filterKey: `${search}\0${tab}`,
  });
  const controlsBusy = !!pending || !!bulkDelete.confirmation;

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  useEffect(() => { setPage(1); }, [search]);
  useEffect(() => setPage(current => Math.max(1, Math.min(current, Math.ceil(filtered.length / pageSize)))), [filtered.length, pageSize]);

  const RoleBadge = ({ role }: { role: string }) => (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-semibold ${ROLE_COLORS[role] || 'text-gray-400 bg-gray-500/10 border-gray-500/30'}`}>
      <Shield className="w-3 h-3" />
      {role}
    </span>
  );

  const TABS: Array<{ id: TabId; label: string; icon: any; hint: string }> = [
    { id: 'accounts',  label: t('commerce.accounts.tabs.accounts'), icon: Users,    hint: t('commerce.accounts.tabs.accountsHint') },
    { id: 'resellers', label: t('commerce.accounts.tabs.resellers'),           icon: Store,    hint: t('commerce.accounts.tabs.resellersHint') },
    { id: 'rbac',      label: t('commerce.accounts.tabs.rbac'),        icon: KeyRound, hint: t('commerce.accounts.tabs.rbacHint') },
  ];

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t('commerce.accounts.title')}</h1>
          <p className="mt-1 text-sm text-gray-400">
            {t('commerce.accounts.subtitle')}
          </p>
        </div>
        {isSuperAdmin && tab === 'accounts' && (
          <button
            onClick={() => { setShowCreateModal(true); setCreateError(''); }}
            disabled={controlsBusy}
            className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition-all hover:from-cyan-400 hover:to-blue-500"
          >
            <UserPlus className="h-4 w-4" />
            {t('commerce.accounts.create')}
          </button>
        )}
      </div>

      {/* Onglets — responsive : ils passent à la ligne au lieu de déborder */}
      <div className="flex flex-wrap gap-2 rounded-2xl border border-[#1a1f2e] bg-[#0a0d14] p-1.5">
        {TABS.map(({ id, label, icon: Icon, hint }) => (
          <button
            key={id}
            type="button"
            disabled={controlsBusy}
            onClick={() => setTab(id)}
            title={hint}
            className={`flex flex-1 min-w-[10rem] items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-all sm:text-sm ${
              tab === id
                ? 'border border-cyan-500/30 bg-cyan-500/15 text-cyan-300'
                : 'border border-transparent text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      {/*
        Écart entre comptes et fiches — OWNER et SUPER_ADMIN uniquement.
        Les comptes portant le rôle RESELLER sans fiche NE SONT PAS des
        revendeurs actifs : le serveur les traite comme de simples clients.
        Les afficher comme des « revendeurs » gonflerait le parc de 70 lignes
        fictives. Ce rapport est en lecture seule : aucune correction de masse.
      */}
      {isSuperAdmin && reconciliation && reconciliation.totals.orphanRoleUsers > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-200">
                {t('commerce.accounts.orphanCount', {
                  orphans: formatNumber(reconciliation.totals.orphanRoleUsers),
                  resellers: formatNumber(reconciliation.totals.resellerRecords),
                })}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-amber-200/80">
                {t('commerce.accounts.orphanHint')}
              </p>
              {reconciliation.totals.resellersWithoutRole > 0 && (
                <p className="mt-1 text-xs text-amber-200/80">
                  {t('commerce.accounts.missingRoleCount', { count: formatNumber(reconciliation.totals.resellersWithoutRole) })}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'resellers' && (
        <ResellersView currentUserRole={currentUserRole} actorName={actorName} />
      )}

      {tab === 'rbac' && (
        <RBACView
          currentUserRole={currentUserRole}
          onRolePermissionsUpdated={onRolePermissionsUpdated ?? (() => {})}
        />
      )}

      {tab === 'accounts' && (
        <>
          {/* Bandeau de création réussie */}
          {createdResult && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <BadgeCheck className="h-5 w-5 shrink-0 text-emerald-400" />
                  <span className="font-semibold text-emerald-400">
                    {t('commerce.accounts.created', { name: createdResult.name, role: createdResult.role })}
                  </span>
                </div>
                <button onClick={() => setCreatedResult(null)} className="text-gray-500 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-gray-300">{t('commerce.accounts.shareSecurely')}</p>

                <div className="flex items-center gap-2 rounded-lg bg-gray-900/60 px-3 py-2">
                  <span className="w-24 shrink-0 text-xs text-gray-400">{t('commerce.common.email')}</span>
                  <code className="flex-1 truncate font-mono text-sm text-white">{createdResult.email}</code>
                  <button onClick={() => copy('email', createdResult.email)} className="text-gray-400 hover:text-white">
                    {copiedField === 'email' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>

                {createdResult.generatedPassword && (
                  <div className="flex items-center gap-2 rounded-lg bg-gray-900/60 px-3 py-2">
                    <span className="w-24 shrink-0 text-xs text-gray-400">{t('commerce.common.password')}</span>
                    <code className="flex-1 truncate font-mono text-sm text-amber-300">{createdResult.generatedPassword}</code>
                    <button onClick={() => copy('pass', createdResult.generatedPassword!)} className="text-gray-400 hover:text-white">
                      {copiedField === 'pass' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                )}

                {createdResult.adminToken && (
                  <div className="flex items-center gap-2 rounded-lg bg-gray-900/60 px-3 py-2">
                    <span className="w-24 shrink-0 text-xs text-gray-400">{t('commerce.accounts.adminToken')}</span>
                    <code className="flex-1 truncate font-mono text-sm text-cyan-300">{createdResult.adminToken}</code>
                    <button onClick={() => copy('adminToken', createdResult.adminToken!)} className="text-gray-400 hover:text-white">
                      {copiedField === 'adminToken' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                )}
                {createdResult.expiresAt && (
                  <p className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock className="h-3 w-3" />
                    {t('commerce.accounts.tokenUntil', { date: new Date(createdResult.expiresAt).toLocaleString(locale) })}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Jeton généré */}
          {tokenResult && (
            <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-4">
              <div className="mb-3 flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Key className="h-4 w-4 text-cyan-400" />
                  <span className="text-sm font-semibold text-cyan-400">{t('commerce.accounts.adminTokenGenerated')}</span>
                </div>
                <button onClick={() => setTokenResult(null)} className="text-gray-500 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-gray-900/60 px-3 py-2">
                <code className="flex-1 font-mono text-sm text-cyan-300">{tokenResult.token}</code>
                <button onClick={() => copy('newToken', tokenResult.token)} className="text-gray-400 hover:text-white">
                  {copiedField === 'newToken' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {t('commerce.accounts.expiresAt', { date: new Date(tokenResult.expiresAt).toLocaleString(locale) })}
              </p>
            </div>
          )}

          {/* Recherche */}
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
            <input
              type="text"
              placeholder={t('commerce.accounts.search')}
              value={search}
              disabled={controlsBusy}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-gray-800 bg-gray-900/60 py-2 pl-9 pr-4 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            />
          </div>

          {isAdmin && <BulkDeleteControls controller={bulkDelete} hintKey="operations.bulkDelete.accountHint" />}

          {/* Tableau des comptes */}
          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-400">
              <RefreshCw className="mr-3 h-6 w-6 animate-spin text-cyan-400" />
              {t('commerce.common.loading')}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[#1a1f2e] bg-[#0f1218]">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#1a1f2e]">
                      {isAdmin && <th className="px-5 py-3 text-left text-xs text-gray-400">{t('operations.bulkDelete.selectColumn')}</th>}
                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">{t('commerce.common.account')}</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">{t('commerce.common.role')}</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">{t('commerce.common.status')}</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">{t('commerce.common.createdAt')}</th>
                      <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">{t('commerce.common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1a1f2e]">
                    {paginated.length === 0 && (
                      <tr>
                        <td colSpan={isAdmin ? 6 : 5} className="py-12 text-center text-gray-500">{t('commerce.accounts.empty')}</td>
                      </tr>
                    )}
                    {paginated.map((account) => {
                      const roleName = account.role;
                      const isOwn = account.id === currentUserId;
                      return (
                        <tr key={account.id} className="transition-colors hover:bg-white/[0.02]">
                          {isAdmin && <td className="px-5 py-3.5">
                            <input type="checkbox" checked={bulkDelete.selected.has(account.id)}
                              disabled={controlsBusy || !canDelete || !selectableAccount(account)}
                              aria-label={t('operations.bulkDelete.selectOne', { name: account.name || account.email || account.id })}
                              onChange={() => bulkDelete.toggle(account.id)} />
                          </td>}
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600">
                                <span className="text-xs font-bold text-white">
                                  {account.name?.charAt(0)?.toUpperCase() || '?'}
                                </span>
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-white">{account.name}</p>
                                <p className="truncate text-xs text-gray-500">{account.email}</p>
                                {account.phone && (
                                  <p className="text-xs text-gray-600">{account.phone}</p>
                                )}
                                {roleName === 'RESELLER' && (
                                  // Compte de connexion ≠ fiche revendeur : le dire
                                  // évite de prendre les 70 comptes historiques pour
                                  // autant de revendeurs actifs.
                                  <p className="mt-0.5 text-[11px] text-violet-300/80">
                                    {t('commerce.accounts.resellerAccountHint')}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <RoleBadge role={roleName} />
                          </td>
                          <td className="px-5 py-3.5">
                            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                              account.status === 'active'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-rose-500/10 text-rose-400'
                            }`}>
                              {account.status === 'active' ? t('commerce.common.activeDot') : t('commerce.common.suspendedDot')}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-xs text-gray-500">
                            {account.createdAt
                              ? new Date(account.createdAt).toLocaleDateString(locale)
                              : '—'}
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center justify-end gap-2">
                              {isAdmin && !isOwn && (
                                <>
                                  <button
                                    onClick={() => handleGenerateToken(account.id)}
                                    disabled={controlsBusy || generatingTokenFor === account.id}
                                    title={t('commerce.accounts.generateAccessToken')}
                                    className="flex items-center gap-1.5 rounded-lg bg-cyan-500/10 px-2.5 py-1.5 text-xs text-cyan-400 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
                                  >
                                    {generatingTokenFor === account.id
                                      ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                      : <Key className="h-3.5 w-3.5" />}
                                    {t('commerce.common.token')}
                                  </button>
                                  {roleName !== 'SUPER_ADMIN' && roleName !== 'OWNER' && (
                                    <button
                                      onClick={() => handleDelete(account.id, account.name)}
                                      disabled={controlsBusy || !canDelete}
                                      title={t('commerce.accounts.deleteAccount')}
                                      className="rounded-lg p-1.5 text-gray-600 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  )}
                                </>
                              )}
                              {isOwn && <span className="text-xs italic text-gray-600">{t('commerce.accounts.you')}</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-[#1a1f2e] px-4">
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={filtered.length}
                  disabled={controlsBusy}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
                />
              </div>
            </div>
          )}

          {/* Jetons d'accès récents */}
          {isAdmin && adminTokens.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                {t('commerce.accounts.recentTokens')}
              </h2>
              <div className="overflow-hidden rounded-xl border border-[#1a1f2e] bg-[#0f1218]">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#1a1f2e]">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase text-gray-500">{t('commerce.common.token')}</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase text-gray-500">{t('commerce.accounts.user')}</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase text-gray-500">{t('commerce.common.status')}</th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase text-gray-500">{t('commerce.common.expires')}</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase text-gray-500">{t('commerce.common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1a1f2e]">
                      {adminTokens.slice(0, 15).map((tok) => (
                        <tr key={tok.id} className="hover:bg-white/[0.02]">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-xs text-cyan-300">{tok.token}</code>
                              <button onClick={() => copy(tok.id, tok.token)} className="text-gray-600 hover:text-gray-300">
                                {copiedField === tok.id ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                              </button>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-300">{tok.user?.email ?? '—'}</td>
                          <td className="px-4 py-2.5">
                            <span className={`text-xs font-medium ${
                              tok.status === 'active' ? 'text-emerald-400' :
                              tok.status === 'used'   ? 'text-blue-400' :
                              'text-gray-500'
                            }`}>
                              {tok.status === 'active' ? t('commerce.common.activeDot') : tok.status === 'used' ? t('commerce.common.usedCheck') : t('commerce.common.revokedCross')}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-500">
                            {new Date(tok.expiresAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            {tok.status === 'active' && (
                              <button
                                onClick={() => handleRevokeToken(tok.id)}
                                disabled={controlsBusy}
                                className="rounded px-2 py-1 text-xs text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
                              >
                                {t('commerce.common.revoke')}
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
        </>
      )}

      {/* Création d'un compte */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-[#1a1f2e] bg-[#0d111b] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1a1f2e] px-6 py-4">
              <div className="flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-cyan-400" />
                <h2 className="text-base font-semibold text-white">{t('commerce.accounts.create')}</h2>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-gray-500 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4 px-6 py-5">
              {!!createError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-400">
                  {errorMessage(createError, 'commerce.common.errorCreate')}
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {t('commerce.common.fullNameRequired')}
                </label>
                <input
                  required
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('commerce.common.exampleName')}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {t('commerce.common.emailRequired')}
                </label>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder={t('commerce.common.exampleEmail')}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {t('commerce.common.phone')}
                </label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="+225 07 XX XX XX"
                  className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {t('commerce.common.roleRequired')}
                </label>
                <div className="relative">
                  <select
                    required
                    value={form.roleId}
                    onChange={(e) => { setForm({ ...form, roleId: e.target.value }); setCreateError(''); }}
                    className="w-full appearance-none rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 pr-8 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  >
                    <option value="">{t('commerce.accounts.selectRole')}</option>
                    {roles.filter(r => r.name !== 'RESELLER').map(r => (
                      <option key={r.id} value={r.id}>
                        {r.name} — {Object.hasOwn(ROLE_COLORS, r.name) ? t(`commerce.accounts.roleDescriptions.${r.name}`) : r.description}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                </div>
                {selectedRoleIsReseller && (
                  <div className="mt-2 rounded-lg border border-violet-500/30 bg-violet-500/10 p-3 text-xs text-violet-200">
                    <p className="font-semibold">{t('commerce.accounts.resellerNotHere')}</p>
                    <p className="mt-1 leading-relaxed">
                      {t('commerce.accounts.resellerCreationHint')}
                    </p>
                    <button
                      type="button"
                      onClick={() => { setShowCreateModal(false); setTab('resellers'); }}
                      className="mt-2 rounded-lg border border-violet-500/40 px-3 py-1.5 font-semibold text-violet-200 hover:bg-violet-500/15"
                    >
                      {t('commerce.accounts.openResellers')}
                    </button>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                    {t('commerce.common.password')}
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={autoGenPassword}
                      onChange={(e) => setAutoGenPassword(e.target.checked)}
                      className="rounded border-gray-700 bg-gray-900 text-cyan-500"
                    />
                    <span className="text-xs text-gray-500">{t('commerce.accounts.autoPassword')}</span>
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
                      placeholder={t('commerce.accounts.passwordMinimum')}
                      className="w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                )}
                {autoGenPassword && (
                  <p className="mt-1 text-xs text-gray-600">
                    {t('commerce.accounts.passwordHint')}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-gray-400">{t('commerce.common.status')}</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as any })}
                  className="rounded-lg border border-gray-800 bg-gray-900 px-2 py-1.5 text-xs text-white focus:outline-none"
                >
                  <option value="active">{t('commerce.common.active')}</option>
                  <option value="suspended">{t('commerce.common.suspended')}</option>
                </select>
              </div>

              <div className="mt-4 flex justify-end gap-2 border-t border-gray-900 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-gray-400 hover:bg-gray-800"
                >
                  {t('commerce.common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={creating || selectedRoleIsReseller}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-black shadow-lg hover:bg-cyan-400 disabled:opacity-50"
                >
                  {creating && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  {t('commerce.accounts.submit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="flex items-start gap-3 rounded-xl border border-cyan-800 bg-cyan-950/20 p-4 text-xs leading-relaxed text-cyan-300">
          <ShieldAlert className="h-5 w-5 shrink-0 text-cyan-400" />
          <p>{t('commerce.accounts.readOnly')}</p>
        </div>
      )}
    </div>
  );
}

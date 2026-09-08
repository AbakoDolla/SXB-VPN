import { useTranslation } from '../contexts/I18nContext';
import { isAdmin as isAdminRole, isReseller as isResellerRole } from '../lib/roles';
import React, { useEffect, useState, useMemo } from 'react';
import { UserRole } from '../types';
import {
  fetchSubscriptions, fetchSubStats, createSubscription,
  updateSubscription, deleteSubscription, revokeSubscription,
  bulkSubscriptions, BulkAction, BulkResult,
  Subscription,
} from '../api/subscriptions';
import { fetchVpnProfiles, fetchAssignedVpnProfiles, VpnProfile } from '../api/vpn-profiles';
import { fetchClients } from '../api/clients';
import { Client } from '../types';
import { useResellerAccess } from '../contexts/ResellerAccessContext';
import { usePermissions } from '../contexts/PermissionsContext';
import { ResellerAccessSummaryCard, ResellerActionNotice } from './ResellerAccessBanner';
import { formatBytes, isUpperRole, ownerLabel, percentOf, toBigInt } from '../lib/resellerAccess';
import {
  PackageOpen, Plus, Trash2, RefreshCw, ShieldOff, Search,
  Calendar, HardDrive, Cpu, X, AlertTriangle, CheckCircle,
  Clock, Edit3, ChevronDown, PauseCircle, PlayCircle, Store,
} from 'lucide-react';
import Pagination from './ui/Pagination';
import { toast } from 'sonner';

interface Props { currentUserRole: UserRole }

const createStatusConfig = (t: ReturnType<typeof useTranslation>['t']): Record<string, { label: string; cls: string }> => ({
  active:    { label: t('commerce.common.active'),    cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  expired:   { label: t('commerce.common.expired'),  cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  revoked:   { label: t('commerce.common.revoked'), cls: 'text-rose-400 bg-rose-500/10 border-rose-500/20' },
  suspended: { label: t('commerce.common.suspended'), cls: 'text-gray-400 bg-gray-500/10 border-gray-500/20' },
});

function bytesToGigabytes(value: string | number): number {
  const bytes = toBigInt(value) ?? BigInt(0);
  const tenths = (bytes * BigInt(10)) / (BigInt(1024) ** BigInt(3));
  return Number(tenths) / 10;
}

function fmtDate(d: string | null, locale: string) {
  if (!d) return '—';
  return new Date(d).toLocaleString(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const DEFAULT_FORM = {
  clientId: '', profileId: '', name: '', quotaGB: 5, durationDays: 30, deviceLimit: 1,
};
// ── Opérations groupées ──────────────────────────────────────────────────────
// « Définir » et « Ajouter » sont volontairement deux entrées distinctes : les
// confondre ferait perdre le solde d'un client. Le libellé dit ce que l'action
// FAIT, pas seulement son nom.
const createBulkActions = (t: ReturnType<typeof useTranslation>['t']): Array<{ id: BulkAction; label: string; hint: string; needsProfile: boolean; needsQuota: boolean; needsDuration: boolean }> => [
  { id: 'deploy',          label: t('commerce.subscriptions.bulk.deploy'), hint: t('commerce.subscriptions.bulk.deployHint'), needsProfile: true,  needsQuota: true,  needsDuration: true },
  { id: 'set',             label: t('commerce.subscriptions.bulk.set'),          hint: t('commerce.subscriptions.bulk.setHint'), needsProfile: false, needsQuota: true,  needsDuration: true },
  { id: 'add_data',        label: t('commerce.subscriptions.bulk.addData'),   hint: t('commerce.subscriptions.bulk.addDataHint'), needsProfile: false, needsQuota: true,  needsDuration: false },
  { id: 'extend_duration', label: t('commerce.subscriptions.bulk.extend'), hint: t('commerce.subscriptions.bulk.extendHint'), needsProfile: false, needsQuota: false, needsDuration: true },
];

export default function SubscriptionsView({ currentUserRole }: Props) {
  const { t, locale, formatNumber, message, errorMessage, errorText } = useTranslation();
  const STATUS_CFG = createStatusConfig(t);
  const BULK_ACTIONS = createBulkActions(t);
  const isAdmin = isAdminRole(currentUserRole);
  const isReseller = isResellerRole(currentUserRole);
  const showsOwnerColumn = isUpperRole(currentUserRole);
  // Le revendeur attribue lui-même les plans de SES clients : lui réserver
  // l'écran en lecture seule le rendait dépendant d'un administrateur pour
  // chaque vente. Ce qui l'arrête n'est pas son rôle, mais l'état de son
  // agrément et de son plafond — c'est le serveur qui tranche.
  const can = usePermissions();
  const canAssign = (isAdmin || isReseller) && can('subscription.manage');
  const { allows, blocked, quotaReached, refresh: refreshAccess } = useResellerAccess();
  const canCreate = canAssign && allows();
  const canReduce = canAssign && allows({ reducesExposure: true });

  const [subs, setSubs] = useState<Subscription[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, expired: 0 });
  const [clients, setClients] = useState<Client[]>([]);
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [editSub, setEditSub] = useState<Subscription | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  // Sélection et opérations groupées
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction>('add_data');
  const [bulkQuota, setBulkQuota] = useState(5);
  const [bulkDays, setBulkDays] = useState(30);
  const [bulkProfile, setBulkProfile] = useState('');
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [s, st, cl, pr] = await Promise.all([
        fetchSubscriptions(),
        fetchSubStats(),
        can('clients.view') ? fetchClients() : Promise.resolve([]),
        // Le revendeur n'a pas accès à `/vpn-profiles` (403) : sa liste de
        // configurations restait vide et le formulaire refusait toute création,
        // faute de profil sélectionnable. Il lit donc celles qui lui sont
        // attribuées, sans aucun paramètre technique.
        canAssign ? (isReseller ? fetchAssignedVpnProfiles() : fetchVpnProfiles()) : Promise.resolve([]),
      ]);
      setSubs(s);
      setStats(st);
      setClients(cl);
      setProfiles(pr);
    } catch (err: any) {
      toast.error(errorText(err, 'commerce.common.errorLoad'));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Filter + pagination
  const filtered = useMemo(() => subs.filter(s => {
    const clientName = s.client?.user?.name || s.client?.token || '';
    const matchSearch = search === '' ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.dataToken.toLowerCase().includes(search.toLowerCase()) ||
      clientName.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || s.status === statusFilter;
    return matchSearch && matchStatus;
  }), [subs, search, statusFilter]);

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  // Reset page when filter changes
  useEffect(() => setPage(1), [search, statusFilter]);

  const openCreate = () => {
    setEditSub(null);
    setForm({ ...DEFAULT_FORM });
    setFormError('');
    setShowModal(true);
  };

  const openEdit = (sub: Subscription) => {
    setEditSub(sub);
    setForm({
      clientId: sub.clientId,
      profileId: sub.profileId,
      name: sub.name,
      quotaGB: bytesToGigabytes(sub.quotaBytes) || 5,
      durationDays: sub.durationDays,
      deviceLimit: sub.deviceLimit,
    });
    setFormError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.clientId || !form.profileId) { setFormError('commerce.subscriptions.required'); return; }
    setSaving(true); setFormError('');
    try {
      if (editSub) {
        await updateSubscription(editSub.id, {
          name: form.name.trim() || undefined,
          // La configuration peut changer sans recréer le jeton data : une
          // suppression suivie d'une recréation obligerait le client à
          // réactiver son appareil.
          profileId: form.profileId,
          quotaGB: form.quotaGB,
          durationDays: form.durationDays,
          deviceLimit: form.deviceLimit,
        });
        toast.success(message('commerce.subscriptions.updated'));
      } else {
        await createSubscription(form);
        toast.success(message('commerce.subscriptions.created'));
      }
      setShowModal(false);
      await Promise.all([load(), refreshAccess()]);
    } catch (err: any) {
      // Un refus d'agrément ou de plafond porte un code stable : il ne doit
      // jamais être présenté comme un échec générique, ni — pire — ignoré.
      setFormError(err);
    } finally { setSaving(false); }
  };

  /** Suspendre / réactiver : action RÉDUCTRICE, ouverte même au plafond. */
  const handleToggleStatus = async (sub: Subscription) => {
    const suspending = sub.status === 'active';
    if (!window.confirm(t(suspending ? 'commerce.subscriptions.confirmSuspend' : 'commerce.subscriptions.confirmReactivate', { name: sub.name }))) return;
    try {
      await updateSubscription(sub.id, { status: suspending ? 'suspended' : 'active' });
      toast.success(message(suspending ? 'commerce.subscriptions.suspended' : 'commerce.subscriptions.reactivated'));
      await Promise.all([load(), refreshAccess()]);
    } catch (err: any) { toast.error(errorText(err, 'commerce.common.errorStatus')); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(t('commerce.subscriptions.confirmDelete', { name }))) return;
    try {
      await deleteSubscription(id);
      toast.success(message('commerce.subscriptions.deleted'));
      await Promise.all([load(), refreshAccess()]);
    } catch (err: any) { toast.error(errorText(err, 'commerce.common.errorDelete')); }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!window.confirm(t('commerce.subscriptions.confirmRevoke', { name }))) return;
    try {
      await revokeSubscription(id, 'Révoqué par admin');
      toast.success(message('commerce.subscriptions.revoked'));
      await Promise.all([load(), refreshAccess()]);
    } catch (err: any) { toast.error(errorText(err, 'commerce.common.errorRevoke')); }
  };

  // Export CSV
  const exportCSV = () => {
    const rows = [
      [t('commerce.common.name'), t('commerce.common.client'), t('commerce.common.profile'), t('commerce.common.quota'), t('commerce.common.used'), t('commerce.common.duration'), t('commerce.common.expiration'), t('commerce.common.status'), t('commerce.common.tokenTechnical')],
      ...filtered.map(s => [
        s.name,
        s.client?.user?.name || s.clientId,
        s.profile?.name || s.profileId,
        formatBytes(s.quotaBytes),
        formatBytes(s.quotaUsed),
        t('commerce.common.daysShort', { count: formatNumber(s.durationDays) }),
        fmtDate(s.expireAt, locale),
        STATUS_CFG[s.status]?.label || s.status,
        s.dataToken,
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = t('commerce.subscriptions.exportFilename'); a.click();
    URL.revokeObjectURL(url);
    toast.success(message('commerce.subscriptions.exported'));
  };

  const clientMap = useMemo(() => Object.fromEntries(clients.map(c => [c.id, c])), [clients]);

  // ── Opérations groupées ────────────────────────────────────────────────────
  const bulkCfg = BULK_ACTIONS.find(a => a.id === bulkAction)!;
  // Seule `extend_duration` n'augmente pas le volume engagé, mais elle prolonge
  // l'engagement : toutes ces actions sont traitées comme augmentatrices, donc
  // fermées quand l'agrément ou le plafond l'exigent.
  const bulkAllowed = canAssign && allows();

  const toggleOne = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // « Tout sélectionner » porte sur la sélection FILTRÉE, pas sur la page
  // courante : sinon l'opérateur croirait viser 150 forfaits et n'en toucherait
  // que les 20 affichés.
  const selectAllFiltered = () => setSelected(new Set(filtered.map(s => s.id)));
  const clearSelection = () => setSelected(new Set());

  const runBulk = async () => {
    setBulkRunning(true);
    try {
      const ids = Array.from(selected);
      // `deploy` crée des forfaits : il vise des CLIENTS. Les autres modifient
      // l'existant : elles visent des ABONNEMENTS.
      const clientIds = bulkAction === 'deploy'
        ? Array.from(new Set(subs.filter(s => selected.has(s.id)).map(s => s.clientId)))
        : undefined;

      const result = await bulkSubscriptions({
        action: bulkAction,
        ...(bulkAction === 'deploy' ? { clientIds } : { subscriptionIds: ids }),
        ...(bulkCfg.needsProfile ? { profileId: bulkProfile } : {}),
        ...(bulkCfg.needsQuota ? { quotaGB: bulkQuota } : {}),
        ...(bulkCfg.needsDuration ? { durationDays: bulkDays } : {}),
      });
      setBulkResult(result);
      setBulkConfirm(false);
      if (result.failed > 0) toast.warning(message('commerce.subscriptions.bulk.partial', { succeeded: result.succeeded, failed: result.failed }));
      else toast.success(message('commerce.subscriptions.bulk.updated', { count: result.succeeded }));
      clearSelection();
      await Promise.all([load(), refreshAccess()]);
    } catch (err: any) {
      toast.error(errorText(err, 'commerce.subscriptions.bulk.error'));
      setBulkConfirm(false);
    } finally { setBulkRunning(false); }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <PackageOpen className="w-6 h-6 text-cyan-400" />
            {t('commerce.subscriptions.title')}
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            {isReseller
              ? t('commerce.subscriptions.resellerSubtitle')
              : t('commerce.subscriptions.adminSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-400 bg-[#0f1218] border border-[#1a1f2e] rounded-lg hover:text-white hover:border-[#252b3b] transition-all cursor-pointer">
            {t('commerce.subscriptions.export')}
          </button>
          {canAssign && (
            <button
              onClick={openCreate}
              disabled={!canCreate}
              title={canCreate ? t('commerce.subscriptions.assignClient') : t('commerce.common.unavailableAccess')}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
              <Plus className="w-4 h-4" /> {t('commerce.subscriptions.assign')}
            </button>
          )}
        </div>
      </div>

      {isReseller && <ResellerAccessSummaryCard />}
      {canAssign && <ResellerActionNotice />}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: t('commerce.common.total'), value: stats.total, icon: PackageOpen, color: 'text-white' },
          { label: t('commerce.common.activePlural'), value: stats.active, icon: CheckCircle, color: 'text-emerald-400' },
          { label: t('commerce.common.expiredPlural'), value: stats.expired, icon: Clock, color: 'text-amber-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <Icon className={`w-4 h-4 ${color}`} />
              <p className="text-xs text-gray-500">{label}</p>
            </div>
            <p className={`text-2xl font-bold ${color}`}>{loading ? '—' : formatNumber(value)}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('commerce.subscriptions.search')}
            className="w-full pl-9 pr-4 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {['all', 'active', 'expired', 'revoked', 'suspended'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border capitalize transition-all cursor-pointer ${
                statusFilter === s
                  ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400'
                  : 'bg-[#0a0d14] border-[#1a1f2e] text-gray-500 hover:text-gray-200'
              }`}>
              {s === 'all' ? t('commerce.common.all') : STATUS_CFG[s]?.label || s}
            </button>
          ))}
        </div>
      </div>

      {/* Opérations groupées — visibles dès qu'un forfait est sélectionné */}
      {selected.size > 0 && (
        <div className="bg-[#0f1218] border border-cyan-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold text-white">
              {t('commerce.subscriptions.bulk.selection', { count: formatNumber(selected.size) })}
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={selectAllFiltered}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-[#1a1f2e] text-gray-300 hover:bg-white/5 cursor-pointer">
                {t('commerce.subscriptions.bulk.selectAll', { count: formatNumber(filtered.length) })}
              </button>
              <button type="button" onClick={clearSelection}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-[#1a1f2e] text-gray-400 hover:bg-white/5 cursor-pointer">
                {t('commerce.subscriptions.bulk.clearSelection')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs text-gray-400 mb-1.5">{t('commerce.common.action')}</label>
              <select value={bulkAction} onChange={e => { setBulkAction(e.target.value as BulkAction); setBulkResult(null); }}
                className="w-full px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500">
                {BULK_ACTIONS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
              <p className="text-[11px] text-gray-500 mt-1">{bulkCfg.hint}</p>
            </div>
            {bulkCfg.needsProfile && (
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">{t('commerce.common.configuration')}</label>
                <select value={bulkProfile} onChange={e => setBulkProfile(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500">
                  <option value="">{t('commerce.common.choose')}</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            {bulkCfg.needsQuota && (
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">
                  {bulkAction === 'add_data' ? t('commerce.subscriptions.bulk.addGb') : t('commerce.subscriptions.bulk.dataGb')}
                </label>
                <input type="number" min={0} step={0.5} value={bulkQuota}
                  onChange={e => setBulkQuota(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500" />
              </div>
            )}
            {bulkCfg.needsDuration && (
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">
                  {bulkAction === 'extend_duration' ? t('commerce.subscriptions.bulk.addDays') : t('commerce.common.durationDays')}
                </label>
                <input type="number" min={0} value={bulkDays}
                  onChange={e => setBulkDays(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500" />
              </div>
            )}
          </div>

          <button type="button" onClick={() => setBulkConfirm(true)}
            disabled={bulkRunning || (bulkCfg.needsProfile && !bulkProfile) || !bulkAllowed}
            title={bulkAllowed ? undefined : t('commerce.common.unavailableAccess')}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black transition-all disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed">
            {bulkRunning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            {t('commerce.subscriptions.bulk.apply', { count: formatNumber(selected.size) })}
          </button>
        </div>
      )}

      {/* Récapitulatif d'exécution — l'opérateur doit savoir QUI a échoué et POURQUOI */}
      {bulkResult && (
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-white">{t('commerce.subscriptions.bulk.done')}</p>
            <button type="button" onClick={() => setBulkResult(null)}
              className="text-gray-500 hover:text-gray-300 cursor-pointer"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex gap-4 text-xs flex-wrap">
            <span className="text-gray-400">{t('commerce.subscriptions.bulk.selected', { count: formatNumber(bulkResult.selected) })}</span>
            <span className="text-emerald-400">{t('commerce.subscriptions.bulk.succeeded', { count: formatNumber(bulkResult.succeeded) })}</span>
            {bulkResult.skipped > 0 && <span className="text-gray-400">{t('commerce.subscriptions.bulk.skipped', { count: formatNumber(bulkResult.skipped) })}</span>}
            {bulkResult.failed > 0 && <span className="text-rose-400">{t('commerce.subscriptions.bulk.failed', { count: formatNumber(bulkResult.failed) })}</span>}
          </div>
          {bulkResult.failed > 0 && (
            <ul className="text-[11px] text-rose-300/80 space-y-0.5 max-h-40 overflow-y-auto">
              {bulkResult.details.filter(d => d.status === 'failed').map(d => (
                <li key={d.id}>• {d.id} — {errorMessage(d.reason, 'commerce.subscriptions.bulk.unknownReason')}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Confirmation — une opération groupée touche beaucoup de clients d'un coup */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-[#0f1218] border border-[#252b3b] rounded-xl p-5 max-w-md w-full space-y-3">
            <h3 className="text-base font-semibold text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" /> {t('commerce.subscriptions.bulk.confirm')}
            </h3>
            <div className="text-sm text-gray-300 space-y-1">
              <p><span className="text-gray-500">{t('commerce.subscriptions.bulk.actionLabel')}</span> {bulkCfg.label}</p>
              <p><span className="text-gray-500">{t('commerce.subscriptions.bulk.plansLabel')}</span> {formatNumber(selected.size)}</p>
              {bulkCfg.needsProfile && (
                <p><span className="text-gray-500">{t('commerce.subscriptions.bulk.configurationLabel')}</span> {profiles.find(p => p.id === bulkProfile)?.name || '—'}</p>
              )}
              {bulkCfg.needsQuota && (
                <p><span className="text-gray-500">{t('commerce.subscriptions.bulk.dataLabel')}</span> {formatNumber(bulkQuota, { signDisplay: bulkAction === 'add_data' ? 'always' : 'auto' })} {t('commerce.common.gb')}</p>
              )}
              {bulkCfg.needsDuration && (
                <p><span className="text-gray-500">{t('commerce.subscriptions.bulk.durationLabel')}</span> {t('commerce.common.days', { count: formatNumber(bulkDays, { signDisplay: bulkAction === 'extend_duration' ? 'always' : 'auto' }) })}</p>
              )}
            </div>
            <p className="text-[11px] text-amber-300/80">{bulkCfg.hint}</p>
            <div className="flex gap-2 justify-end pt-1">
              <button type="button" onClick={() => setBulkConfirm(false)}
                className="px-3 py-2 text-xs rounded-lg border border-[#1a1f2e] text-gray-300 hover:bg-white/5 cursor-pointer">
                {t('commerce.common.cancel')}
              </button>
              <button type="button" onClick={runBulk} disabled={bulkRunning}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black disabled:opacity-50 cursor-pointer">
                {bulkRunning ? t('commerce.subscriptions.bulk.applying') : t('commerce.common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
            {t('commerce.common.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <PackageOpen className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">{t('commerce.subscriptions.empty')}</p>
            {canCreate && (
              <button onClick={openCreate} className="mt-3 text-cyan-400 hover:text-cyan-300 text-sm cursor-pointer">
                {t('commerce.subscriptions.createFirst')}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1f2e] bg-[#0a0d14]">
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        aria-label={t('commerce.subscriptions.selectPage')}
                        checked={paginated.length > 0 && paginated.every(s => selected.has(s.id))}
                        onChange={e => setSelected(prev => {
                          const next = new Set(prev);
                          paginated.forEach(s => e.target.checked ? next.add(s.id) : next.delete(s.id));
                          return next;
                        })}
                        className="rounded border-[#1a1f2e] bg-[#07090e] accent-cyan-500 cursor-pointer"
                      />
                    </th>
                    {[t('commerce.common.name'), t('commerce.common.client')].map(h => (
                      <th key={h} className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{h}</th>
                    ))}
                    {showsOwnerColumn && (
                      <th className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{t('commerce.common.reseller')}</th>
                    )}
                    {[t('commerce.common.vpnProfile'), t('commerce.common.quota'), t('commerce.common.consumption'), t('commerce.common.duration'), t('commerce.common.expiration'), t('commerce.common.status'), ''].map(h => (
                      <th key={h} className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1f2e]">
                  {paginated.map(sub => {
                    const pct = percentOf(sub.quotaUsed, sub.quotaBytes);
                    const cfg = STATUS_CFG[sub.status] || STATUS_CFG.active;
                    const client = clientMap[sub.clientId];
                    return (
                      <tr key={sub.id} className={`hover:bg-white/[0.02] transition-colors ${selected.has(sub.id) ? 'bg-cyan-500/5' : ''}`}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={t('commerce.subscriptions.selectPlan', { name: sub.name })}
                            checked={selected.has(sub.id)}
                            onChange={() => toggleOne(sub.id)}
                            className="rounded border-[#1a1f2e] bg-[#07090e] accent-cyan-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-white font-medium">{sub.name}</p>
                          <p className="text-xs text-gray-600 font-mono">{sub.dataToken}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm text-gray-300">{sub.client?.user?.name || client?.user?.name || '—'}</p>
                          <p className="text-xs text-gray-600">{sub.client?.user?.email || '—'}</p>
                        </td>
                        {showsOwnerColumn && (
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300">
                              <Store className="w-3 h-3 shrink-0" />
                              {ownerLabel(sub.resellerName ?? sub.client?.reseller?.name ?? (client as any)?.resellerName ?? null)}
                            </span>
                          </td>
                        )}
                        <td className="px-4 py-3">
                          <span className="text-xs text-gray-400">{sub.profile?.name || '—'}</span>
                          {sub.profile?.protocol && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 uppercase">{sub.profile.protocol}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="space-y-1 min-w-[100px]">
                            <div className="flex justify-between text-[11px] text-gray-500">
                              <span>{formatBytes(sub.quotaUsed)}</span>
                              <span>{formatBytes(sub.quotaBytes)}</span>
                            </div>
                            <div className="w-full h-1 bg-[#1a1f2e] rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${pct > 90 ? 'bg-rose-500' : pct > 70 ? 'bg-amber-500' : 'bg-cyan-500'}`}
                                style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        </td>
                        {/* Consommation : ce qui a réellement été écoulé, distinct
                            du volume engagé qui décompte le plafond du revendeur. */}
                        <td className="px-4 py-3">
                          <p className="text-xs text-white">{t('commerce.subscriptions.consumed', { value: formatBytes(String(sub.quotaUsed ?? 0)) })}</p>
                          <p className="text-[11px] text-gray-500">
                            {t('commerce.subscriptions.percentUsed', { value: formatNumber(pct / 100, { style: 'percent', maximumFractionDigits: 0 }) })}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">{t('commerce.common.daysShort', { count: formatNumber(sub.durationDays) })}</td>
                        <td className="px-4 py-3 text-xs text-gray-400 font-mono">{fmtDate(sub.expireAt, locale)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.cls}`}>
                            {cfg.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {canAssign && (
                            <div className="flex items-center gap-1">
                              <button onClick={() => openEdit(sub)} title={t('commerce.common.edit')}
                                disabled={!canCreate}
                                className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              {/* Suspendre / réactiver : gestes RÉDUCTEURS, ouverts
                                  même quand le plafond est atteint. */}
                              <button onClick={() => handleToggleStatus(sub)}
                                disabled={!canReduce || sub.status === 'revoked'}
                                title={sub.status === 'active' ? t('commerce.common.suspend') : t('commerce.common.reactivate')}
                                className="p-1.5 text-gray-500 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
                                {sub.status === 'active'
                                  ? <PauseCircle className="w-3.5 h-3.5" />
                                  : <PlayCircle className="w-3.5 h-3.5" />}
                              </button>
                              {sub.status === 'active' && (
                                <button onClick={() => handleRevoke(sub.id, sub.name)} title={t('commerce.common.revoke')}
                                  disabled={!canReduce}
                                  className="p-1.5 text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
                                  <ShieldOff className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button onClick={() => handleDelete(sub.id, sub.name)} title={t('commerce.common.delete')}
                                disabled={!canReduce}
                                className="p-1.5 text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#1a1f2e] px-4">
              <Pagination page={page} pageSize={pageSize} total={filtered.length}
                onPageChange={setPage} onPageSizeChange={p => { setPageSize(p); setPage(1); }} />
            </div>
          </>
        )}
      </div>

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0f1218] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold flex items-center gap-2">
                <PackageOpen className="w-4 h-4 text-cyan-400" />
                {editSub ? t('commerce.subscriptions.edit') : t('commerce.subscriptions.assignClient')}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 text-gray-500 hover:text-white rounded-lg cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {!!formError && (
                <div role="alert" className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {errorMessage(formError, 'commerce.common.errorSave')}
                </div>
              )}

              {!editSub && (
                <p className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs leading-relaxed text-cyan-200">
                  {t('commerce.subscriptions.assignHint')}
                </p>
              )}

              <div>
                <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t('commerce.common.vpnClientRequired')}</label>
                <div className="relative">
                  <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} required
                    disabled={!!editSub}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 appearance-none cursor-pointer disabled:opacity-60">
                    <option value="">{t('commerce.common.chooseClient')}</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>
                        {(c as any).user?.name || c.name || c.token || c.id}
                        {showsOwnerColumn && c.resellerName ? ` — ${ownerLabel(c.resellerName)}` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                </div>
                {clients.length === 0 && (
                  <p className="mt-1 text-[11px] text-amber-400">
                    {t('commerce.subscriptions.noClients')}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t('commerce.subscriptions.configurationRequired')}</label>
                <div className="relative">
                  <select value={form.profileId} onChange={e => setForm(f => ({ ...f, profileId: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 appearance-none cursor-pointer">
                    <option value="">{t('commerce.subscriptions.selectConfiguration')}</option>
                    {profiles.filter(p => !p.status || p.status === 'active').map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.displayProtocol ? ` (${p.displayProtocol})` : p.protocol ? ` (${p.protocol})` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                </div>
                {isReseller && profiles.length === 0 && (
                  <p className="mt-1 text-[11px] text-amber-400">
                    {t('commerce.subscriptions.noConfigurations')}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t('commerce.subscriptions.optionalName')}</label>
                <input value={form.name} maxLength={160} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t('commerce.subscriptions.autoName')}
                  className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t('commerce.common.quotaGbRequired')}</label>
                  <input type="number" min={0.5} max={1_000_000} step={0.5} value={form.quotaGB}
                    onChange={e => setForm(f => ({ ...f, quotaGB: Number(e.target.value) }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t('commerce.common.durationDays')}</label>
                  <input type="number" min={1} max={3650} step={1} value={form.durationDays}
                    onChange={e => setForm(f => ({ ...f, durationDays: Number(e.target.value) }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t('commerce.common.devices')}</label>
                  <input type="number" min={1} max={10} value={form.deviceLimit}
                    onChange={e => setForm(f => ({ ...f, deviceLimit: Number(e.target.value) }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-4 border-t border-[#1a1f2e]">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 bg-[#0a0d14] border border-[#1a1f2e] rounded-xl hover:text-white transition-all cursor-pointer">
                  {t('commerce.common.cancel')}
                </button>
                <button type="submit" disabled={saving || !canCreate}
                  title={canCreate ? undefined : t('commerce.common.unavailableAccess')}
                  className="px-5 py-2 text-sm font-semibold bg-cyan-500 hover:bg-cyan-400 text-black rounded-xl transition-all disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed flex items-center gap-2">
                  {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  {editSub ? t('commerce.common.update') : t('commerce.subscriptions.submit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

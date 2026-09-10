import { useTranslation } from '../contexts/I18nContext';
import { isAdmin as isAdminRole, isReseller as isResellerRole } from '../lib/roles';
import React, { useEffect, useState, useMemo } from 'react';
import { UserRole } from '../types';
import {
  fetchSubscriptions, fetchSubStats, createSubscription,
  updateSubscription, deleteSubscription, revokeSubscription,
  bulkSubscriptions, BulkValueMode, BulkPayload, BulkResult, MAX_BULK_APPLY,
  Subscription,
} from '../api/subscriptions';
import { fetchVpnProfiles, fetchAssignedVpnProfiles, VpnProfile } from '../api/vpn-profiles';
import { fetchClients } from '../api/clients';
import { Client } from '../types';
import { useResellerAccess } from '../contexts/ResellerAccessContext';
import { usePermissions } from '../contexts/PermissionsContext';
import { ResellerAccessSummaryCard, ResellerActionNotice } from './ResellerAccessBanner';
import { formatBytes, isUpperRole, ownerLabel, percentOf, toBigInt } from '../lib/resellerAccess';
import { canResumeSubscription, hasExpired, isPlanExhausted, lifecycleBadges, subscriptionStatus } from '../lib/lifecycle';
import { useActionLock } from '../hooks/useActionLock';
import { useBulkDelete } from '../hooks/useBulkDelete';
import BulkDeleteControls from './BulkDeleteControls';
import SubscriptionAdjustmentDialog, { SubscriptionAdjustment } from './SubscriptionAdjustmentDialog';
import {
  PackageOpen, Plus, Trash2, RefreshCw, ShieldOff, Search,
  Calendar, HardDrive, Cpu, X, AlertTriangle, CheckCircle,
  Clock, Edit3, ChevronDown, PauseCircle, PlayCircle, Store,
} from 'lucide-react';
import Pagination from './ui/Pagination';
import { toast } from 'sonner';

interface Props { currentUserRole: UserRole }

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
// L'écran n'offrait qu'UNE action à la fois : pour attribuer un serveur, un
// volume ET une échéance à cent clients, l'exploitant devait enchaîner trois
// opérations sans jamais voir l'ensemble de ce qu'il appliquait. Pire, le
// sélecteur de configuration n'était rendu que par l'action « déployer », donc
// invisible dans tous les autres cas.
//
// Le formulaire ci-dessous montre TOUS les champs en même temps ; chacun est
// indépendamment facultatif, et ce qui est laissé vide n'est pas réécrit.
// « Remplacer » et « Ajouter » restent deux modes nommés — les confondre ferait
// perdre à un client le solde qu'il n'a pas encore consommé.
type BulkScope = 'apply' | 'deploy';
type ExpiryMode = 'duration' | 'date';

/** Bornes partagées avec la validation du serveur. */
const QUOTA_MIN = 0.5, QUOTA_MAX = 1_000_000, DAYS_MIN = 1, DAYS_MAX = 3650;

/** Une saisie vide vaut « ne pas modifier », jamais zéro. */
function optionalNumber(raw: string): number | undefined {
  return raw.trim() === '' ? undefined : Number(raw);
}

/** `datetime-local` → Date locale. `null` signale une saisie inexploitable. */
function optionalInstant(raw: string): Date | undefined | null {
  if (!raw.trim()) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}


export default function SubscriptionsView({ currentUserRole }: Props) {
  const { t, locale, formatNumber, message, errorMessage, errorText } = useTranslation();
  const STATUS_CFG = lifecycleBadges(t);
  const isAdmin = isAdminRole(currentUserRole);
  const isReseller = isResellerRole(currentUserRole);
  const showsOwnerColumn = isUpperRole(currentUserRole);
  // Le revendeur attribue lui-même les plans de SES clients : lui réserver
  // l'écran en lecture seule le rendait dépendant d'un administrateur pour
  // chaque vente. Ce qui l'arrête n'est pas son rôle, mais l'état de son
  // agrément et de son plafond — c'est le serveur qui tranche.
  const can = usePermissions();
  const canAssign = (isAdmin || isReseller) && can('subscription.manage');
  const { access, allows, refresh: refreshAccess } = useResellerAccess();
  const canCreate = canAssign && allows();
  const canReduce = canAssign && allows({ reducesExposure: true });

  const [subs, setSubs] = useState<Subscription[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, expired: 0 });
  const [clients, setClients] = useState<Client[]>([]);
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const { pending, run } = useActionLock();
  const [adjustment, setAdjustment] = useState<{ subscription: Subscription; action: SubscriptionAdjustment } | null>(null);

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
  const saving = pending === 'save';
  const [formError, setFormError] = useState<unknown>(null);

  // Sélection et opérations groupées
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkScope, setBulkScope] = useState<BulkScope>('apply');
  // Chaînes et non nombres : « vide » doit rester distinct de « 0 ».
  const [bulkQuota, setBulkQuota] = useState('');
  const [bulkQuotaMode, setBulkQuotaMode] = useState<BulkValueMode>('set');
  const [bulkStart, setBulkStart] = useState('');
  const [bulkExpiryMode, setBulkExpiryMode] = useState<ExpiryMode>('duration');
  const [bulkDays, setBulkDays] = useState('');
  const [bulkDurationMode, setBulkDurationMode] = useState<BulkValueMode>('set');
  const [bulkExpire, setBulkExpire] = useState('');
  const [bulkProfile, setBulkProfile] = useState('');
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const bulkRunning = pending === 'bulk';
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [profilesError, setProfilesError] = useState<unknown>(null);

  const resetBulkFields = () => {
    setBulkQuota(''); setBulkStart(''); setBulkDays(''); setBulkExpire(''); setBulkProfile('');
    setBulkQuotaMode('set'); setBulkDurationMode('set'); setBulkExpiryMode('duration');
  };

  const load = async () => {
    setLoading(true);
    try {
      // ── Liste des configurations attribuables ──────────────────────────────
      // CAUSE RACINE n°2 du sélecteur de serveur vide : `/vpn-profiles` exige
      // la permission `vpnprofile.view`, qu'un administrateur habilité à vendre
      // (`subscription.manage`) ne porte pas nécessairement. L'appel répondait
      // alors 403, ce qui faisait échouer le `Promise.all` ENTIER : ni les
      // forfaits, ni les clients, ni les configurations n'étaient chargés, et
      // le sélecteur restait vide sans la moindre explication.
      //
      // Le partage reste celui d'origine — le revendeur ne lit QUE ses
      // configurations attribuées, jamais le parc entier. Ce qui change : le
      // repli du rôle supérieur sur `/vpn-profiles/assigned`, route de
      // sélection qui n'exige aucune permission technique, et l'isolement de
      // l'échec, conservé pour être expliqué à l'écran plutôt que de laisser
      // une liste vide et muette.
      const profilesPromise: Promise<VpnProfile[]> = canAssign
        ? (isReseller ? fetchAssignedVpnProfiles() : fetchVpnProfiles())
            .catch(async (err: unknown) => {
              // Un revendeur n'a pas de repli : élargir sa lecture au parc
              // entier lui montrerait des serveurs qui ne lui sont pas confiés.
              if (isReseller) throw err;
              return fetchAssignedVpnProfiles();
            })
        : Promise.resolve([]);
      const [s, st, cl, pr] = await Promise.all([
        fetchSubscriptions(),
        fetchSubStats(),
        can('clients.view') ? fetchClients() : Promise.resolve([]),
        profilesPromise.then(
          list => ({ list, error: null as unknown }),
          error => ({ list: [] as VpnProfile[], error }),
        ),
      ]);
      setSubs(s);
      setStats(st);
      setClients(cl);
      setProfiles(pr.list);
      setProfilesError(pr.error);
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
    const matchStatus = statusFilter === 'all' || subscriptionStatus(s) === statusFilter;
    return matchSearch && matchStatus;
  }), [subs, search, statusFilter]);

  const ownsSubscription = (sub: Subscription) => !isReseller || !!access?.resellerId
    && (sub.resellerId ?? sub.client?.resellerId ?? clients.find(client => client.id === sub.clientId)?.resellerId) === access.resellerId;
  const bulkDelete = useBulkDelete({
    items: subs, filtered, selected, setSelected, label: sub => sub.name || sub.id,
    eligible: ownsSubscription, canDelete: canReduce, canSelect: canAssign,
    remove: sub => deleteSubscription(sub.id),
    onDeleted: ids => setSubs(current => current.filter(sub => !ids.has(sub.id))),
    afterDelete: async () => { await refreshAccess(); setStats(await fetchSubStats()); },
    pending, run, busy: loading || showModal || bulkConfirm || !!adjustment,
    scopeKey: `${currentUserRole}:${isReseller ? access?.resellerId ?? "" : ""}`,
    filterKey: `${search}\0${statusFilter}`,
  });
  const selection = bulkDelete.selected;

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  // Reset page when filter changes
  useEffect(() => setPage(1), [search, statusFilter]);
  useEffect(() => setPage(current => Math.max(1, Math.min(current, Math.ceil(filtered.length / pageSize)))), [filtered.length, pageSize]);

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
    if (bulkDelete.isDeleting()) { setFormError('commerce.common.actionPending'); return; }
    if (!canCreate) { setFormError('commerce.common.unavailableAccess'); return; }
    if (!form.clientId || !form.profileId) { setFormError('commerce.subscriptions.required'); return; }
    setFormError('');
    try {
      await run('save', async () => {
        if (editSub) {
          // PUT resets the deadline when durationDays is present, even unchanged.
          await updateSubscription(editSub.id, {
            ...(form.name.trim() !== editSub.name ? { name: form.name.trim() || undefined } : {}),
            ...(form.profileId !== editSub.profileId ? { profileId: form.profileId } : {}),
            ...(form.quotaGB !== (bytesToGigabytes(editSub.quotaBytes) || 5) ? { quotaGB: form.quotaGB } : {}),
            ...(form.durationDays !== editSub.durationDays ? { durationDays: form.durationDays } : {}),
            ...(form.deviceLimit !== editSub.deviceLimit ? { deviceLimit: form.deviceLimit } : {}),
          });
          toast.success(message('commerce.subscriptions.updated'));
        } else {
          await createSubscription(form);
          toast.success(message('commerce.subscriptions.created'));
        }
        setShowModal(false);
        await Promise.all([load(), refreshAccess()]);
      });
    } catch (err) {
      setFormError(err);
    }
  };

  const handleToggleStatus = async (sub: Subscription) => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    const suspending = sub.status === 'active';
    if (!(suspending ? canReduce : canCreate)) { toast.error(message('commerce.common.unavailableAccess')); return; }
    if (!suspending && !canResumeSubscription(sub)) {
      toast.error(message('commerce.subscriptions.resumeUnavailable'));
      return;
    }
    if (!window.confirm(t(suspending ? 'commerce.subscriptions.confirmSuspend' : 'commerce.subscriptions.confirmReactivate', { name: sub.name }))) return;
    try {
      await run(`status:${sub.id}`, async () => {
        const updated = await updateSubscription(sub.id, { status: suspending ? 'suspended' : 'active' });
        setSubs(current => current.map(item => item.id === sub.id ? { ...item, ...updated } : item));
        toast.success(message(suspending ? 'commerce.subscriptions.suspended' : 'commerce.subscriptions.reactivated'));
        await Promise.all([load(), refreshAccess()]);
      });
    } catch (err) { toast.error(errorText(err, 'commerce.common.errorStatus')); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (!canReduce) { toast.error(message('commerce.common.unavailableAccess')); return; }
    if (!window.confirm(t('commerce.subscriptions.confirmDelete', { name }))) return;
    try {
      await run(`delete:${id}`, async () => {
        await deleteSubscription(id);
        setSubs(current => current.filter(item => item.id !== id));
        setSelected(current => new Set([...current].filter(item => item !== id)));
        toast.success(message('commerce.subscriptions.deleted'));
        await Promise.all([load(), refreshAccess()]);
      });
    } catch (err) { toast.error(errorText(err, 'commerce.common.errorDelete')); }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (!canReduce) { toast.error(message('commerce.common.unavailableAccess')); return; }
    if (!window.confirm(t('commerce.subscriptions.confirmRevoke', { name }))) return;
    try {
      await run(`revoke:${id}`, async () => {
        await revokeSubscription(id);
        setSubs(current => current.map(item => item.id === id ? { ...item, status: 'revoked' } : item));
        toast.success(message('commerce.subscriptions.revoked'));
        await Promise.all([load(), refreshAccess()]);
      });
    } catch (err) { toast.error(errorText(err, 'commerce.common.errorRevoke')); }
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
        (STATUS_CFG[subscriptionStatus(s)] ?? STATUS_CFG.unknown).label,
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
  // Toute action de ce panneau augmente ou prolonge l'engagement : elles sont
  // donc fermées quand l'agrément ou le plafond l'exigent.
  const bulkAllowed = canAssign && allows();
  const controlsBusy = !!pending || showModal || bulkConfirm || !!adjustment || !!bulkDelete.confirmation;

  /**
   * Traduit la saisie en charge utile, ou en motif de refus.
   *
   * Un champ vide vaut « ne pas modifier » : il n'entre pas dans la charge
   * utile, donc le serveur ne le réécrit pas. Le refus est une CLÉ i18n, pour
   * que l'écran dise précisément ce qui manque au lieu d'un bouton grisé muet.
   */
  const bulkPlan = useMemo<{ payload: BulkPayload | null; issue: string | null; summary: string[] }>(() => {
    const refuse = (issue: string) => ({ payload: null, issue, summary: [] as string[] });
    const quotaGB = optionalNumber(bulkQuota);
    if (quotaGB !== undefined && !(Number.isFinite(quotaGB) && quotaGB >= QUOTA_MIN && quotaGB <= QUOTA_MAX)) {
      return refuse('commerce.subscriptions.bulk.invalidQuota');
    }
    const durationDays = bulkExpiryMode === 'duration' ? optionalNumber(bulkDays) : undefined;
    if (durationDays !== undefined && !(Number.isInteger(durationDays) && durationDays >= DAYS_MIN && durationDays <= DAYS_MAX)) {
      return refuse('commerce.subscriptions.bulk.invalidDuration');
    }
    const startAt = optionalInstant(bulkStart);
    const expireAt = bulkExpiryMode === 'date' ? optionalInstant(bulkExpire) : undefined;
    if (startAt === null || expireAt === null) return refuse('commerce.subscriptions.bulk.invalidDate');
    if (startAt && expireAt && expireAt.getTime() <= startAt.getTime()) {
      return refuse('commerce.subscriptions.bulk.expiryBeforeStart');
    }
    const profileId = bulkProfile || undefined;

    if (bulkScope === 'deploy') {
      // Créer un forfait exige les trois : sans eux il n'y a rien à créer.
      if (!profileId) return refuse('commerce.subscriptions.bulk.profileRequired');
      if (quotaGB === undefined) return refuse('commerce.subscriptions.bulk.quotaRequired');
      if (durationDays === undefined && !expireAt) return refuse('commerce.subscriptions.bulk.durationRequired');
    } else if (!profileId && quotaGB === undefined && !startAt && !expireAt && durationDays === undefined) {
      return refuse('commerce.subscriptions.bulk.nothingToApply');
    }
    if (selection.size === 0) return refuse('commerce.subscriptions.bulk.noSelection');
    if (selection.size > MAX_BULK_APPLY) return refuse('commerce.subscriptions.bulk.tooMany');

    const ids = Array.from(selection);
    const payload: BulkPayload = {
      action: bulkScope,
      ...(bulkScope === 'deploy'
        // `deploy` crée des forfaits : il vise les CLIENTS des lignes cochées.
        ? { clientIds: Array.from(new Set(subs.filter(s => selection.has(s.id)).map(s => s.clientId))) }
        : { subscriptionIds: ids }),
      ...(profileId ? { profileId } : {}),
      ...(quotaGB !== undefined ? { quotaGB, ...(bulkScope === 'apply' ? { quotaMode: bulkQuotaMode } : {}) } : {}),
      ...(startAt ? { startAt: startAt.toISOString() } : {}),
      ...(expireAt ? { expireAt: expireAt.toISOString() } : {}),
      ...(durationDays !== undefined ? { durationDays, ...(bulkScope === 'apply' ? { durationMode: bulkDurationMode } : {}) } : {}),
    };

    // Récapitulatif : uniquement ce qui va réellement changer.
    const summary: string[] = [];
    if (profileId) summary.push(t('commerce.subscriptions.bulk.summaryProfile', { name: profiles.find(p => p.id === profileId)?.name ?? profileId }));
    if (quotaGB !== undefined) {
      summary.push(t(bulkScope === 'apply' && bulkQuotaMode === 'add'
        ? 'commerce.subscriptions.bulk.summaryQuotaAdd'
        : 'commerce.subscriptions.bulk.summaryQuotaSet', { value: formatNumber(quotaGB) }));
    }
    if (startAt) summary.push(t('commerce.subscriptions.bulk.summaryStart', { date: fmtDate(startAt.toISOString(), locale) }));
    if (expireAt) summary.push(t('commerce.subscriptions.bulk.summaryExpire', { date: fmtDate(expireAt.toISOString(), locale) }));
    if (durationDays !== undefined) {
      summary.push(t(bulkScope === 'apply' && bulkDurationMode === 'add'
        ? 'commerce.subscriptions.bulk.summaryDurationAdd'
        : 'commerce.subscriptions.bulk.summaryDurationSet', { count: formatNumber(durationDays) }));
    }
    return { payload, issue: null, summary };
  }, [bulkScope, bulkQuota, bulkQuotaMode, bulkStart, bulkExpiryMode, bulkDays, bulkDurationMode, bulkExpire, bulkProfile, selection, subs, profiles, locale, t, formatNumber]);

  const toggleOne = bulkDelete.toggle;
  // « Tout sélectionner » porte sur la sélection FILTRÉE, pas sur la page
  // courante : sinon l'opérateur croirait viser 150 forfaits et n'en toucherait
  // que les 20 affichés.
  const selectAllFiltered = bulkDelete.selectAll;
  const clearSelection = bulkDelete.clearSelection;

  const runBulk = async () => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (!bulkAllowed) { toast.error(message('commerce.common.unavailableAccess')); return; }
    if (!bulkPlan.payload) { toast.error(message(bulkPlan.issue ?? 'commerce.subscriptions.invalidAdjustment')); return; }
    const payload = bulkPlan.payload;
    try {
      await run('bulk', async () => {
        const result = await bulkSubscriptions(payload);
        setBulkResult(result);
        setBulkConfirm(false);
        // Réussites ET échecs sont rapportés : un échec isolé ne fait pas
        // échouer le lot, et ne doit pas non plus passer inaperçu.
        if (result.failed > 0) toast.warning(message('commerce.subscriptions.bulk.partial', { succeeded: result.succeeded, failed: result.failed }));
        else if (result.succeeded > 0) toast.success(message('commerce.subscriptions.bulk.updated', { count: result.succeeded }));
        else toast.warning(message('commerce.subscriptions.bulk.noChange'));
        setSelected(new Set());
        resetBulkFields();
        await Promise.all([load(), refreshAccess()]);
      });
    } catch (err) {
      toast.error(errorText(err, 'commerce.subscriptions.bulk.error'));
      setBulkConfirm(false);
    }
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
              disabled={!canCreate || controlsBusy}
              title={canCreate ? t('commerce.subscriptions.assignClient') : t('commerce.common.unavailableAccess')}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
              <Plus className="w-4 h-4" /> {t('commerce.subscriptions.assign')}
            </button>
          )}
        </div>
      </div>

      {isReseller && <ResellerAccessSummaryCard />}
      {canAssign && <ResellerActionNotice />}
      <p className="text-xs leading-relaxed text-gray-400">{t('commerce.subscriptions.keepActivation')}</p>
      {pending && <p role="status" className="text-sm text-cyan-400">{t('commerce.common.actionPending')}</p>}

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
            disabled={controlsBusy}
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('commerce.subscriptions.search')}
            className="w-full pl-9 pr-4 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {['all', 'active', 'expired', 'exhausted', 'revoked', 'suspended'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)} disabled={controlsBusy}
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
      {canAssign && <BulkDeleteControls controller={bulkDelete} hintKey="operations.bulkDelete.subscriptionHint" />}
      {selection.size > 0 && (
        <div className="bg-[#0f1218] border border-cyan-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold text-white">
              {t('commerce.subscriptions.bulk.selection', { count: formatNumber(selection.size) })}
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={selectAllFiltered}
                disabled={controlsBusy || !canAssign}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-[#1a1f2e] text-gray-300 hover:bg-white/5 cursor-pointer">
                {t('commerce.subscriptions.bulk.selectAll', { count: formatNumber(bulkDelete.selectableCount) })}
              </button>
              <button type="button" onClick={clearSelection}
                disabled={controlsBusy}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-[#1a1f2e] text-gray-400 hover:bg-white/5 cursor-pointer">
                {t('commerce.subscriptions.bulk.clearSelection')}
              </button>
            </div>
          </div>

          {/* ── Formulaire groupé ──────────────────────────────────────────
              Tous les champs sont visibles EN MÊME TEMPS et chacun est
              indépendamment facultatif : ce qui est laissé vide n'est pas
              réécrit. L'ancien menu « Action » à choix unique n'exposait
              qu'un seul champ à la fois, et masquait le sélecteur de
              configuration hors du mode « déployer ». */}
          <fieldset disabled={controlsBusy || !canAssign} className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              {(['apply', 'deploy'] as const).map(scope => (
                <button key={scope} type="button"
                  onClick={() => { setBulkScope(scope); setBulkResult(null); }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all cursor-pointer ${
                    bulkScope === scope
                      ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400'
                      : 'bg-[#0a0d14] border-[#1a1f2e] text-gray-400 hover:text-gray-200'
                  }`}>
                  {t(scope === 'apply' ? 'commerce.subscriptions.bulk.scopeApply' : 'commerce.subscriptions.bulk.scopeDeploy')}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-500">
              {t(bulkScope === 'apply' ? 'commerce.subscriptions.bulk.scopeApplyHint' : 'commerce.subscriptions.bulk.scopeDeployHint')}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Serveur / configuration — TOUJOURS rendu, quel que soit le mode */}
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-400 mb-1.5">
                  {t('commerce.common.configuration')}
                  {bulkScope === 'apply' && <span className="text-gray-600"> · {t('commerce.subscriptions.bulk.optional')}</span>}
                </label>
                <select value={bulkProfile} onChange={e => setBulkProfile(e.target.value)}
                  disabled={profiles.length === 0}
                  className="w-full px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500 disabled:opacity-50">
                  <option value="">
                    {bulkScope === 'apply'
                      ? t('commerce.subscriptions.bulk.keepProfile')
                      : t('commerce.common.choose')}
                  </option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {/* Une liste vide doit DIRE pourquoi : un sélecteur muet est
                    exactement le symptôme signalé en exploitation. */}
                {profiles.length === 0 && (
                  <p className="text-[11px] text-amber-400/90 mt-1">
                    {profilesError
                      ? errorText(profilesError, 'commerce.subscriptions.bulk.profilesUnavailable')
                      : t(isReseller
                          ? 'commerce.subscriptions.bulk.noProfilesReseller'
                          : 'commerce.subscriptions.bulk.noProfilesAdmin')}
                  </p>
                )}
              </div>

              {/* Volume */}
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">
                  {t('commerce.subscriptions.bulk.dataGb')}
                  {bulkScope === 'apply' && <span className="text-gray-600"> · {t('commerce.subscriptions.bulk.optional')}</span>}
                </label>
                <div className="flex gap-2">
                  <input type="number" min={QUOTA_MIN} max={QUOTA_MAX} step={0.5} value={bulkQuota}
                    onChange={e => setBulkQuota(e.target.value)}
                    placeholder={bulkScope === 'apply' ? t('commerce.subscriptions.bulk.unchanged') : undefined}
                    className="flex-1 min-w-0 px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500" />
                  {/* « Remplacer » et « Ajouter » restent nommés : les confondre
                      ferait perdre au client le solde non consommé. */}
                  {bulkScope === 'apply' && (
                    <select value={bulkQuotaMode} onChange={e => setBulkQuotaMode(e.target.value as BulkValueMode)}
                      className="px-2 py-2 text-xs bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500">
                      <option value="set">{t('commerce.subscriptions.bulk.modeSet')}</option>
                      <option value="add">{t('commerce.subscriptions.bulk.modeAdd')}</option>
                    </select>
                  )}
                </div>
              </div>

              {/* Début */}
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">
                  {t('commerce.subscriptions.bulk.startAt')}
                  {bulkScope === 'apply' && <span className="text-gray-600"> · {t('commerce.subscriptions.bulk.optional')}</span>}
                </label>
                <input type="datetime-local" value={bulkStart}
                  onChange={e => setBulkStart(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500" />
              </div>

              {/* Échéance : durée OU date, jamais les deux — ce sont deux
                  façons contradictoires de fixer la même borne. */}
              <div className="sm:col-span-2">
                <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                  <label className="text-xs text-gray-400">
                    {t('commerce.subscriptions.bulk.expiry')}
                    {bulkScope === 'apply' && <span className="text-gray-600"> · {t('commerce.subscriptions.bulk.optional')}</span>}
                  </label>
                  {(['duration', 'date'] as const).map(mode => (
                    <label key={mode} className="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer">
                      <input type="radio" name="bulk-expiry-mode" value={mode}
                        checked={bulkExpiryMode === mode}
                        onChange={() => setBulkExpiryMode(mode)}
                        className="accent-cyan-500 cursor-pointer" />
                      {t(mode === 'duration' ? 'commerce.subscriptions.bulk.byDuration' : 'commerce.subscriptions.bulk.byDate')}
                    </label>
                  ))}
                </div>
                {bulkExpiryMode === 'duration' ? (
                  <div className="flex gap-2">
                    <input type="number" min={DAYS_MIN} max={DAYS_MAX} step={1} value={bulkDays}
                      onChange={e => setBulkDays(e.target.value)}
                      placeholder={bulkScope === 'apply' ? t('commerce.subscriptions.bulk.unchanged') : undefined}
                      className="flex-1 min-w-0 px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500" />
                    {bulkScope === 'apply' && (
                      <select value={bulkDurationMode} onChange={e => setBulkDurationMode(e.target.value as BulkValueMode)}
                        className="px-2 py-2 text-xs bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500">
                        <option value="set">{t('commerce.subscriptions.bulk.modeSet')}</option>
                        <option value="add">{t('commerce.subscriptions.bulk.modeAdd')}</option>
                      </select>
                    )}
                  </div>
                ) : (
                  <input type="datetime-local" value={bulkExpire}
                    onChange={e => setBulkExpire(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-lg text-white focus:outline-none focus:border-cyan-500" />
                )}
              </div>
            </div>

            {bulkScope === 'apply' && (
              <p className="text-[11px] text-gray-500">{t('commerce.subscriptions.bulk.emptyMeansUnchanged')}</p>
            )}
          </fieldset>

          {/* Motif de blocage explicite : un bouton grisé sans raison est une
              impasse pour l'exploitant. */}
          {bulkPlan.issue && selection.size > 0 && (
            <p className="text-[11px] text-amber-400/90">{t(bulkPlan.issue, { max: formatNumber(MAX_BULK_APPLY) })}</p>
          )}

          <button type="button" onClick={() => setBulkConfirm(true)}
            disabled={controlsBusy || !bulkPlan.payload || !bulkAllowed}
            title={bulkAllowed ? undefined : t('commerce.common.unavailableAccess')}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black transition-all disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed">
            {bulkRunning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            {t('commerce.subscriptions.bulk.apply', { count: formatNumber(selection.size) })}
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
              <p><span className="text-gray-500">{t('commerce.subscriptions.bulk.actionLabel')}</span> {t(bulkScope === 'apply' ? 'commerce.subscriptions.bulk.scopeApply' : 'commerce.subscriptions.bulk.scopeDeploy')}</p>
              <p><span className="text-gray-500">{t('commerce.subscriptions.bulk.plansLabel')}</span> {formatNumber(selection.size)}</p>
            </div>
            {/* Récapitulatif champ par champ : seuls les champs renseignés y
                figurent, ce qui rend visible ce qui restera inchangé. */}
            <ul className="text-xs text-gray-300 space-y-1 border-t border-[#1a1f2e] pt-2">
              {bulkPlan.summary.map(line => (
                <li key={line} className="flex gap-2"><span className="text-cyan-400">•</span><span>{line}</span></li>
              ))}
            </ul>
            <p className="text-[11px] text-amber-300/80">
              {t(bulkScope === 'apply'
                ? 'commerce.subscriptions.bulk.confirmApplyHint'
                : 'commerce.subscriptions.bulk.confirmDeployHint', { count: formatNumber(selection.size) })}
            </p>
            <div className="flex gap-2 justify-end pt-1">
              <button type="button" onClick={() => setBulkConfirm(false)} disabled={bulkRunning}
                className="px-3 py-2 text-xs rounded-lg border border-[#1a1f2e] text-gray-300 hover:bg-white/5 cursor-pointer">
                {t('commerce.common.cancel')}
              </button>
              <button type="button" onClick={runBulk} disabled={!!pending || !bulkAllowed || !bulkPlan.payload}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black disabled:opacity-50 cursor-pointer">
                {bulkRunning ? t('commerce.subscriptions.bulk.applying') : t('commerce.common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
        {loading && subs.length === 0 ? (
          <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
            {t('commerce.common.loading')}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <PackageOpen className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">{t('commerce.subscriptions.empty')}</p>
            {canCreate && (
              <button onClick={openCreate} disabled={controlsBusy} className="mt-3 text-cyan-400 hover:text-cyan-300 text-sm cursor-pointer">
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
                        checked={paginated.some(ownsSubscription) && paginated.filter(ownsSubscription).every(s => selection.has(s.id))}
                        disabled={controlsBusy || !canAssign}
                        onChange={e => bulkDelete.changeSelection(paginated.map(s => s.id), e.target.checked)}
                        className="rounded border-[#1a1f2e] bg-[#07090e] accent-cyan-500 cursor-pointer"
                      />
                    </th>
                    {[t('commerce.common.name'), t('commerce.common.client')].map(h => (
                      <th key={h} className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{h}</th>
                    ))}
                    {showsOwnerColumn && (
                      <th className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{t('commerce.common.reseller')}</th>
                    )}
                    {[t('commerce.common.vpnProfile'), t('commerce.subscriptions.planQuota'), t('commerce.common.consumption'), t('commerce.common.duration'), t('commerce.subscriptions.planExpiry'), t('commerce.subscriptions.planStatus'), ''].map(h => (
                      <th key={h} className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1f2e]">
                  {paginated.map(sub => {
                    const pct = percentOf(sub.quotaUsed, sub.quotaBytes);
                    const effectiveStatus = subscriptionStatus(sub);
                    const cfg = STATUS_CFG[effectiveStatus] || STATUS_CFG.unknown;
                    const client = clientMap[sub.clientId];
                    return (
                      <tr key={sub.id} className={`hover:bg-white/[0.02] transition-colors ${selection.has(sub.id) ? 'bg-cyan-500/5' : ''}`}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={t('commerce.subscriptions.selectPlan', { name: sub.name })}
                            checked={selection.has(sub.id)}
                            disabled={controlsBusy || !canAssign || !ownsSubscription(sub)}
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
                              {ownerLabel(sub.resellerName ?? sub.client?.reseller?.name ?? client?.resellerName ?? null)}
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
                          {effectiveStatus !== 'expired' && hasExpired(sub.expireAt) && <p className="mt-1 text-[11px] text-amber-400">{t('commerce.subscriptions.needsExtension')}</p>}
                          {effectiveStatus !== 'exhausted' && isPlanExhausted(sub) && <p className="mt-1 text-[11px] text-orange-400">{t('commerce.subscriptions.needsData')}</p>}
                        </td>
                        <td className="px-4 py-3">
                          {canAssign && (
                            <div className="flex min-w-[260px] flex-wrap items-center gap-1">
                              <button onClick={() => setAdjustment({ subscription: sub, action: 'add_data' })} title={t('commerce.subscriptions.addData')}
                                disabled={!canCreate || controlsBusy || sub.status === 'revoked'}
                                className="flex items-center gap-1 rounded-lg p-1.5 text-xs text-cyan-400 hover:bg-cyan-500/10 disabled:opacity-40">
                                <HardDrive className="w-3.5 h-3.5" />{t('commerce.subscriptions.addData')}
                              </button>
                              <button onClick={() => setAdjustment({ subscription: sub, action: 'extend_duration' })} title={t('commerce.subscriptions.extendPlan')}
                                disabled={!canCreate || controlsBusy || sub.status === 'revoked'}
                                className="flex items-center gap-1 rounded-lg p-1.5 text-xs text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40">
                                <Calendar className="w-3.5 h-3.5" />{t('commerce.subscriptions.extendPlan')}
                              </button>
                              <button onClick={() => openEdit(sub)} title={t('commerce.subscriptions.edit')}
                                disabled={!canCreate || controlsBusy}
                                className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => handleToggleStatus(sub)}
                                disabled={!(sub.status === 'active' ? canReduce : canCreate) || controlsBusy || (sub.status !== 'active' && !canResumeSubscription(sub))}
                                title={t(sub.status === 'active' ? 'commerce.subscriptions.suspendPlan' : canResumeSubscription(sub) ? 'commerce.subscriptions.resumePlan' : 'commerce.subscriptions.resumeUnavailable')}
                                className="p-1.5 text-gray-500 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
                                {sub.status === 'active'
                                  ? <PauseCircle className="w-3.5 h-3.5" />
                                  : <PlayCircle className="w-3.5 h-3.5" />}
                              </button>
                              {sub.status !== 'revoked' && (
                                <button onClick={() => handleRevoke(sub.id, sub.name)} title={t('commerce.subscriptions.revokePlan')}
                                  disabled={!canReduce || controlsBusy}
                                  className="p-1.5 text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40">
                                  <ShieldOff className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button onClick={() => handleDelete(sub.id, sub.name)} title={t('commerce.subscriptions.deletePlan')}
                                disabled={!canReduce || controlsBusy}
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
                disabled={controlsBusy}
                onPageChange={setPage} onPageSizeChange={p => { setPageSize(p); setPage(1); }} />
            </div>
          </>
        )}
      </div>

      {adjustment && <SubscriptionAdjustmentDialog
        key={`${adjustment.action}:${adjustment.subscription.id}`}
        subscription={adjustment.subscription}
        action={adjustment.action}
        busy={!!pending}
        allowed={canCreate}
        onClose={() => setAdjustment(null)}
        onSubmit={async value => {
          if (!canCreate) throw new Error('commerce.common.unavailableAccess');
          await run(`${adjustment.action}:${adjustment.subscription.id}`, async () => {
            const result = await bulkSubscriptions({
              action: adjustment.action,
              subscriptionIds: [adjustment.subscription.id],
              ...(adjustment.action === 'add_data' ? { quotaGB: value } : { durationDays: value }),
            });
            if (result.succeeded !== 1 || result.failed !== 0) {
              throw new Error(result.details.find(detail => detail.status === 'failed')?.reason || 'commerce.subscriptions.bulk.noChange');
            }
            setAdjustment(null);
            toast.success(message(adjustment.action === 'add_data' ? 'commerce.subscriptions.dataAdded' : 'commerce.subscriptions.extended'));
            await Promise.all([load(), refreshAccess()]);
          });
        }}
      />}

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0f1218] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold flex items-center gap-2">
                <PackageOpen className="w-4 h-4 text-cyan-400" />
                {editSub ? t('commerce.subscriptions.edit') : t('commerce.subscriptions.assignClient')}
              </h2>
              <button onClick={() => setShowModal(false)} disabled={saving} aria-label={t('commerce.common.close')} className="p-1.5 text-gray-500 hover:text-white rounded-lg cursor-pointer disabled:opacity-40">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <fieldset disabled={saving} className="space-y-4">
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
              {editSub && <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-200">{t('commerce.subscriptions.replaceHint')}</p>}

              <div>
                <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t('commerce.common.vpnClientRequired')}</label>
                <div className="relative">
                  <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} required
                    disabled={!!editSub}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 appearance-none cursor-pointer disabled:opacity-60">
                    <option value="">{t('commerce.common.chooseClient')}</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.user?.name || c.name || c.token || c.id}
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
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t(editSub ? 'commerce.subscriptions.replaceQuota' : 'commerce.common.quotaGbRequired')}</label>
                  <input type="number" min={0.5} max={1_000_000} step={0.5} value={form.quotaGB}
                    onChange={e => setForm(f => ({ ...f, quotaGB: Number(e.target.value) }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">{t(editSub ? 'commerce.subscriptions.replaceDuration' : 'commerce.common.durationDays')}</label>
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
              </fieldset>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

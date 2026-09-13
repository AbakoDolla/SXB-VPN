import React, { useEffect, useState, useMemo } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchClients, createClient, deleteClient, suspendClient, activateClient, renewClient, resetClientAccess } from "../api/clients";
import { fetchResellers } from "../api/resellers";
import { Client, Reseller, UserRole } from "../types";
import { useResellerAccess } from "../contexts/ResellerAccessContext";
import { usePermissions } from "../contexts/PermissionsContext";
import { ResellerAccessSummaryCard, ResellerActionNotice } from "./ResellerAccessBanner";
import { isUpperRole, ownerLabel, percentOf } from "../lib/resellerAccess";
import { canResumeDevice, deviceStatus, lifecycleBadges } from "../lib/lifecycle";
import { useActionLock } from "../hooks/useActionLock";
import { useBulkDelete } from "../hooks/useBulkDelete";
import BulkDeleteControls from "./BulkDeleteControls";
import ActivationRenewalDialog from "./ActivationRenewalDialog";
import ActivationCodeResult from "./ActivationCodeResult";
import { Search, UserPlus, Trash2, ShieldAlert, KeyRound, CalendarDays, PauseCircle, PlayCircle, RefreshCcw, Store } from "lucide-react";
import Pagination from "./ui/Pagination";
import { toast } from "sonner";

interface ClientsViewProps {
  currentUserRole: UserRole;
  actorName: string;
}

const CLIENT_ACTIONS = {
  suspend: { confirm: "commerce.devices.confirmSuspend", success: "commerce.clients.suspended", request: suspendClient },
  resume: { confirm: "commerce.devices.confirmResume", success: "commerce.clients.activated", request: activateClient },
  reset: { confirm: "commerce.clients.confirmReset", success: "commerce.clients.reset", request: resetClientAccess },
  delete: { confirm: "commerce.clients.confirmDelete", success: "commerce.clients.deleted", request: deleteClient },
};

export default function ClientsView({ currentUserRole, actorName }: ClientsViewProps) {
  const { t, locale, formatBytes, message, errorText } = useTranslation();
  const STATUS_CONFIG = lifecycleBadges(t);
  const [clients, setClients] = useState<Client[]>([]);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { pending, run } = useActionLock();
  const [renewTarget, setRenewTarget] = useState<Client | null>(null);
  const [resetResult, setResetResult] = useState<Client | null>(null);
  
  // Create client form states
  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [resellerId, setResellerId] = useState("");

  const isSupport = currentUserRole === UserRole.SUPPORT;
  const isReseller = currentUserRole === UserRole.RESELLER;
  // Étiquette « Client de … » : réservée aux rôles qui voient tout le parc.
  // Un revendeur ne voit que ses propres clients, l'étiquette n'y apprendrait rien.
  const showsOwnerColumn = isUpperRole(currentUserRole);
  const { access, allows, refresh: refreshAccess } = useResellerAccess();
  const can = usePermissions();
  const canCreate = !isSupport && allows() && can("clients.create");
  const canReduce = !isSupport && allows({ reducesExposure: true }) && can("clients.manage");
  const canRenew = canCreate;
  const canResume = canCreate;
  const canReset = !isSupport && allows({ reducesExposure: true }) && can("clients.create");
  const canDelete = !isSupport && allows({ reducesExposure: true }) && can("clients.delete");
  const ownsClient = (client: Client) => !isReseller || !!access?.resellerId
    && (client.resellerId ?? client.reseller?.id) === access.resellerId;

  const loadClients = async () => {
    setLoading(true);
    try {
      // SÉPARATION TOTALE : aucun paramètre d'essai n'est envoyé et aucun ne
      // peut l'être. Le serveur exclut les comptes d'essai par défaut ; la
      // liste reçue est donc exactement celle qui s'affiche, et les compteurs
      // ne peuvent pas annoncer des lignes invisibles.
      const data = await fetchClients();
      setClients(data);
      // Rattachement commercial explicite, réservé aux rôles supérieurs.
      if (showsOwnerColumn && can("reseller.manage")) setResellers(await fetchResellers());
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorLoad'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadClients();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (!canCreate) { toast.error(message('commerce.common.unavailableAccess')); return; }
    if (!name.trim()) { toast.error(message('commerce.clients.nameRequired')); return; }

    try {
      await run("create", async () => {
        await createClient({
          name: name.trim(),
          email: email || undefined,
          phone: phone || undefined,
          resellerId: showsOwnerColumn && resellerId ? resellerId : undefined,
        });
        setName("");
        setEmail("");
        setPhone("");
        setResellerId("");
        setShowAddModal(false);
        toast.success(message('commerce.clients.created'));
        await Promise.all([loadClients(), refreshAccess()]);
      });
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorGeneric'));
    }
  };

  const handleAction = async (client: Client, action: keyof typeof CLIENT_ACTIONS) => {
    if (bulkDelete.isDeleting()) { toast.error(message('commerce.common.actionPending')); return; }
    if (!ownsClient(client)) { toast.error(message('errors.resellers.ownership_forbidden')); return; }
    if (!(action === "delete" ? canDelete : action === "suspend" ? canReduce : action === "reset" ? canReset : canResume)) {
      toast.error(message('commerce.common.unavailableAccess'));
      return;
    }
    if (action === "resume" && !canResumeDevice(client)) {
      toast.error(message('commerce.devices.resumeUnavailable'));
      return;
    }
    const config = CLIENT_ACTIONS[action];
    if (!window.confirm(t(config.confirm, { name: client.user?.name || client.name || client.id }))) return;
    try {
      await run(`${action}:${client.id}`, async () => {
        const updated = await config.request(client.id);
        if (action === "reset") {
          if (!updated || typeof updated.token !== "string" || !updated.token.startsWith("SXB-USER-") || updated.token === client.token) {
            throw new Error("commerce.clients.resetResponseInvalid");
          }
          setResetResult(updated);
        }
        setClients(current => action === "delete" ? current.filter(item => item.id !== client.id)
          : current.map(item => item.id === client.id && updated ? { ...item, ...updated } : item));
        if (action === "delete") setSelected(current => new Set([...current].filter(id => id !== client.id)));
        toast.success(message(config.success));
        await Promise.all([loadClients(), refreshAccess()]);
      });
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorGeneric'));
    }
  };

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const filteredClients = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return clients.filter((client) => {
      // The API returns the display name and email on the related user object.
      // Keep fallbacks for older records and never call string methods on null.
      const clientName = String(client.user?.name ?? client.name ?? "");
      const clientEmail = String(client.user?.email ?? client.email ?? "");
      const clientToken = String(client.token ?? "");
      const matchesSearch = !normalizedSearch || [clientName, clientEmail, clientToken]
        .some((value) => value.toLowerCase().includes(normalizedSearch));

      const matchesStatus = statusFilter === "all" || deviceStatus(client) === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [clients, search, statusFilter]);

  const bulkDelete = useBulkDelete({
    items: clients, filtered: filteredClients, selected, setSelected,
    label: client => client.user?.name || client.name || client.id,
    eligible: ownsClient, canDelete, remove: client => deleteClient(client.id),
    onDeleted: ids => setClients(current => current.filter(client => !ids.has(client.id))),
    afterDelete: refreshAccess, pending, run,
    busy: loading || showAddModal || !!renewTarget || !!resetResult,
    scopeKey: `${currentUserRole}:${isReseller ? access?.resellerId ?? "" : ""}`,
    filterKey: `${search}\0${statusFilter}`,
  });
  const controlsBusy = !!pending || !!renewTarget || !!resetResult || showAddModal || !!bulkDelete.confirmation;

  const paginatedClients = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredClients.slice(start, start + pageSize);
  }, [filteredClients, page, pageSize]);

  useEffect(() => setPage(1), [search, statusFilter]);
  useEffect(() => setPage(current => Math.max(1, Math.min(current, Math.ceil(filteredClients.length / pageSize)))), [filteredClients.length, pageSize]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t('commerce.clients.title')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('commerce.clients.subtitle')}</p>
        </div>
        
        {!isSupport && (
          <button
            onClick={() => setShowAddModal(true)}
            disabled={!canCreate || controlsBusy}
            title={canCreate ? undefined : t('commerce.common.unavailableQuota')}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          >
            <UserPlus className="h-4 w-4" />
            {t('commerce.clients.add')}
          </button>
        )}
      </div>

      {isReseller && <ResellerAccessSummaryCard />}
      {!isSupport && <ResellerActionNotice />}
      <p className="text-xs leading-relaxed text-gray-400">{t('commerce.clients.lifecycleHint')}</p>
      {pending && <p role="status" className="text-sm text-cyan-400">{t('commerce.common.actionPending')}</p>}

      {/* Filters & search */}
      <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
          <input
            type="text"
            placeholder={t('commerce.common.search')}
            value={search}
            disabled={controlsBusy}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          />
        </div>

        <div className="flex flex-wrap gap-2 w-full md:w-auto">
          {["all", "active", "suspended", "disabled", "expired", "revoked"].map((filter) => (
            <button
              key={filter}
              disabled={controlsBusy}
              onClick={() => setStatusFilter(filter)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border capitalize transition-all cursor-pointer ${
                statusFilter === filter
                  ? "bg-cyan-950 border-cyan-500/50 text-cyan-400"
                  : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"
              }`}
            >
              {filter === "all" ? t('commerce.common.all') : STATUS_CONFIG[filter].label}
            </button>
          ))}
        </div>
      </div>

      {!isSupport && <BulkDeleteControls controller={bulkDelete} hintKey="operations.bulkDelete.clientHint" />}

      {/* Main client table */}
      {loading && clients.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCcw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">{t('commerce.common.loading')}</p>
        </div>
      ) : filteredClients.length > 0 || paginatedClients.length > 0 ? (
        <div className="border border-gray-800/80 rounded-xl bg-gray-950/20 overflow-hidden backdrop-blur-md">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  {!isSupport && <th className="py-3 px-4">{t('operations.bulkDelete.selectColumn')}</th>}
                  <th className="py-3 px-4">{t('commerce.common.fullName')}</th>
                  <th className="py-3 px-4">{t('commerce.clients.emailPhone')}</th>
                  {showsOwnerColumn && <th className="py-3 px-4">{t('commerce.common.reseller')}</th>}
                  <th className="py-3 px-4">{t('commerce.clients.sxbToken')}</th>
                  <th className="py-3 px-4 text-center" title={t('commerce.clients.individualQuotaHint')}>{t('commerce.clients.individualQuota')}</th>
                  <th className="py-3 px-4">{t('commerce.devices.accessExpiry')}</th>
                  <th className="py-3 px-4 text-center">{t('commerce.devices.accessStatus')}</th>
                  {!isSupport && <th className="py-3 px-4 text-right">{t('commerce.common.actions')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900 text-sm">
                {paginatedClients.map((client) => {
                  const percent = percentOf(client.quotaUsed, client.quotaTotal);
                  const effectiveStatus = deviceStatus(client);
                  const status = STATUS_CONFIG[effectiveStatus] ?? STATUS_CONFIG.unknown;
                  
                  return (
                    <tr key={client.id} className="hover:bg-gray-900/20 transition-colors">
                      {!isSupport && <td className="py-4 px-4">
                        <input type="checkbox" checked={bulkDelete.selected.has(client.id)}
                          disabled={controlsBusy || !canDelete || !ownsClient(client)}
                          aria-label={t('operations.bulkDelete.selectOne', { name: client.user?.name || client.name || client.id })}
                          onChange={() => bulkDelete.toggle(client.id)} />
                      </td>}
                      <td className="py-4 px-4 font-medium text-white">
                        {client.user?.name || client.name || "-"}
                      </td>
                      <td className="py-4 px-4 text-gray-400">
                        {client.user?.email || client.email || "-"}
                      </td>
                      {showsOwnerColumn && (
                        <td className="py-4 px-4">
                          <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300">
                            <Store className="h-3 w-3 shrink-0" />
                            {ownerLabel(client.resellerName ?? client.reseller?.name ?? null)}
                          </span>
                        </td>
                      )}
                      <td className="py-4 px-4 font-mono text-xs">
                        {isSupport ? (
                          <span className="text-gray-600 flex items-center gap-1">
                            <ShieldAlert className="h-3 w-3" /> {t('commerce.clients.hidden')}
                          </span>
                        ) : (
                          <span className="text-cyan-400">{client.token}</span>
                        )}
                      </td>
                      <td className="py-4 px-4">
                        <div className="space-y-1.5 max-w-[120px] mx-auto">
                          <div className="flex justify-between text-[11px] font-mono text-gray-500">
                            <span>{formatBytes(client.quotaUsed)}</span>
                            <span>{formatBytes(client.quotaTotal)}</span>
                          </div>
                          <div className="w-full h-1 bg-gray-900 rounded-full overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${percent > 90 ? "bg-rose-500" : percent > 60 ? "bg-amber-500" : "bg-cyan-500"}`} 
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-xs text-gray-400 font-mono">
                        {client.expireAt ? new Date(client.expireAt).toLocaleDateString(locale) : "-"}
                      </td>
                      <td className="py-4 px-4 text-center">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${status.cls}`}>
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          {status.label}
                        </span>
                      </td>
                      
                      {!isSupport && (
                        <td className="py-4 px-4 text-right">
                          <div className="flex justify-end gap-1.5">
                            <button
                              onClick={() => handleAction(client, effectiveStatus === "active" ? "suspend" : "resume")}
                              disabled={!(effectiveStatus === "active" ? canReduce : canResume) || controlsBusy || (effectiveStatus !== "active" && !canResumeDevice(client))}
                              title={t(effectiveStatus === "active" ? 'commerce.devices.suspendDevice' : canResumeDevice(client) ? 'commerce.devices.resumeDevice' : 'commerce.devices.resumeUnavailable')}
                              className="p-1 text-gray-500 hover:text-amber-400 hover:bg-gray-900/60 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {effectiveStatus === "active" ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                            </button>
                            <button
                              onClick={() => setRenewTarget(client)}
                              disabled={!canRenew || controlsBusy}
                              title={t('commerce.clients.renewDevice')}
                              className="p-1 text-gray-500 hover:text-emerald-400 hover:bg-gray-900/60 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <CalendarDays className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleAction(client, "reset")}
                              disabled={!canReset || controlsBusy}
                              title={t('commerce.clients.resetAccess')}
                              className="p-1 text-gray-500 hover:text-cyan-400 hover:bg-gray-900/60 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <KeyRound className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleAction(client, "delete")}
                              disabled={!canDelete || controlsBusy || !ownsClient(client)}
                              title={t('commerce.clients.deleteClient')}
                              className="p-1 text-gray-500 hover:text-rose-400 hover:bg-gray-900/60 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-gray-800/80 px-4">
            <Pagination page={page} pageSize={pageSize} total={filteredClients.length}
              disabled={controlsBusy}
              onPageChange={setPage} onPageSizeChange={s => { setPageSize(s); setPage(1); }} />
          </div>
        </div>
      ) : (
        /* Premium Empty State */
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <ShieldAlert className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">{t('commerce.clients.empty')}</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mt-1">{t('commerce.clients.emptyHint')}</p>
          {canCreate && (
            <button
              onClick={() => setShowAddModal(true)} disabled={controlsBusy}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
            >
              {t('commerce.clients.createFirst')}
            </button>
          )}
        </div>
      )}

      {resetResult && <div role="dialog" aria-modal="true" aria-labelledby="activation-reset-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-lg space-y-4 rounded-2xl border border-[#252b3b] bg-[#0f1218] p-6">
          <h2 id="activation-reset-title" className="text-lg font-semibold text-white">{t('commerce.clients.reset')}</h2>
          <p className="text-sm text-gray-300">{resetResult.user?.name || resetResult.name || resetResult.id}</p>
          <ActivationCodeResult token={resetResult.token} expireAt={resetResult.expireAt} />
          <p className="text-xs text-gray-400">{t('commerce.clients.resetNoRenewal')}</p>
          <button type="button" onClick={() => setResetResult(null)} disabled={!!pending}
            className="w-full rounded-lg border border-[#252b3b] px-3 py-2 text-sm text-gray-300 disabled:opacity-40">{t('commerce.common.close')}</button>
        </div>
      </div>}

      {renewTarget && <ActivationRenewalDialog
        key={renewTarget.id}
        name={renewTarget.user?.name || renewTarget.name || renewTarget.id}
        previousToken={renewTarget.token}
        expireAt={renewTarget.expireAt}
        fixedDurationDays={30}
        allowed={canRenew}
        busy={!!pending}
        onClose={() => setRenewTarget(null)}
        onRenew={async () => {
          if (!canRenew) throw new Error("commerce.common.unavailableAccess");
          return run(`renew:${renewTarget.id}`, async () => {
            const renewed = await renewClient(renewTarget.id);
            setClients(current => current.map(item => item.id === renewTarget.id ? { ...item, ...renewed } : item));
            await Promise.all([loadClients(), refreshAccess()]);
            return renewed;
          });
        }}
      />}

      {/* Add Client Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-cyan-400" />
              {t('commerce.clients.add')}
            </h2>
            
            <form onSubmit={handleCreate} className="space-y-4">
              <fieldset disabled={!!pending} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t('commerce.common.fullName')}</label>
                <input
                  type="text"
                  required
                  placeholder={t('commerce.common.exampleName')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t('commerce.clients.emailPhone')}</label>
                <input
                  type="email"
                  placeholder={t('commerce.common.exampleClientEmail')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t('commerce.common.phone')}</label>
                <input
                  type="tel"
                  placeholder="+225 07 XX XX XX XX"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <p className="text-xs text-gray-500 mt-2">
                {t('commerce.clients.noAutomaticPlan')}
              </p>

              {showsOwnerColumn && (
                <div>
                  <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                    {t('commerce.common.assignReseller')}
                  </label>
                  <select
                    value={resellerId}
                    onChange={(e) => setResellerId(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  >
                    <option value="">{t('commerce.common.directClient')}</option>
                    {resellers.map((r) => (
                      <option key={r.id} value={r.id}>{r.name} — {r.email}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-gray-500">
                    {t('commerce.clients.ownerHint')}
                  </p>
                </div>
              )}

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 transition-all cursor-pointer"
                >
                  {t('commerce.common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!!pending || !canCreate}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 transition-all cursor-pointer disabled:opacity-40"
                >
                  {t(pending === "create" ? 'commerce.common.actionPending' : 'commerce.common.create')}
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

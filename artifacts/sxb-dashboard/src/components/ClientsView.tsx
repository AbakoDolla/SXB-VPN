import React, { useEffect, useState, useMemo } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchClients, createClient, updateClient, deleteClient, suspendClient, activateClient, renewClient, resetClientAccess } from "../api/clients";
import { fetchResellers } from "../api/resellers";
import { Client, Reseller, UserRole } from "../types";
import { useResellerAccess } from "../contexts/ResellerAccessContext";
import { usePermissions } from "../contexts/PermissionsContext";
import { ResellerAccessSummaryCard, ResellerActionNotice } from "./ResellerAccessBanner";
import { isUpperRole, ownerLabel, percentOf } from "../lib/resellerAccess";
import { Search, UserPlus, Trash2, ShieldAlert, KeyRound, CalendarDays, Ban, CheckCircle, RefreshCcw, MoreHorizontal, HelpCircle, Store } from "lucide-react";
import Pagination from "./ui/Pagination";
import { toast } from "sonner";

interface ClientsViewProps {
  currentUserRole: UserRole;
  actorName: string;
}

export default function ClientsView({ currentUserRole, actorName }: ClientsViewProps) {
  const { t, locale, formatBytes, message, errorText } = useTranslation();
  const [clients, setClients] = useState<Client[]>([]);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  
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
  const { allows, refresh: refreshAccess } = useResellerAccess();
  // Créer un client engage le parc du revendeur : fermé si l'agrément est
  // expiré ou le plafond atteint. Suspendre, renouveler et supprimer restent
  // ouverts au plafond — ce sont les gestes qui libèrent.
  const can = usePermissions();
  const canCreate = !isSupport && allows() && can("clients.create");
  const canReduce = !isSupport && allows({ reducesExposure: true }) && can("clients.manage");

  const loadClients = async () => {
    setLoading(true);
    try {
      const data = await fetchClients();
      setClients(data);
      // Rattachement commercial explicite, réservé aux rôles supérieurs.
      if (showsOwnerColumn) setResellers(await fetchResellers().catch(() => [] as Reseller[]));
    } catch (err) {
      console.error("Error fetching clients:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadClients();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    try {
      await createClient({
        name,
        email: email || undefined,
        phone: phone || undefined,
        // Un revendeur crée toujours pour lui-même : le serveur l'impose.
        resellerId: showsOwnerColumn && resellerId ? resellerId : undefined,
      });

      // Reset form
      setName("");
      setEmail("");
      setPhone("");
      setResellerId("");
      setShowAddModal(false);
      toast.success(message('commerce.clients.created'));
      await Promise.all([loadClients(), refreshAccess()]);
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorGeneric'));
    }
  };

  const handleSuspend = async (id: string, isCurrentlyActive: boolean) => {
    if (isSupport) return;
    try {
      if (isCurrentlyActive) {
        await suspendClient(id);
        toast.success(message('commerce.clients.suspended'));
      } else {
        await activateClient(id);
        toast.success(message('commerce.clients.activated'));
      }
      await Promise.all([loadClients(), refreshAccess()]);
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorGeneric'));
    }
  };

  const handleRenew = async (id: string) => {
    if (isSupport) return;
    try {
      await renewClient(id);
      toast.success(message('commerce.clients.renewed'));
      await Promise.all([loadClients(), refreshAccess()]);
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorGeneric'));
    }
  };

  const handleResetAccess = async (id: string) => {
    if (isSupport) return;
    if (!window.confirm(t('commerce.clients.confirmReset'))) return;
    try {
      await resetClientAccess(id);
      toast.success(message('commerce.clients.reset'));
      await Promise.all([loadClients(), refreshAccess()]);
    } catch (err) {
      toast.error(errorText(err, 'commerce.common.errorGeneric'));
    }
  };

  const handleDelete = async (id: string) => {
    if (isSupport) return;
    if (!window.confirm(t('commerce.clients.confirmDelete'))) return;
    try {
      await deleteClient(id);
      toast.success(message('commerce.clients.deleted'));
      await Promise.all([loadClients(), refreshAccess()]);
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
      const clientRecord = client as Client & {
        user?: { name?: string | null; email?: string | null };
        name?: string | null;
        email?: string | null;
      };
      const clientName = String(clientRecord.user?.name ?? clientRecord.name ?? "");
      const clientEmail = String(clientRecord.user?.email ?? clientRecord.email ?? "");
      const clientToken = String(client.token ?? "");
      const matchesSearch = !normalizedSearch || [clientName, clientEmail, clientToken]
        .some((value) => value.toLowerCase().includes(normalizedSearch));

      const matchesStatus = statusFilter === "all" || client.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [clients, search, statusFilter]);

  const paginatedClients = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredClients.slice(start, start + pageSize);
  }, [filteredClients, page, pageSize]);

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
            disabled={!canCreate}
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

      {/* Filters & search */}
      <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
          <input
            type="text"
            placeholder={t('commerce.common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          />
        </div>

        <div className="flex flex-wrap gap-2 w-full md:w-auto">
          {["all", "active", "suspended", "expired"].map((filter) => (
            <button
              key={filter}
              onClick={() => setStatusFilter(filter)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border capitalize transition-all cursor-pointer ${
                statusFilter === filter
                  ? "bg-cyan-950 border-cyan-500/50 text-cyan-400"
                  : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"
              }`}
            >
              {filter === "all" ? t('commerce.common.all') : filter === "active" ? t('commerce.common.active') : filter === "suspended" ? t('commerce.common.suspended') : t('commerce.common.expired')}
            </button>
          ))}
        </div>
      </div>

      {/* Main client table */}
      {loading ? (
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
                  <th className="py-3 px-4">{t('commerce.common.fullName')}</th>
                  <th className="py-3 px-4">{t('commerce.clients.emailPhone')}</th>
                  {showsOwnerColumn && <th className="py-3 px-4">{t('commerce.common.reseller')}</th>}
                  <th className="py-3 px-4">{t('commerce.clients.sxbToken')}</th>
                  <th className="py-3 px-4 text-center">{t('commerce.common.quota')}</th>
                  <th className="py-3 px-4">{t('commerce.common.expirationDate')}</th>
                  <th className="py-3 px-4 text-center">{t('commerce.common.status')}</th>
                  {!isSupport && <th className="py-3 px-4 text-right">{t('commerce.common.actions')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900 text-sm">
                {paginatedClients.map((client) => {
                  const percent = percentOf(client.quotaUsed, client.quotaTotal);
                  const isSuspended = client.status === "suspended";
                  
                  return (
                    <tr key={client.id} className="hover:bg-gray-900/20 transition-colors">
                      <td className="py-4 px-4 font-medium text-white">
                        {(client as any).user?.name || client.name || "-"}
                      </td>
                      <td className="py-4 px-4 text-gray-400">
                        {(client as any).user?.email || client.email || "-"}
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
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          client.status === "active" 
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : isSuspended
                            ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                            : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                        }`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${
                            client.status === "active" ? "bg-emerald-400" : isSuspended ? "bg-amber-400" : "bg-rose-400"
                          }`} />
                          {client.status === "active" ? t('commerce.common.active') : isSuspended ? t('commerce.common.suspended') : t('commerce.common.expired')}
                        </span>
                      </td>
                      
                      {!isSupport && (
                        <td className="py-4 px-4 text-right">
                          <div className="flex justify-end gap-1.5">
                            <button
                              onClick={() => handleSuspend(client.id, client.status === "active")}
                              disabled={!canReduce}
                              title={client.status === "active" ? t('commerce.common.suspend') : t('commerce.common.reactivate')}
                              className="p-1 text-gray-500 hover:text-amber-400 hover:bg-gray-900/60 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Ban className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleRenew(client.id)}
                              disabled={!canCreate}
                              title={t('commerce.common.renewAccess')}
                              className="p-1 text-gray-500 hover:text-emerald-400 hover:bg-gray-900/60 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <CalendarDays className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleResetAccess(client.id)}
                              disabled={!canReduce}
                              title={t('commerce.clients.resetAccess')}
                              className="p-1 text-gray-500 hover:text-cyan-400 hover:bg-gray-900/60 rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <KeyRound className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(client.id)}
                              disabled={!canReduce}
                              title={t('commerce.common.delete')}
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
              onClick={() => setShowAddModal(true)}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
            >
              {t('commerce.clients.createFirst')}
            </button>
          )}
        </div>
      )}

      {/* Add Client Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-cyan-400" />
              {t('commerce.clients.add')}
            </h2>
            
            <form onSubmit={handleCreate} className="space-y-4">
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
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
                >
                  {t('commerce.common.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

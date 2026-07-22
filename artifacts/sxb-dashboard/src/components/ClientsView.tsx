import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchClients, createClient, updateClient, deleteClient, suspendClient, activateClient, renewClient, resetClientAccess } from "../api/clients";
import { Client, UserRole } from "../types";
import { Search, UserPlus, Trash2, ShieldAlert, KeyRound, CalendarDays, Ban, CheckCircle, RefreshCcw, MoreHorizontal, HelpCircle } from "lucide-react";

interface ClientsViewProps {
  currentUserRole: UserRole;
  actorName: string;
}

export default function ClientsView({ currentUserRole, actorName }: ClientsViewProps) {
  const { t } = useTranslation();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  
  // Create client form states
  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const isSupport = currentUserRole === UserRole.SUPPORT;

  const loadClients = async () => {
    setLoading(true);
    try {
      const data = await fetchClients();
      setClients(data);
    } catch (err) {
      console.error("Error fetching clients:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadClients();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    try {
      await createClient({
        name,
        email: email || undefined,
        phone: phone || undefined,
      });
      
      // Reset form
      setName("");
      setEmail("");
      setPhone("");
      setShowAddModal(false);
      loadClients();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("common.error_generic"));
    }
  };

  const handleSuspend = async (id: string, isCurrentlyActive: boolean) => {
    if (isSupport) return;
    try {
      if (isCurrentlyActive) {
        await suspendClient(id);
      } else {
        await activateClient(id);
      }
      loadClients();
    } catch (err) {
      alert(t("common.error_generic"));
    }
  };

  const handleRenew = async (id: string) => {
    if (isSupport) return;
    try {
      await renewClient(id);
      loadClients();
    } catch (err) {
      alert(t("common.error_generic"));
    }
  };

  const handleResetAccess = async (id: string) => {
    if (isSupport) return;
    if (!confirm("Voulez-vous vraiment générer une nouvelle clé d'accès Sing-box pour ce client ? Ses anciens profils VPN seront déconnectés.")) return;
    try {
      await resetClientAccess(id);
      loadClients();
    } catch (err) {
      alert(t("common.error_generic"));
    }
  };

  const handleDelete = async (id: string) => {
    if (isSupport) return;
    if (!confirm("Voulez-vous définitivement supprimer ce client VPN ? Cette action est irréversible.")) return;
    try {
      await deleteClient(id);
      loadClients();
    } catch (err) {
      alert(t("common.error_generic"));
    }
  };

  const filteredClients = clients.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase()) || 
                          c.email.toLowerCase().includes(search.toLowerCase()) ||
                          c.token.toLowerCase().includes(search.toLowerCase());
    
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t("clients.title")}</h1>
          <p className="text-sm text-gray-400 mt-1">{t("clients.subtitle")}</p>
        </div>
        
        {!isSupport && (
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
          >
            <UserPlus className="h-4 w-4" />
            {t("clients.add_client")}
          </button>
        )}
      </div>

      {/* Filters & search */}
      <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
          <input
            type="text"
            placeholder={t("common.search")}
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
              {filter === "all" ? "Tous" : filter === "active" ? t("common.active") : filter === "suspended" ? t("common.suspended") : t("common.expired")}
            </button>
          ))}
        </div>
      </div>

      {/* Main client table */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCcw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">{t("common.loading")}</p>
        </div>
      ) : filteredClients.length > 0 ? (
        <div className="border border-gray-800/80 rounded-xl bg-gray-950/20 overflow-hidden backdrop-blur-md">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  <th className="py-3 px-4">{t("clients.fields.name")}</th>
                  <th className="py-3 px-4">{t("clients.fields.email")}</th>
                  <th className="py-3 px-4">{t("clients.fields.token")}</th>
                  <th className="py-3 px-4 text-center">Quota (Go)</th>
                  <th className="py-3 px-4">{t("clients.fields.expiration")}</th>
                  <th className="py-3 px-4 text-center">{t("clients.fields.status")}</th>
                  {!isSupport && <th className="py-3 px-4 text-right">{t("common.actions")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900 text-sm">
                {filteredClients.map((client) => {
                  const quotaTotal = Number(client.quotaTotal) / (1024 * 1024 * 1024);
                  const quotaUsed = Number(client.quotaUsed) / (1024 * 1024 * 1024);
                  const percent = quotaTotal > 0 ? Math.min(100, (quotaUsed / quotaTotal) * 100) : 0;
                  const isSuspended = client.status === "suspended";
                  
                  return (
                    <tr key={client.id} className="hover:bg-gray-900/20 transition-colors">
                      <td className="py-4 px-4 font-medium text-white">
                        {(client as any).user?.name || client.name || "-"}
                      </td>
                      <td className="py-4 px-4 text-gray-400">
                        {(client as any).user?.email || client.email || "-"}
                      </td>
                      <td className="py-4 px-4 font-mono text-xs">
                        {isSupport ? (
                          <span className="text-gray-600 flex items-center gap-1">
                            <ShieldAlert className="h-3 w-3" /> Hidden (Support)
                          </span>
                        ) : (
                          <span className="text-cyan-400">{client.token}</span>
                        )}
                      </td>
                      <td className="py-4 px-4">
                        <div className="space-y-1.5 max-w-[120px] mx-auto">
                          <div className="flex justify-between text-[11px] font-mono text-gray-500">
                            <span>{quotaUsed.toFixed(1)} Go</span>
                            <span>{quotaTotal.toFixed(1)} Go</span>
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
                        {client.expireAt ? new Date(client.expireAt).toLocaleDateString() : "-"}
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
                          {client.status === "active" ? t("common.active") : isSuspended ? t("common.suspended") : t("common.expired")}
                        </span>
                      </td>
                      
                      {!isSupport && (
                        <td className="py-4 px-4 text-right">
                          <div className="flex justify-end gap-1.5">
                            <button
                              onClick={() => handleSuspend(client.id, client.status === "active")}
                              title={client.status === "active" ? "Suspendre" : "Activer"}
                              className="p-1 text-gray-500 hover:text-amber-400 hover:bg-gray-900/60 rounded cursor-pointer"
                            >
                              <Ban className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleRenew(client.id)}
                              title="Renouveler"
                              className="p-1 text-gray-500 hover:text-emerald-400 hover:bg-gray-900/60 rounded cursor-pointer"
                            >
                              <CalendarDays className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleResetAccess(client.id)}
                              title="Reset Token"
                              className="p-1 text-gray-500 hover:text-cyan-400 hover:bg-gray-900/60 rounded cursor-pointer"
                            >
                              <KeyRound className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(client.id)}
                              title="Supprimer"
                              className="p-1 text-gray-500 hover:text-rose-400 hover:bg-gray-900/60 rounded cursor-pointer"
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
        </div>
      ) : (
        /* Premium Empty State */
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <ShieldAlert className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">{t("clients.empty_state")}</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mt-1">{t("clients.empty_state_desc")}</p>
          {!isSupport && (
            <button
              onClick={() => setShowAddModal(true)}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
            >
              Créer votre premier compte client VPN
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
              {t("clients.add_client")}
            </h2>
            
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t("clients.fields.name")}</label>
                <input
                  type="text"
                  required
                  placeholder="Jean Dupont"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t("clients.fields.email")}</label>
                <input
                  type="email"
                  placeholder="jean.dupont@gmail.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Téléphone</label>
                <input
                  type="tel"
                  placeholder="+225 07 XX XX XX XX"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <p className="text-xs text-gray-500 mt-2">
                Le quota sera défini lors de la création du token/forfait pour ce client.
              </p>

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 transition-all cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
                >
                  {t("common.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

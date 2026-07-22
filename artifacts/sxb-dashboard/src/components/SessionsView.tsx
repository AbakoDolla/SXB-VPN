import React, { useEffect, useState, useMemo } from "react";
import { fetchSessions, revokeSession, resetSession, deleteSession, ActivationSession } from "../api/sessions";
import { Smartphone, RefreshCcw, XCircle, Trash2, Search, Clock, CheckCircle, AlertCircle, ShieldOff } from "lucide-react";
import Pagination from "./ui/Pagination";
import { toast } from "sonner";

export default function SessionsView() {
  const [sessions, setSessions] = useState<ActivationSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchSessions();
      setSessions(data);
    } catch (err) {
      console.error("Error loading sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const handleRevoke = async (id: string) => {
    if (!window.confirm("Révoquer cette session ? L'appareil sera déconnecté.")) return;
    try { await revokeSession(id); load(); toast.success("Session révoquée"); } catch { toast.error("Erreur lors de la révocation"); }
  };

  const handleReset = async (id: string) => {
    if (!window.confirm("Réinitialiser cette activation ? L'utilisateur pourra s'activer sur un autre appareil.")) return;
    try { await resetSession(id); load(); toast.success("Activation réinitialisée"); } catch { toast.error("Erreur lors de la réinitialisation"); }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Supprimer définitivement cette session ?")) return;
    try { await deleteSession(id); load(); toast.success("Session supprimée"); } catch { toast.error("Erreur lors de la suppression"); }
  };

  const filtered = sessions.filter((s) => {
    const matchSearch = (s.clientName || "").toLowerCase().includes(search.toLowerCase()) ||
      (s.clientToken || "").toLowerCase().includes(search.toLowerCase()) ||
      (s.deviceId || "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || s.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  const formatDate = (d: string | null) => {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const statusBadge = (status: string) => {
    if (status === "active") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400"><CheckCircle className="w-3 h-3" />Actif</span>;
    if (status === "revoked") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-400"><ShieldOff className="w-3 h-3" />Révoqué</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-500/15 text-gray-400"><AlertCircle className="w-3 h-3" />Expiré</span>;
  };

  const activeCount = sessions.filter((s) => s.status === "active").length;
  const revokedCount = sessions.filter((s) => s.status === "revoked").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Sessions utilisateurs</h1>
          <p className="text-sm text-gray-400 mt-1">Appareils activés, sessions persistantes et historique d'accès</p>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all">
          <RefreshCcw className="w-4 h-4" /> Actualiser
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total sessions", value: sessions.length, color: "text-white" },
          { label: "Sessions actives", value: activeCount, color: "text-emerald-400" },
          { label: "Révoquées", value: revokedCount, color: "text-red-400" },
        ].map((stat) => (
          <div key={stat.label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{stat.label}</p>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Rechercher par client, token ou device ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-sm bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2.5 text-sm bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
        >
          <option value="all">Tous les statuts</option>
          <option value="active">Actif</option>
          <option value="revoked">Révoqué</option>
          <option value="expired">Expiré</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-500 text-sm">Chargement des sessions...</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Smartphone className="w-10 h-10 text-gray-700" />
            <p className="text-gray-500 text-sm">Aucune session trouvée</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1a1f2e]">
                  {["Client", "Token", "Appareil", "Activation", "Expiration", "Dernière sync", "Statut", "Actions"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {paginated.map((s) => (
                  <tr key={s.id} className="hover:bg-white/2 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{s.clientName}</td>
                    <td className="px-4 py-3">
                      <code className="text-xs text-cyan-400 bg-cyan-500/10 px-2 py-0.5 rounded font-mono">{s.clientToken || "—"}</code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Smartphone className="w-3.5 h-3.5 text-gray-500" />
                        <span className="text-gray-300 text-xs font-mono truncate max-w-[140px]" title={s.deviceId}>{s.deviceId}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{formatDate(s.activationDate)}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{formatDate(s.expirationDate)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Clock className="w-3 h-3" />
                        {formatDate(s.lastSync)}
                      </div>
                    </td>
                    <td className="px-4 py-3">{statusBadge(s.status)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {s.status === "active" && (
                          <button
                            onClick={() => handleRevoke(s.id)}
                            title="Révoquer"
                            className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-400/10 transition-colors"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => handleReset(s.id)}
                          title="Réinitialiser activation"
                          className="p-1.5 rounded-lg text-blue-400 hover:bg-blue-400/10 transition-colors"
                        >
                          <RefreshCcw className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(s.id)}
                          title="Supprimer"
                          className="p-1.5 rounded-lg text-red-400 hover:bg-red-400/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-[#1a1f2e] px-4">
            <Pagination page={page} pageSize={pageSize} total={filtered.length}
              onPageChange={setPage} onPageSizeChange={s => { setPageSize(s); setPage(1); }} />
          </div>
        )}
      </div>
    </div>
  );
}

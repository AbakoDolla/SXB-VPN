import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { LifeBuoy, Search, Plus, RefreshCw, Send, CheckCircle2, Clock, AlertTriangle, Inbox } from "lucide-react";
import { fetchTickets, createTicket, updateTicket, SupportTicket } from "../api/support";

const PRIORITY_COLORS = {
  low: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  medium: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  high: "text-rose-400 bg-rose-500/10 border-rose-500/20",
};

const STATUS_COLORS = {
  open: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
  in_progress: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  resolved: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  closed: "text-gray-400 bg-gray-500/10 border-gray-500/20",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Ouvert",
  in_progress: "En cours",
  resolved: "Résolu",
  closed: "Fermé",
};

const PRIORITY_LABELS: Record<string, string> = {
  low: "Faible",
  medium: "Moyenne",
  high: "Haute / Urgente",
};

export default function SupportView() {
  const { t } = useTranslation();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [showAddTicket, setShowAddTicket] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");

  const loadTickets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTickets();
      setTickets(data);
    } catch (err) {
      setError("Impossible de charger les tickets. Vérifiez la connexion au serveur.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !clientName) return;
    setSubmitting(true);
    setError(null);

    try {
      const newTicket = await createTicket({ title, clientName, description, priority });
      setTickets((prev) => [newTicket, ...prev]);
      setTitle("");
      setClientName("");
      setDescription("");
      setPriority("medium");
      setShowAddTicket(false);
    } catch (err: any) {
      setError(err?.message || "Erreur lors de la création du ticket");
    } finally {
      setSubmitting(false);
    }
  };

  const handleResolve = async (id: string) => {
    try {
      const updated = await updateTicket(id, { status: "resolved" });
      setTickets((prev) => prev.map((tk) => (tk.id === id ? updated : tk)));
    } catch (err) {
      setError("Erreur lors de la résolution du ticket");
    }
  };

  const handleStatusChange = async (id: string, status: string) => {
    try {
      const updated = await updateTicket(id, { status });
      setTickets((prev) => prev.map((tk) => (tk.id === id ? updated : tk)));
    } catch (err) {
      setError("Erreur lors de la mise à jour du statut");
    }
  };

  const filtered = tickets.filter((tk) => {
    const matchSearch =
      (tk.title || "").toLowerCase().includes(search.toLowerCase()) ||
      (tk.clientName || "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === "all" || tk.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const openCount = tickets.filter((t) => t.status === "open").length;
  const resolvedCount = tickets.filter((t) => t.status === "resolved" || t.status === "closed").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <LifeBuoy className="h-6 w-6 text-cyan-400" />
            Ticket Support / Assistance
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Gérez les demandes d'assistance technique des clients VPN.
          </p>
        </div>
        <button
          onClick={() => setShowAddTicket(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          Ouvrir un Ticket
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-rose-400/60 hover:text-rose-400">✕</button>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Total", value: tickets.length, color: "text-white" },
          { label: "Ouverts", value: openCount, color: "text-cyan-400" },
          { label: "En cours", value: tickets.filter(t => t.status === "in_progress").length, color: "text-amber-400" },
          { label: "Résolus", value: resolvedCount, color: "text-emerald-400" },
        ].map((stat) => (
          <div key={stat.label} className="p-4 rounded-xl border border-gray-800/60 bg-gray-950/20">
            <p className="text-xs text-gray-500 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Rechercher par titre ou client..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          />
        </div>
        <div className="flex gap-2">
          {["all", "open", "in_progress", "resolved", "closed"].map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                filterStatus === s
                  ? "bg-cyan-950 text-cyan-400 border-cyan-800/40"
                  : "bg-gray-900/60 text-gray-400 border-gray-800 hover:bg-gray-900"
              }`}
            >
              {s === "all" ? "Tous" : STATUS_LABELS[s] || s}
            </button>
          ))}
        </div>
        <button onClick={loadTickets} className="p-2 rounded-lg bg-gray-900 border border-gray-800 text-gray-400 hover:text-white cursor-pointer" title="Actualiser">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Ticket List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">Chargement des tickets...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <Inbox className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">Aucun ticket</h3>
          <p className="text-sm text-gray-500 mt-1">
            {search ? "Aucun résultat pour votre recherche" : "Aucun ticket de support ouvert pour l'instant"}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((tk) => (
            <div
              key={tk.id}
              className="p-4 rounded-xl border border-gray-800/60 bg-gray-950/20 hover:bg-gray-900/20 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${
                        STATUS_COLORS[tk.status] || STATUS_COLORS.open
                      }`}
                    >
                      {STATUS_LABELS[tk.status] || tk.status}
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${
                        PRIORITY_COLORS[tk.priority] || PRIORITY_COLORS.medium
                      }`}
                    >
                      {PRIORITY_LABELS[tk.priority] || tk.priority}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-white mt-2">{tk.title}</h3>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Client : <span className="text-gray-300">{tk.clientName}</span>
                  </p>
                  {tk.description && (
                    <p className="text-xs text-gray-500 mt-1.5 leading-relaxed line-clamp-2">{tk.description}</p>
                  )}
                  <p className="text-xs text-gray-600 mt-2 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(tk.createdAt).toLocaleString("fr-FR", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </p>
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  {tk.status === "open" && (
                    <button
                      onClick={() => handleStatusChange(tk.id, "in_progress")}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-amber-950 text-amber-400 border border-amber-800/30 hover:bg-amber-900/50 cursor-pointer"
                    >
                      <Clock className="h-3 w-3" /> En cours
                    </button>
                  )}
                  {(tk.status === "open" || tk.status === "in_progress") && (
                    <button
                      onClick={() => handleResolve(tk.id)}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-950 text-emerald-400 border border-emerald-800/30 hover:bg-emerald-900/50 cursor-pointer"
                    >
                      <CheckCircle2 className="h-3 w-3" /> Résoudre
                    </button>
                  )}
                  {tk.status === "resolved" && (
                    <button
                      onClick={() => handleStatusChange(tk.id, "closed")}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 border border-gray-800 hover:bg-gray-800 cursor-pointer"
                    >
                      Fermer
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal Créer Ticket */}
      {showAddTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Send className="h-5 w-5 text-cyan-400" />
              Ouvrir un Ticket de Support
            </h2>

            {error && (
              <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
                {error}
              </div>
            )}

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Titre du ticket</label>
                <input
                  type="text"
                  required
                  placeholder="Problème de connexion / Quota insuffisant..."
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Nom du client</label>
                <input
                  type="text"
                  required
                  placeholder="Nom complet du client concerné"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Priorité</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as any)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                >
                  <option value="low">Faible</option>
                  <option value="medium">Moyenne</option>
                  <option value="high">Haute / Urgente</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Description</label>
                <textarea
                  rows={3}
                  placeholder="Décrivez le problème rencontré par le client..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 resize-none"
                />
              </div>

              <div className="flex gap-2 justify-end pt-2 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => { setShowAddTicket(false); setError(null); }}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg cursor-pointer disabled:opacity-50"
                >
                  {submitting && <RefreshCw className="h-3 w-3 animate-spin" />}
                  Créer le Ticket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

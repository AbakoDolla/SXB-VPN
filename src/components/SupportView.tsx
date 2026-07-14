import React, { useState, useEffect } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { LifeBuoy, Search, Plus, HelpCircle, RefreshCw, Send, CheckCircle2 } from "lucide-react";
import { logActivity } from "../api/db";

interface SupportTicket {
  id: string;
  title: string;
  clientName: string;
  description: string;
  priority: "low" | "medium" | "high";
  status: "open" | "resolved";
  createdAt: string;
}

export default function SupportView() {
  const { t } = useTranslation();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [showAddTicket, setShowAddTicket] = useState(false);

  // Form states
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");

  const loadTickets = () => {
    setLoading(true);
    // Read from localStorage support tickets
    const saved = localStorage.getItem("sxb_vpn_tickets");
    if (saved) {
      try {
        setTickets(JSON.parse(saved));
      } catch {
        setTickets([]);
      }
    } else {
      setTickets([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadTickets();
  }, []);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !clientName) return;

    const newTicket: SupportTicket = {
      id: `ticket-${Date.now()}`,
      title,
      clientName,
      description,
      priority,
      status: "open",
      createdAt: new Date().toISOString(),
    };

    const updated = [newTicket, ...tickets];
    setTickets(updated);
    localStorage.setItem("sxb_vpn_tickets", JSON.stringify(updated));
    logActivity(`Ouverture d'un ticket de support pour ${clientName}`, "Support Operator", "info");

    setTitle("");
    setClientName("");
    setDescription("");
    setShowAddTicket(false);
  };

  const handleResolve = (id: string) => {
    const updated = tickets.map((tk) => {
      if (tk.id === id) {
        return { ...tk, status: "resolved" as const };
      }
      return tk;
    });
    setTickets(updated);
    localStorage.setItem("sxb_vpn_tickets", JSON.stringify(updated));
    logActivity(`Résolution du ticket #${id.split("-")[1].substring(0, 5)}`, "Support Operator", "success");
  };

  const filtered = tickets.filter((tk) => {
    return tk.title.toLowerCase().includes(search.toLowerCase()) || 
           tk.clientName.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <LifeBuoy className="h-6 w-6 text-cyan-400" />
            Ticket Support / Assistance
          </h1>
          <p className="text-sm text-gray-400 mt-1">Gérez les demandes d'assistance technique, les réclamations de débit ou de renouvellement des clients VPN.</p>
        </div>

        <button
          onClick={() => setShowAddTicket(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          Ouvrir un Ticket
        </button>
      </div>

      {/* Filter and Search */}
      <div className="relative w-full md:w-80">
        <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher par titre ou client..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        />
      </div>

      {/* Grid of tickets */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">{t("common.loading")}</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((tk) => {
            const isOpen = tk.status === "open";
            const priorityColors = {
              low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
              medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
              high: "bg-rose-500/10 text-rose-400 border-rose-500/20",
            };

            return (
              <div 
                key={tk.id} 
                className={`p-5 rounded-xl border transition-all ${
                  isOpen 
                    ? "border-gray-800/80 bg-gray-950/40" 
                    : "border-gray-900/60 bg-gray-950/10 opacity-60"
                }`}
              >
                <div className="flex justify-between items-start gap-3">
                  <div>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${priorityColors[tk.priority]}`}>
                      {tk.priority}
                    </span>
                    <h3 className="text-sm font-bold text-white mt-1.5 leading-snug">{tk.title}</h3>
                    <p className="text-xs text-cyan-400 font-medium mt-1">Client : {tk.clientName}</p>
                  </div>

                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    isOpen ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20" : "bg-gray-800 text-gray-500"
                  }`}>
                    {isOpen ? "EN COURS" : "RÉSOLU"}
                  </span>
                </div>

                <p className="text-xs text-gray-400 mt-4 leading-relaxed font-mono bg-gray-900/20 p-2 rounded border border-gray-900/50">
                  {tk.description || "Aucune description de ticket fournie."}
                </p>

                <div className="mt-4 pt-3 border-t border-gray-900/60 flex items-center justify-between text-[11px] text-gray-500">
                  <span>Reçu le {new Date(tk.createdAt).toLocaleString()}</span>
                  
                  {isOpen && (
                    <button
                      onClick={() => handleResolve(tk.id)}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-emerald-950 text-emerald-400 hover:bg-emerald-900/40 border border-emerald-800/30 cursor-pointer"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Résoudre
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <LifeBuoy className="h-11 w-11 text-gray-700 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-white">Aucun Ticket d'Assistance Ouvert</h3>
          <p className="text-xs text-gray-400 max-w-sm mx-auto mt-1">Le service d'assistance est calme. Tous les tunnels VPN et allocations clients fonctionnent parfaitement.</p>
        </div>
      )}

      {/* Add Ticket Modal */}
      {showAddTicket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <LifeBuoy className="h-5 w-5 text-cyan-400" />
              Ouvrir un Ticket Support
            </h2>
            
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Objet de la demande</label>
                <input
                  type="text"
                  required
                  placeholder="Problème de connexion Sing-box"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Nom du Client</label>
                <input
                  type="text"
                  required
                  placeholder="Jean Dupont"
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
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Description de l'incident</label>
                <textarea
                  rows={3}
                  required
                  placeholder="Précisez le code erreur de l'application mobile SXB VPN ou le statut XPanel constaté."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => setShowAddTicket(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 cursor-pointer animate-pulse"
                >
                  Créer Ticket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

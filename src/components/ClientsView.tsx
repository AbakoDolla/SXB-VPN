import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchClients, createClient, deleteClient, suspendClient, activateClient } from "../api/clients";
import { Client, UserRole } from "../types";
import {
  Search, UserPlus, Trash2, ShieldAlert, KeyRound, CalendarDays,
  Ban, CheckCircle, RefreshCcw, Copy, Check, X, PartyPopper,
} from "lucide-react";

interface ClientsViewProps {
  currentUserRole: UserRole;
  actorName: string;
}

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button onClick={handle} title="Copier" className="flex items-center gap-1 text-gray-500 hover:text-cyan-400 transition-colors cursor-pointer">
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {label && <span className="text-xs">{copied ? "Copie !" : label}</span>}
    </button>
  );
}

export default function ClientsView({ currentUserRole, actorName }: ClientsViewProps) {
  const { t } = useTranslation();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Create form
  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [creating, setCreating] = useState(false);

  // Success popup after creation
  const [newClient, setNewClient] = useState<Client | null>(null);

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

  useEffect(() => { loadClients(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const created = await createClient({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setName(""); setEmail(""); setPhone("");
      setShowAddModal(false);
      setNewClient(created);
      loadClients();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erreur lors de la creation");
    } finally {
      setCreating(false);
    }
  };

  const handleSuspend = async (id: string, isActive: boolean) => {
    if (isSupport) return;
    try {
      isActive ? await suspendClient(id) : await activateClient(id);
      loadClients();
    } catch { alert("Erreur"); }
  };

  const handleDelete = async (id: string) => {
    if (isSupport) return;
    if (!confirm("Supprimer definitivement ce client VPN ? Action irreversible.")) return;
    try { await deleteClient(id); loadClients(); }
    catch { alert("Erreur"); }
  };

  const filtered = clients.filter((c) => {
    const q = search.toLowerCase();
    const name_ = ((c as any).user?.name || (c as any).name || "").toLowerCase();
    const email_ = ((c as any).user?.email || (c as any).email || "").toLowerCase();
    const token_ = (c.token || "").toLowerCase();
    return (name_.includes(q) || email_.includes(q) || token_.includes(q)) &&
      (statusFilter === "all" || c.status === statusFilter);
  });

  return (
    <div className="space-y-6">

      {/* ── Success popup after creation ── */}
      {newClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0a0d14] border border-emerald-500/30 rounded-2xl w-full max-w-md shadow-2xl shadow-emerald-500/10">
            <div className="p-6 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <PartyPopper className="w-7 h-7 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Client cree avec succes !</h2>
                <p className="text-sm text-gray-400 mt-1">
                  Donne ce token au client pour qu il active son acces VPN.
                </p>
              </div>

              {/* Nom du client */}
              <div className="bg-[#07090e] border border-[#1a1f2e] rounded-xl p-3 text-left space-y-1">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Client</p>
                <p className="text-white font-semibold">{(newClient as any).user?.name || (newClient as any).name}</p>
                <p className="text-xs text-gray-500">{(newClient as any).user?.email || ""}</p>
              </div>

              {/* Token USER */}
              <div className="bg-[#07090e] border border-cyan-500/30 rounded-xl p-4 text-left space-y-2">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Token d identification client</p>
                <div className="flex items-center justify-between gap-3">
                  <code className="text-lg font-mono font-bold text-cyan-400 tracking-widest">
                    {newClient.token}
                  </code>
                  <CopyBtn text={newClient.token} label="Copier" />
                </div>
                <p className="text-xs text-gray-600">
                  Ce token identifie le client. Creez ensuite un Forfait Data pour generer le token de connexion VPN.
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setNewClient(null)}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 transition-colors cursor-pointer"
                >
                  Fermer
                </button>
                <button
                  onClick={() => { setNewClient(null); }}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 border border-cyan-500/20 transition-colors cursor-pointer"
                >
                  OK, compris
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Clients VPN</h1>
          <p className="text-sm text-gray-400 mt-1">Gerez les comptes et tokens de vos abonnes</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadClients} className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer">
            <RefreshCcw className="h-4 w-4" />
          </button>
          {!isSupport && (
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-sm rounded-xl shadow-lg transition-all cursor-pointer"
            >
              <UserPlus className="h-4 w-4" />
              Nouveau client
            </button>
          )}
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Nom, email ou token..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div className="flex flex-wrap gap-2 w-full md:w-auto">
          {[
            { v: "all", l: "Tous" },
            { v: "active", l: "Actifs" },
            { v: "suspended", l: "Suspendus" },
            { v: "expired", l: "Expires" },
          ].map(({ v, l }) => (
            <button
              key={v}
              onClick={() => setStatusFilter(v)}
              className={"px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer " + (
                statusFilter === v
                  ? "bg-cyan-950 border-cyan-500/50 text-cyan-400"
                  : "bg-[#0f1218] border-[#1a1f2e] text-gray-400 hover:bg-[#1a1f2e]"
              )}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCcw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm">Chargement...</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="border border-[#1a1f2e] rounded-xl bg-[#0a0d14] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[#1a1f2e] text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <th className="py-3 px-4">Client</th>
                  <th className="py-3 px-4">Token SXB-USER</th>
                  <th className="py-3 px-4 text-center">Quota</th>
                  <th className="py-3 px-4">Expiration</th>
                  <th className="py-3 px-4 text-center">Statut</th>
                  {!isSupport && <th className="py-3 px-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0f1218]">
                {filtered.map((client) => {
                  const qTotal = Number(client.quotaTotal) / (1024 ** 3);
                  const qUsed  = Number(client.quotaUsed)  / (1024 ** 3);
                  const pct    = qTotal > 0 ? Math.min(100, (qUsed / qTotal) * 100) : 0;
                  const isActive = client.status === "active";

                  return (
                    <tr key={client.id} className="hover:bg-white/[0.02] transition-colors">
                      {/* Client info */}
                      <td className="py-4 px-4">
                        <div>
                          <p className="font-semibold text-white">{(client as any).user?.name || (client as any).name || "-"}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{(client as any).user?.email || (client as any).email || "-"}</p>
                        </div>
                      </td>
                      {/* Token avec copie */}
                      <td className="py-4 px-4">
                        {isSupport ? (
                          <span className="text-gray-600 flex items-center gap-1 text-xs">
                            <ShieldAlert className="h-3 w-3" /> Masque
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <code className="font-mono text-xs text-cyan-400 bg-cyan-500/10 px-2 py-1 rounded-lg">
                              {client.token}
                            </code>
                            <CopyBtn text={client.token} />
                          </div>
                        )}
                      </td>
                      {/* Quota */}
                      <td className="py-4 px-4">
                        <div className="space-y-1 min-w-[100px]">
                          <div className="flex justify-between text-[11px] text-gray-500">
                            <span>{qUsed.toFixed(1)} Go</span>
                            <span>{qTotal.toFixed(1)} Go</span>
                          </div>
                          <div className="w-full h-1.5 bg-[#1a1f2e] rounded-full overflow-hidden">
                            <div
                              className={"h-full rounded-full " + (pct > 90 ? "bg-rose-500" : pct > 60 ? "bg-amber-500" : "bg-cyan-500")}
                              style={{ width: pct + "%" }}
                            />
                          </div>
                        </div>
                      </td>
                      {/* Expiration */}
                      <td className="py-4 px-4 text-xs text-gray-400 font-mono">
                        {client.expireAt ? new Date(client.expireAt).toLocaleDateString("fr-FR") : <span className="text-gray-600">—</span>}
                      </td>
                      {/* Status */}
                      <td className="py-4 px-4 text-center">
                        <span className={"inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border " + (
                          isActive
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : client.status === "suspended"
                            ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                            : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        )}>
                          <span className={"h-1.5 w-1.5 rounded-full " + (isActive ? "bg-emerald-400" : client.status === "suspended" ? "bg-amber-400" : "bg-rose-400")} />
                          {isActive ? "Actif" : client.status === "suspended" ? "Suspendu" : "Expire"}
                        </span>
                      </td>
                      {/* Actions */}
                      {!isSupport && (
                        <td className="py-4 px-4 text-right">
                          <div className="flex justify-end gap-1">
                            <button onClick={() => handleSuspend(client.id, isActive)}
                              title={isActive ? "Suspendre" : "Activer"}
                              className="p-1.5 text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg cursor-pointer transition-colors">
                              {isActive ? <Ban className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
                            </button>
                            <button onClick={() => handleDelete(client.id)}
                              title="Supprimer"
                              className="p-1.5 text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg cursor-pointer transition-colors">
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
        <div className="border border-dashed border-[#1a1f2e] rounded-2xl p-12 text-center">
          <ShieldAlert className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">Aucun client</h3>
          <p className="text-sm text-gray-500 max-w-sm mx-auto mt-1">
            Cliquez sur Nouveau client pour creer votre premier abonne VPN.
          </p>
          {!isSupport && (
            <button onClick={() => setShowAddModal(true)}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-xl bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer">
              Creer votre premier client VPN
            </button>
          )}
        </div>
      )}

      {/* ── Create modal ── */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-[#1a1f2e]">
              <h2 className="font-bold text-white">Nouveau client VPN</h2>
              <button onClick={() => setShowAddModal(false)} className="text-gray-500 hover:text-white cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Nom complet *</label>
                <input
                  type="text"
                  placeholder="Jean Dupont"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Email</label>
                <input
                  type="email"
                  placeholder="jean@gmail.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Telephone</label>
                <input
                  type="tel"
                  placeholder="+237 6XX XX XX XX"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div className="bg-cyan-500/5 border border-cyan-500/10 rounded-xl p-3 text-xs text-cyan-600">
                Apres la creation, un token <span className="font-mono text-cyan-400">SXB-USER-XXXX</span> sera genere automatiquement. 
                Ensuite creez un <strong>Forfait Data</strong> pour lui donner acces au VPN.
              </div>
              <div className="flex gap-3 justify-end pt-2">
                <button type="button" onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-sm rounded-xl bg-[#0f1218] text-gray-400 hover:bg-[#1a1f2e] cursor-pointer transition-colors">
                  Annuler
                </button>
                <button type="submit" disabled={creating || !name.trim()}
                  className="px-5 py-2 text-sm font-semibold rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black disabled:opacity-50 cursor-pointer transition-colors">
                  {creating ? "Creation..." : "Creer le client"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

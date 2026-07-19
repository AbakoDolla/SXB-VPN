import React, { useEffect, useState, useCallback } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchClients, createClient, deleteClient, suspendClient, activateClient } from "../api/clients";
import { Client, UserRole } from "../types";
import {
  Search, UserPlus, Trash2, ShieldAlert, RefreshCcw,
  Copy, Check, X, PartyPopper, Ban, CheckCircle,
  Smartphone, Wifi, WifiOff, Clock, KeyRound,
} from "lucide-react";

interface Props { currentUserRole: UserRole; actorName: string }

/* ── helpers ────────────────────────────────────────────────────── */
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1800); }}
      className="p-1 text-gray-500 hover:text-cyan-400 transition-colors cursor-pointer" title="Copier">
      {ok ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

type ConnStatus = "connected" | "inactive" | "pending";
function connStatus(client: Client): ConnStatus {
  if (!client.lastSeenAt && !client.activatedAt) return "pending";
  const last = new Date(client.lastSeenAt || client.activatedAt!).getTime();
  return Date.now() - last < 10 * 60 * 1000 ? "connected" : "inactive";
}

const CONN_LABEL: Record<ConnStatus, string>    = { connected: "Connecte",    inactive: "Inactif",    pending: "Non active" };
const CONN_COLOR: Record<ConnStatus, string>    = {
  connected: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  inactive:  "text-amber-400 bg-amber-500/10 border-amber-500/20",
  pending:   "text-gray-500 bg-gray-500/10 border-gray-700/30",
};
const CONN_DOT: Record<ConnStatus, string>      = { connected: "bg-emerald-400 animate-pulse", inactive: "bg-amber-400", pending: "bg-gray-600" };
const CONN_ICON: Record<ConnStatus, any>        = { connected: Wifi, inactive: WifiOff, pending: Clock };

export default function ClientsView({ currentUserRole }: Props) {
  const { t } = useTranslation();
  const [clients, setClients]     = useState<Client[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAdd, setShowAdd]     = useState(false);
  const [name, setName]           = useState("");
  const [email, setEmail]         = useState("");
  const [phone, setPhone]         = useState("");
  const [deviceId, setDeviceId]   = useState("");
  const [creating, setCreating]   = useState(false);
  const [newClient, setNewClient] = useState<Client | null>(null);
  const isSupport = currentUserRole === UserRole.SUPPORT;

  const load = useCallback(async () => {
    setLoading(true);
    try { setClients(await fetchClients()); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const created = await createClient({
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        deviceId: deviceId.trim() || undefined,
      });
      setName(""); setEmail(""); setPhone(""); setDeviceId("");
      setShowAdd(false);
      setNewClient(created);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erreur de creation");
    } finally { setCreating(false); }
  };

  const filtered = clients.filter(c => {
    const q = search.toLowerCase();
    const n = ((c as any).user?.name || "").toLowerCase();
    const em = ((c as any).user?.email || "").toLowerCase();
    const tok = (c.token || "").toLowerCase();
    const dev = (c.deviceId || "").toLowerCase();
    const match = n.includes(q) || em.includes(q) || tok.includes(q) || dev.includes(q);
    const st = statusFilter === "all" || c.status === statusFilter;
    return match && st;
  });

  return (
    <div className="space-y-6">

      {/* ── Success popup ── */}
      {newClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-[#0a0d14] border border-emerald-500/30 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-6 space-y-4 text-center">
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                <PartyPopper className="w-7 h-7 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Client cree !</h2>
                <p className="text-sm text-gray-400 mt-1">Le client peut maintenant se connecter avec l app SXB VPN.</p>
              </div>

              {/* Client info */}
              <div className="bg-[#07090e] border border-[#1a1f2e] rounded-xl p-3 text-left space-y-1">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Client</p>
                <p className="text-white font-semibold">{(newClient as any).user?.name || (newClient as any).name}</p>
                {(newClient as any).user?.phone && <p className="text-xs text-gray-500">{(newClient as any).user.phone}</p>}
              </div>

              {/* Token USER */}
              <div className="bg-[#07090e] border border-cyan-500/30 rounded-xl p-4 text-left space-y-2">
                <p className="text-xs text-gray-500 uppercase tracking-wider">Token SXB-USER (config manuelle)</p>
                <div className="flex items-center justify-between gap-2">
                  <code className="text-base font-mono font-bold text-cyan-400 tracking-widest">{newClient.token}</code>
                  <CopyBtn text={newClient.token} />
                </div>
                <p className="text-xs text-gray-600">Utilisable pour la configuration manuelle du VPN. L app mobile utilise le Device ID.</p>
              </div>

              {/* Device ID if provided */}
              {newClient.deviceId && (
                <div className="bg-[#07090e] border border-violet-500/30 rounded-xl p-3 text-left space-y-1">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">Device ID enregistre</p>
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-xs font-mono text-violet-400">{newClient.deviceId}</code>
                    <CopyBtn text={newClient.deviceId} />
                  </div>
                </div>
              )}

              {!newClient.deviceId && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 text-left">
                  <p className="text-xs text-amber-400">
                    <strong>Aucun Device ID fourni.</strong> Le client sera reconnu automatiquement
                    des qu il ouvrira l app SXB VPN avec son numero de telephone.
                  </p>
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button onClick={() => setNewClient(null)}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 transition-colors cursor-pointer">
                  Fermer
                </button>
                <button onClick={() => setNewClient(null)}
                  className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 border border-cyan-500/20 transition-colors cursor-pointer">
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Clients VPN</h1>
          <p className="text-sm text-gray-400 mt-1">Gerez les abonnes, leurs appareils et tokens</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-white/5 transition-colors cursor-pointer">
            <RefreshCcw className="h-4 w-4" />
          </button>
          {!isSupport && (
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-sm rounded-xl shadow-lg transition-all cursor-pointer">
              <UserPlus className="h-4 w-4" /> Nouveau client
            </button>
          )}
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-col md:flex-row gap-3 items-center">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
          <input type="text" placeholder="Nom, email, token ou device..." value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500" />
        </div>
        <div className="flex flex-wrap gap-2">
          {[["all","Tous"],["active","Actifs"],["suspended","Suspendus"],["expired","Expires"]].map(([v,l]) => (
            <button key={v} onClick={() => setStatusFilter(v)}
              className={"px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all cursor-pointer " + (
                statusFilter === v ? "bg-cyan-950 border-cyan-500/50 text-cyan-400" : "bg-[#0f1218] border-[#1a1f2e] text-gray-400 hover:bg-[#1a1f2e]"
              )}>{l}</button>
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
                  <th className="py-3 px-4">Connexion App</th>
                  <th className="py-3 px-4">Device ID</th>
                  <th className="py-3 px-4">Token SXB-USER</th>
                  <th className="py-3 px-4 text-center">Quota</th>
                  <th className="py-3 px-4 text-center">Statut</th>
                  {!isSupport && <th className="py-3 px-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0f1218]">
                {filtered.map(client => {
                  const cs = connStatus(client);
                  const Icon = CONN_ICON[cs];
                  const qTotal = Number(client.quotaTotal) / 1024 ** 3;
                  const qUsed  = Number(client.quotaUsed)  / 1024 ** 3;
                  const pct    = qTotal > 0 ? Math.min(100, (qUsed / qTotal) * 100) : 0;
                  const isActive = client.status === "active";
                  return (
                    <tr key={client.id} className="hover:bg-white/[0.02] transition-colors">
                      {/* Client */}
                      <td className="py-4 px-4">
                        <p className="font-semibold text-white">{(client as any).user?.name || "-"}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{(client as any).user?.email || "-"}</p>
                        {(client as any).user?.phone && <p className="text-xs text-gray-600 mt-0.5">{(client as any).user.phone}</p>}
                      </td>
                      {/* Connexion App */}
                      <td className="py-4 px-4">
                        <span className={"inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border " + CONN_COLOR[cs]}>
                          <span className={"h-1.5 w-1.5 rounded-full " + CONN_DOT[cs]} />
                          <Icon className="h-3 w-3" />
                          {CONN_LABEL[cs]}
                        </span>
                        {client.lastSeenAt && (
                          <p className="text-[10px] text-gray-600 mt-1">
                            {new Date(client.lastSeenAt).toLocaleString("fr-FR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" })}
                          </p>
                        )}
                      </td>
                      {/* Device ID */}
                      <td className="py-4 px-4">
                        {client.deviceId ? (
                          <div className="flex items-center gap-1.5">
                            <Smartphone className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                            <code className="text-xs font-mono text-violet-400 max-w-[120px] truncate">{client.deviceId}</code>
                            <CopyBtn text={client.deviceId} />
                          </div>
                        ) : (
                          <span className="text-xs text-gray-600 italic">En attente</span>
                        )}
                      </td>
                      {/* Token */}
                      <td className="py-4 px-4">
                        {isSupport ? (
                          <span className="text-gray-600 flex items-center gap-1 text-xs"><ShieldAlert className="h-3 w-3" /> Masque</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <code className="text-xs font-mono text-cyan-400 bg-cyan-500/10 px-2 py-1 rounded-lg">{client.token}</code>
                            <CopyBtn text={client.token} />
                          </div>
                        )}
                      </td>
                      {/* Quota */}
                      <td className="py-4 px-4">
                        <div className="space-y-1 min-w-[90px]">
                          <div className="flex justify-between text-[10px] text-gray-500">
                            <span>{qUsed.toFixed(1)} Go</span><span>{qTotal.toFixed(1)} Go</span>
                          </div>
                          <div className="w-full h-1.5 bg-[#1a1f2e] rounded-full overflow-hidden">
                            <div className={"h-full rounded-full " + (pct > 90 ? "bg-rose-500" : pct > 60 ? "bg-amber-500" : "bg-cyan-500")} style={{ width: pct + "%" }} />
                          </div>
                        </div>
                      </td>
                      {/* Statut compte */}
                      <td className="py-4 px-4 text-center">
                        <span className={"inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border " + (
                          isActive ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                          client.status === "suspended" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                          "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        )}>
                          <span className={"h-1.5 w-1.5 rounded-full " + (isActive ? "bg-emerald-400" : client.status === "suspended" ? "bg-amber-400" : "bg-rose-400")} />
                          {isActive ? "Actif" : client.status === "suspended" ? "Suspendu" : "Expire"}
                        </span>
                      </td>
                      {/* Actions */}
                      {!isSupport && (
                        <td className="py-4 px-4 text-right">
                          <div className="flex justify-end gap-1">
                            <button onClick={async () => { try { isActive ? await suspendClient(client.id) : await activateClient(client.id); load(); } catch { alert("Erreur"); } }}
                              title={isActive ? "Suspendre" : "Activer"}
                              className="p-1.5 text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg cursor-pointer transition-colors">
                              {isActive ? <Ban className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
                            </button>
                            <button onClick={async () => { if (!confirm("Supprimer ce client ?")) return; try { await deleteClient(client.id); load(); } catch { alert("Erreur"); } }}
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
          <p className="text-sm text-gray-500 max-w-sm mx-auto mt-1">Creez votre premier abonne VPN.</p>
          {!isSupport && (
            <button onClick={() => setShowAdd(true)}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-xl bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 cursor-pointer">
              Creer le premier client
            </button>
          )}
        </div>
      )}

      {/* ── Create modal ── */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-[#1a1f2e]">
              <h2 className="font-bold text-white">Nouveau client VPN</h2>
              <button onClick={() => setShowAdd(false)} className="text-gray-500 hover:text-white cursor-pointer"><X className="h-5 w-5" /></button>
            </div>
            <form onSubmit={handleCreate} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Nom complet *</label>
                <input type="text" placeholder="Jean Dupont" value={name} onChange={e => setName(e.target.value)} required
                  className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Telephone</label>
                  <input type="tel" placeholder="+237 6XX..." value={phone} onChange={e => setPhone(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Email</label>
                  <input type="email" placeholder="jean@mail.com" value={email} onChange={e => setEmail(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                  Device ID <span className="text-gray-600 font-normal normal-case">(optionnel — peut etre fourni par l app)</span>
                </label>
                <div className="relative">
                  <Smartphone className="absolute left-3 top-2.5 h-4 w-4 text-gray-600" />
                  <input type="text" placeholder="ex: a1b2c3d4e5f6..." value={deviceId} onChange={e => setDeviceId(e.target.value)}
                    className="w-full pl-9 pr-4 py-2.5 text-sm font-mono bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-violet-500" />
                </div>
                <p className="text-xs text-gray-600 mt-1">Si vide, le client sera identifie automatiquement a son premier lancement de l app.</p>
              </div>

              <div className="bg-cyan-500/5 border border-cyan-500/10 rounded-xl p-3 text-xs text-cyan-600">
                Apres creation, attribuez un <strong>Forfait Data</strong> pour activer son VPN.
                L app mobile reconnaitra l appareil par Device ID ou telephone.
              </div>

              <div className="flex gap-3 justify-end pt-1">
                <button type="button" onClick={() => setShowAdd(false)}
                  className="px-4 py-2 text-sm rounded-xl bg-[#0f1218] text-gray-400 hover:bg-[#1a1f2e] cursor-pointer">
                  Annuler
                </button>
                <button type="submit" disabled={creating || !name.trim()}
                  className="px-5 py-2 text-sm font-semibold rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black disabled:opacity-50 cursor-pointer">
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

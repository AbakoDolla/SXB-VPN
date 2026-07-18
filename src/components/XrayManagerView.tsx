import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import {
  fetchXrayAccounts, createXrayAccount, updateXrayAccount,
  deleteXrayAccount, suspendXrayAccount, fetchXrayStats,
  fetchXrayProtocols, XrayAccount,
} from "../api/xray";
import {
  Zap, Plus, Trash2, RefreshCw, Edit3, Power, Copy, Check,
  X, AlertTriangle, Activity, Link,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

const PROTO_COLORS: Record<string, string> = {
  vless: "text-cyan-400 bg-cyan-500/10",
  vmess: "text-blue-400 bg-blue-500/10",
  trojan: "text-amber-400 bg-amber-500/10",
  shadowsocks: "text-purple-400 bg-purple-500/10",
};

const DEFAULT_FORM = {
  name: "", protocol: "vless", host: "", port: "", path: "/",
  tls: false, sni: "", network: "ws",
  quotaGB: "", expireAt: "", maxDevices: 1,
  password: "", method: "aes-256-gcm",
};

function fmtBytes(b: string | null): string {
  if (!b) return "∞";
  const n = Number(b);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " MB";
  return n + " B";
}

export default function XrayManagerView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const [accounts, setAccounts] = useState<XrayAccount[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, byProtocol: [] as any[] });
  const [protocols, setProtocols] = useState<string[]>(['vless', 'vmess', 'trojan', 'shadowsocks']);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [filterProto, setFilterProto] = useState("all");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [accs, st, proto] = await Promise.all([
        fetchXrayAccounts(),
        fetchXrayStats(),
        fetchXrayProtocols(),
      ]);
      setAccounts(accs);
      setStats(st);
      setProtocols(proto.protocols);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm({ ...DEFAULT_FORM }); setError(""); setShowForm(true); };

  const openEdit = (acc: XrayAccount) => {
    setEditId(acc.id);
    setForm({
      name: acc.name, protocol: acc.protocol, host: acc.host,
      port: String(acc.port), path: acc.path || "/",
      tls: acc.tls, sni: acc.sni || "", network: acc.network,
      quotaGB: acc.quotaTotal ? String(Number(acc.quotaTotal) / 1e9) : "",
      expireAt: acc.expireAt ? acc.expireAt.slice(0, 10) : "",
      maxDevices: acc.maxDevices,
      password: acc.password || "", method: acc.method || "aes-256-gcm",
    });
    setError(""); setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.host || !form.port) { setError("Nom, hôte et port sont requis"); return; }
    setSaving(true); setError("");
    try {
      const data = {
        ...form, port: Number(form.port), maxDevices: Number(form.maxDevices),
        quotaGB: form.quotaGB ? Number(form.quotaGB) : undefined,
        expireAt: form.expireAt || undefined,
      };
      if (editId) await updateXrayAccount(editId, data);
      else await createXrayAccount(data);
      setShowForm(false); load();
    } catch (err: any) { setError(err.message || "Erreur"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Supprimer le compte Xray "${name}" ?`)) return;
    await deleteXrayAccount(id); load();
  };

  const handleSuspend = async (id: string) => { await suspendXrayAccount(id); load(); };

  const copyLink = (id: string, link: string) => {
    navigator.clipboard.writeText(link);
    setCopied(id); setTimeout(() => setCopied(null), 1500);
  };

  const filtered = accounts.filter(a =>
    (filterProto === "all" || a.protocol === filterProto) &&
    (a.name.toLowerCase().includes(search.toLowerCase()) || a.host.includes(search))
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-500/10 rounded-xl">
            <Zap className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Xray Manager</h1>
            <p className="text-sm text-gray-500">VLESS · VMess · Trojan · Shadowsocks</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-xl text-sm font-medium border border-blue-500/20 transition-colors">
              <Plus className="w-4 h-4" /> Nouveau compte
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total</p>
          <p className="text-2xl font-bold text-white">{stats.total}</p>
        </div>
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Actifs</p>
          <p className="text-2xl font-bold text-emerald-400">{stats.active}</p>
        </div>
        {stats.byProtocol.map((bp: any) => (
          <div key={bp.protocol} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1 capitalize">{bp.protocol}</p>
            <p className={`text-2xl font-bold ${(PROTO_COLORS[bp.protocol] || "text-gray-400").split(" ")[0]}`}>{bp._count.id}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 flex-wrap">
          {["all", ...protocols].map(p => (
            <button key={p} onClick={() => setFilterProto(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                filterProto === p
                  ? (p === "all" ? "bg-white/10 text-white" : `${PROTO_COLORS[p]} border border-current/20`)
                  : "text-gray-500 hover:text-gray-300"
              }`}>
              {p === "all" ? "Tous" : p}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher..." className="px-3 py-1.5 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors sm:ml-auto" />
      </div>

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Chargement...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Zap className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Aucun compte Xray</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-blue-400 hover:text-blue-300 text-sm">+ Créer un compte</button>}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1a1f2e]">
                {["Nom", "Protocole", "Serveur", "Quota", "Expiration", "Statut", ""].map(h => (
                  <th key={h} className="text-left text-xs text-gray-500 font-medium px-4 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1a1f2e]">
              {filtered.map(acc => (
                <tr key={acc.id} className="hover:bg-white/2 transition-colors">
                  <td className="px-4 py-3">
                    <span className="text-white text-sm font-medium">{acc.name}</span>
                    {acc.client && <p className="text-xs text-gray-600">{acc.client.user.name}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${PROTO_COLORS[acc.protocol] || "text-gray-400 bg-gray-500/10"}`}>
                      {acc.protocol}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400 font-mono">{acc.host}:{acc.port}</span>
                    <p className="text-xs text-gray-600">{acc.network}{acc.tls ? " + TLS" : ""}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400">
                      {fmtBytes(acc.quotaUsed)} / {fmtBytes(acc.quotaTotal)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-400">
                      {acc.expireAt ? new Date(acc.expireAt).toLocaleDateString('fr') : "∞"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      acc.status === "active" ? "text-emerald-400 bg-emerald-500/10"
                        : acc.status === "suspended" ? "text-amber-400 bg-amber-500/10"
                        : "text-rose-400 bg-rose-500/10"
                    }`}>{acc.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {acc.link && (
                        <button onClick={() => copyLink(acc.id, acc.link!)} title="Copier le lien"
                          className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors">
                          {copied === acc.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {isAdmin && <>
                        <button onClick={() => openEdit(acc)} className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleSuspend(acc.id)}
                          className={`p-1.5 rounded-lg transition-colors ${acc.status === "suspended" ? "text-emerald-400 hover:bg-emerald-500/10" : "text-amber-400 hover:bg-amber-500/10"}`}>
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleDelete(acc.id, acc.name)} className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold">{editId ? "Modifier" : "Nouveau"} compte Xray</h2>
              <button onClick={() => setShowForm(false)} className="p-1.5 text-gray-400 hover:text-white rounded-lg"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Nom *</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Protocole *</label>
                  <select value={form.protocol} onChange={e => setForm(f => ({ ...f, protocol: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                    {protocols.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Network</label>
                  <select value={form.network} onChange={e => setForm(f => ({ ...f, network: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                    {['ws', 'grpc', 'tcp', 'h2'].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Hôte *</label>
                  <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} required
                    placeholder="vpn.example.com" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Port *</label>
                  <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} required
                    placeholder="443" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Path</label>
                  <input value={form.path} onChange={e => setForm(f => ({ ...f, path: e.target.value }))}
                    placeholder="/" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">SNI</label>
                  <input value={form.sni} onChange={e => setForm(f => ({ ...f, sni: e.target.value }))}
                    placeholder="example.com" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                {(form.protocol === "trojan" || form.protocol === "shadowsocks") && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Mot de passe</label>
                    <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                )}
                {form.protocol === "shadowsocks" && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Méthode</label>
                    <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                      {['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm'].map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Quota (GB)</label>
                  <input type="number" step="0.1" value={form.quotaGB} onChange={e => setForm(f => ({ ...f, quotaGB: e.target.value }))}
                    placeholder="Illimité" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Expiration</label>
                  <input type="date" value={form.expireAt} onChange={e => setForm(f => ({ ...f, expireAt: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Appareils max</label>
                  <input type="number" value={form.maxDevices} onChange={e => setForm(f => ({ ...f, maxDevices: Number(e.target.value) }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setForm(f => ({ ...f, tls: !f.tls }))}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors ${form.tls ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-400" : "bg-transparent border-[#1a1f2e] text-gray-500"}`}>
                  {form.tls ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                  TLS
                </button>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">Annuler</button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 text-sm font-medium rounded-xl border border-blue-500/20 disabled:opacity-50">
                  {saving ? "..." : editId ? "Mettre à jour" : "Créer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import {
  fetchSshAccounts, createSshAccount, updateSshAccount,
  deleteSshAccount, suspendSshAccount, testSshConnection,
  fetchSshStats, SshAccount,
} from "../api/ssh";
import { fetchPayloads, SshPayload } from "../api/payload";
import {
  Terminal, Plus, Trash2, RefreshCw, Edit3, Power, Activity,
  Network, Key, Clock, HardDrive, ChevronDown, ChevronUp,
  Upload, Shield, Wifi, X, Check, AlertTriangle,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

const DEFAULT_FORM = {
  name: "", host: "", port: 22, username: "", password: "",
  mode: "import" as "create" | "import",
  expireAt: "", quotaGB: "", connectionLimit: 1,
  compression: false, tcpNodelay: true, slowDns: false,
  payloadId: "", dns: "", sni: "",
};

function fmtBytes(b: string | null): string {
  if (!b) return "∞";
  const n = Number(b);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " MB";
  return n + " B";
}

export default function SSHManagerView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const [accounts, setAccounts] = useState<SshAccount[]>([]);
  const [payloads, setPayloads] = useState<SshPayload[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, suspended: 0, expired: 0 });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [accs, pays, st] = await Promise.all([
        fetchSshAccounts(),
        fetchPayloads(),
        fetchSshStats(),
      ]);
      setAccounts(accs);
      setPayloads(pays);
      setStats(st);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditId(null);
    setForm({ ...DEFAULT_FORM });
    setError("");
    setShowForm(true);
  };

  const openEdit = (acc: SshAccount) => {
    setEditId(acc.id);
    setForm({
      name: acc.name, host: acc.host, port: acc.port,
      username: acc.username, password: "",
      mode: acc.mode as any,
      expireAt: acc.expireAt ? acc.expireAt.slice(0, 10) : "",
      quotaGB: acc.quotaTotal ? String(Number(acc.quotaTotal) / 1e9) : "",
      connectionLimit: acc.connectionLimit,
      compression: acc.compression, tcpNodelay: acc.tcpNodelay, slowDns: acc.slowDns,
      payloadId: acc.payloadId || "", dns: acc.dns || "", sni: acc.sni || "",
    });
    setError("");
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.host || !form.username || (!editId && !form.password)) {
      setError("Nom, hôte, nom d'utilisateur et mot de passe sont requis");
      return;
    }
    setSaving(true); setError("");
    try {
      const payload = {
        ...form,
        port: Number(form.port),
        connectionLimit: Number(form.connectionLimit),
        quotaGB: form.quotaGB ? Number(form.quotaGB) : undefined,
        expireAt: form.expireAt || undefined,
        payloadId: form.payloadId || undefined,
        dns: form.dns || undefined,
        sni: form.sni || undefined,
      };
      if (editId) await updateSshAccount(editId, payload);
      else await createSshAccount(payload as any);
      setShowForm(false);
      load();
    } catch (err: any) {
      setError(err.message || "Erreur lors de la sauvegarde");
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Supprimer le compte SSH "${name}" ?`)) return;
    await deleteSshAccount(id);
    load();
  };

  const handleSuspend = async (id: string) => {
    await suspendSshAccount(id);
    load();
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const result = await testSshConnection(id);
      setTestResult(prev => ({ ...prev, [id]: { ok: result.reachable, msg: result.message } }));
    } catch {
      setTestResult(prev => ({ ...prev, [id]: { ok: false, msg: "Erreur de test" } }));
    } finally { setTesting(null); }
  };

  const filtered = accounts.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.host.toLowerCase().includes(search.toLowerCase()) ||
    a.username.toLowerCase().includes(search.toLowerCase())
  );

  const statusColor = (s: string) => ({
    active: "text-emerald-400 bg-emerald-500/10",
    suspended: "text-amber-400 bg-amber-500/10",
    expired: "text-rose-400 bg-rose-500/10",
  }[s] || "text-gray-400 bg-gray-500/10");

  const modeColor = (m: string) => m === "import"
    ? "text-violet-400 bg-violet-500/10"
    : "text-cyan-400 bg-cyan-500/10";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-cyan-500/10 rounded-xl">
            <Terminal className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">SSH Manager</h1>
            <p className="text-sm text-gray-500">Gestion des comptes SSH — Création & Importation</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 rounded-xl text-sm font-medium transition-colors border border-cyan-500/20">
              <Plus className="w-4 h-4" />
              Ajouter / Importer
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total", value: stats.total, color: "text-white", icon: Terminal },
          { label: "Actifs", value: stats.active, color: "text-emerald-400", icon: Activity },
          { label: "Suspendus", value: stats.suspended, color: "text-amber-400", icon: Power },
          { label: "Expirés", value: stats.expired, color: "text-rose-400", icon: Clock },
        ].map(s => (
          <div key={s.label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <s.icon className={`w-4 h-4 ${s.color}`} />
              <span className="text-xs text-gray-500">{s.label}</span>
            </div>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Network className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher par nom, hôte, utilisateur..."
          className="w-full pl-9 pr-4 py-2.5 bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors"
        />
      </div>

      {/* Accounts list */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Chargement...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Terminal className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Aucun compte SSH configuré</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-cyan-400 hover:text-cyan-300 text-sm">+ Ajouter un compte</button>}
          </div>
        ) : filtered.map(acc => (
          <div key={acc.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
            <div className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 bg-cyan-500/5 rounded-lg shrink-0">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white font-medium">{acc.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor(acc.status)}`}>{acc.status}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${modeColor(acc.mode)}`}>
                        {acc.mode === "import" ? "Importé" : "Créé"}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{acc.username}@{acc.host}:{acc.port}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {testResult[acc.id] && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${testResult[acc.id].ok ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"}`}>
                      {testResult[acc.id].ok ? "✓ OK" : "✗ KO"}
                    </span>
                  )}
                  <button onClick={() => handleTest(acc.id)} disabled={testing === acc.id}
                    title="Tester connexion"
                    className="p-1.5 text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded-lg transition-colors disabled:opacity-50">
                    {testing === acc.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                  </button>
                  {isAdmin && <>
                    <button onClick={() => openEdit(acc)} title="Modifier"
                      className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleSuspend(acc.id)} title={acc.status === "suspended" ? "Réactiver" : "Suspendre"}
                      className={`p-1.5 rounded-lg transition-colors ${acc.status === "suspended" ? "text-emerald-400 hover:bg-emerald-500/10" : "text-amber-400 hover:bg-amber-500/10"}`}>
                      <Power className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleDelete(acc.id, acc.name)} title="Supprimer"
                      className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>}
                  <button onClick={() => setExpandedId(expandedId === acc.id ? null : acc.id)}
                    className="p-1.5 text-gray-400 hover:text-white rounded-lg transition-colors">
                    {expandedId === acc.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {expandedId === acc.id && (
                <div className="mt-4 pt-4 border-t border-[#1a1f2e] grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-gray-500 mb-0.5">Quota</p>
                    <p className="text-white">{fmtBytes(acc.quotaUsed)} / {fmtBytes(acc.quotaTotal)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-0.5">Expiration</p>
                    <p className="text-white">{acc.expireAt ? new Date(acc.expireAt).toLocaleDateString('fr') : "Illimitée"}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-0.5">Limite connexions</p>
                    <p className="text-white">{acc.connectionLimit}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 mb-0.5">Options</p>
                    <div className="flex gap-1 flex-wrap">
                      {acc.compression && <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded">Compression</span>}
                      {acc.tcpNodelay && <span className="px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded">TCP_NODELAY</span>}
                      {acc.slowDns && <span className="px-1.5 py-0.5 bg-purple-500/10 text-purple-400 rounded">SlowDNS</span>}
                    </div>
                  </div>
                  {acc.payload && (
                    <div className="col-span-2">
                      <p className="text-gray-500 mb-0.5">Payload associé</p>
                      <p className="text-violet-400">{acc.payload.name}</p>
                    </div>
                  )}
                  {acc.sni && (
                    <div>
                      <p className="text-gray-500 mb-0.5">SNI</p>
                      <p className="text-white font-mono">{acc.sni}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <div className="flex items-center gap-3">
                {editId ? <Edit3 className="w-5 h-5 text-cyan-400" /> : <Upload className="w-5 h-5 text-cyan-400" />}
                <h2 className="text-white font-semibold">
                  {editId ? "Modifier le compte SSH" : "Ajouter / Importer un compte SSH"}
                </h2>
              </div>
              <button onClick={() => setShowForm(false)} className="p-1.5 text-gray-400 hover:text-white rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-5">
              {error && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              {/* Mode selector */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">Mode</label>
                <div className="flex gap-2">
                  {["create", "import"].map(m => (
                    <button type="button" key={m}
                      onClick={() => setForm(f => ({ ...f, mode: m as any }))}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors border ${
                        form.mode === m
                          ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-400"
                          : "bg-transparent border-[#1a1f2e] text-gray-500 hover:text-gray-300"
                      }`}>
                      {m === "create" ? "🔧 Création automatique" : "📥 Importation existant"}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mt-1.5">
                  {form.mode === "import"
                    ? "Importer des identifiants SSH provenant d'une autre source"
                    : "Créer un nouveau compte SSH directement sur le serveur"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Nom du profil *</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                    placeholder="Mon compte SSH" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Hôte SSH *</label>
                  <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} required
                    placeholder="141.95.112.93" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Port SSH *</label>
                  <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: Number(e.target.value) }))} required
                    placeholder="22" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Nom d'utilisateur *</label>
                  <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required
                    placeholder="ubuntu" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Mot de passe {!editId && "*"}</label>
                  <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    placeholder={editId ? "Laisser vide pour ne pas changer" : "••••••••"}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Expiration</label>
                  <input type="date" value={form.expireAt} onChange={e => setForm(f => ({ ...f, expireAt: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Quota (GB)</label>
                  <input type="number" step="0.1" value={form.quotaGB} onChange={e => setForm(f => ({ ...f, quotaGB: e.target.value }))}
                    placeholder="Illimité" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Limite connexions</label>
                  <input type="number" value={form.connectionLimit} onChange={e => setForm(f => ({ ...f, connectionLimit: Number(e.target.value) }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Payload</label>
                  <select value={form.payloadId} onChange={e => setForm(f => ({ ...f, payloadId: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500">
                    <option value="">Aucun payload</option>
                    {payloads.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">DNS</label>
                  <input value={form.dns} onChange={e => setForm(f => ({ ...f, dns: e.target.value }))}
                    placeholder="8.8.8.8" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">SNI</label>
                  <input value={form.sni} onChange={e => setForm(f => ({ ...f, sni: e.target.value }))}
                    placeholder="example.com" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
              </div>

              {/* Options */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">Options TCP</label>
                <div className="flex gap-3 flex-wrap">
                  {[
                    { key: "compression", label: "Compression" },
                    { key: "tcpNodelay", label: "TCP_NODELAY" },
                    { key: "slowDns", label: "SlowDNS" },
                  ].map(opt => (
                    <button type="button" key={opt.key}
                      onClick={() => setForm(f => ({ ...f, [opt.key]: !(f as any)[opt.key] }))}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors ${
                        (form as any)[opt.key]
                          ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-400"
                          : "bg-transparent border-[#1a1f2e] text-gray-500"
                      }`}>
                      {(form as any)[opt.key] ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5 transition-colors">
                  Annuler
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-sm font-medium rounded-xl border border-cyan-500/20 transition-colors disabled:opacity-50">
                  {saving ? "Sauvegarde..." : editId ? "Mettre à jour" : "Créer / Importer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

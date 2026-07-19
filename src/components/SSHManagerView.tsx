import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import {
  fetchSshAccounts, createSshAccount, updateSshAccount,
  deleteSshAccount, suspendSshAccount, testSshConnection,
  fetchSshStats, SshAccount,
} from "../api/ssh";
import {
  fetchPayloads, createPayload, updatePayload, deletePayload,
  testPayload, SshPayload,
} from "../api/payload";
import {
  Terminal, Plus, Trash2, RefreshCw, Edit3, Power, Activity,
  Key, Clock, HardDrive, Shield, Wifi, X, Check, AlertTriangle,
  Code2, Copy, Network,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

/* ─── helpers ─────────────────────────────────────────────────── */
function fmtBytes(b: string | null): string {
  if (!b) return "∞";
  const n = Number(b);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " MB";
  return n + " B";
}

const SSH_DEFAULT = {
  name: "", host: "", port: 22, username: "", password: "",
  mode: "import" as "create" | "import",
  expireAt: "", quotaGB: "", connectionLimit: 1,
  compression: false, tcpNodelay: true, slowDns: false,
  payloadId: "", dns: "", sni: "",
};

const PAYLOAD_DEFAULT = {
  name: "", host: "", sni: "", port: "",
  content: "GET / HTTP/1.1\r\nHost: [host_port]\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
};

/* ─── SSH Accounts Panel ──────────────────────────────────────── */
function SshPanel({ isAdmin, payloads }: { isAdmin: boolean; payloads: SshPayload[] }) {
  const [accounts, setAccounts] = useState<SshAccount[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, suspended: 0, expired: 0 });
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...SSH_DEFAULT });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [accs, st] = await Promise.all([fetchSshAccounts(), fetchSshStats()]);
      setAccounts(accs);
      setStats(st);
    } catch { } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm({ ...SSH_DEFAULT }); setError(""); setShowForm(true); };
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
    setError(""); setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.host || !form.username || (!editId && !form.password)) {
      setError("Nom, hôte, utilisateur et mot de passe sont requis"); return;
    }
    setSaving(true); setError("");
    try {
      const body = {
        ...form, port: Number(form.port), connectionLimit: Number(form.connectionLimit),
        quotaGB: form.quotaGB ? Number(form.quotaGB) : undefined,
        expireAt: form.expireAt || undefined,
        payloadId: form.payloadId || undefined,
        dns: form.dns || undefined, sni: form.sni || undefined,
      };
      if (editId) await updateSshAccount(editId, body);
      else await createSshAccount(body as any);
      setShowForm(false); load();
    } catch (err: any) { setError(err.message || "Erreur"); }
    finally { setSaving(false); }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const r = await testSshConnection(id);
      setTestResult(p => ({ ...p, [id]: { ok: r.reachable, msg: r.message } }));
    } catch { setTestResult(p => ({ ...p, [id]: { ok: false, msg: "Erreur" } })); }
    finally { setTesting(null); }
  };

  const filtered = accounts.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.host.toLowerCase().includes(search.toLowerCase()) ||
    a.username.toLowerCase().includes(search.toLowerCase())
  );

  const statusBadge = (s: string) => ({
    active:    "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    suspended: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    expired:   "text-rose-400 bg-rose-500/10 border-rose-500/20",
  }[s] || "text-gray-400 bg-gray-500/10 border-gray-700/20");

  return (
    <div className="space-y-5">
      {/* Stats row */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total",     value: stats.total,     color: "text-cyan-400" },
          { label: "Actifs",    value: stats.active,    color: "text-emerald-400" },
          { label: "Suspendus", value: stats.suspended, color: "text-amber-400" },
          { label: "Expirés",   value: stats.expired,   color: "text-rose-400" },
        ].map(s => (
          <div key={s.label} className="bg-[#0a0d14] border border-[#1a1f2e] rounded-xl p-3 text-center">
            <p className={"text-xl font-bold " + s.color}>{s.value}</p>
            <p className="text-xs text-gray-500">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher un compte..." type="text"
          className="flex-1 px-3 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500" />
        <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors cursor-pointer">
          <RefreshCw className="w-4 h-4" />
        </button>
        {isAdmin && (
          <button onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-400 text-sm font-medium rounded-xl border border-cyan-500/20 transition-colors cursor-pointer">
            <Plus className="w-4 h-4" /> Nouveau compte
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-500">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Chargement...
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center text-gray-600 text-sm">Aucun compte SSH</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(acc => {
            const expanded = expandedId === acc.id;
            const tr = testResult[acc.id];
            const payloadName = payloads.find(p => p.id === acc.payloadId)?.name;
            return (
              <div key={acc.id} className="bg-[#0a0d14] border border-[#1a1f2e] rounded-xl overflow-hidden">
                {/* Row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center shrink-0">
                    <Terminal className="w-4 h-4 text-cyan-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-white">{acc.name}</span>
                      <span className={"text-xs px-2 py-0.5 rounded-full border " + statusBadge(acc.status)}>{acc.status}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[#1a1f2e] text-gray-500 border border-[#252b3b]">{acc.mode}</span>
                      {payloadName && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 flex items-center gap-1">
                          <Code2 className="w-2.5 h-2.5" />{payloadName}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono">{acc.username}@{acc.host}:{acc.port}</p>
                  </div>
                  <div className="hidden sm:flex items-center gap-3 text-xs text-gray-500 shrink-0">
                    <span className="flex items-center gap-1"><HardDrive className="w-3 h-3" />{fmtBytes(acc.quotaTotal)}</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{acc.expireAt ? new Date(acc.expireAt).toLocaleDateString("fr-FR") : "∞"}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {tr && (
                      <span className={"text-xs font-medium " + (tr.ok ? "text-emerald-400" : "text-rose-400")}>
                        {tr.ok ? "✓ OK" : "✗ KO"}
                      </span>
                    )}
                    <button onClick={() => handleTest(acc.id)} disabled={testing === acc.id} title="Tester la connexion"
                      className="p-1.5 text-gray-600 hover:text-cyan-400 rounded-lg hover:bg-cyan-500/10 transition-colors cursor-pointer disabled:opacity-40">
                      {testing === acc.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
                    </button>
                    {isAdmin && (
                      <>
                        <button onClick={() => openEdit(acc)} title="Modifier"
                          className="p-1.5 text-gray-600 hover:text-white rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={async () => { await suspendSshAccount(acc.id); load(); }} title="Suspendre/Activer"
                          className="p-1.5 text-gray-600 hover:text-amber-400 rounded-lg hover:bg-amber-500/10 transition-colors cursor-pointer">
                          <Power className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={async () => { if (confirm(`Supprimer "${acc.name}" ?`)) { await deleteSshAccount(acc.id); load(); } }} title="Supprimer"
                          className="p-1.5 text-gray-600 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                    <button onClick={() => setExpandedId(expanded ? null : acc.id)}
                      className="p-1.5 text-gray-600 hover:text-white rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                      <Activity className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {/* Expanded details */}
                {expanded && (
                  <div className="border-t border-[#1a1f2e] px-4 py-3 bg-[#07090e] grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div><span className="text-gray-600">Connexions max</span><p className="text-white font-medium mt-0.5">{acc.connectionLimit}</p></div>
                    <div><span className="text-gray-600">Quota utilisé</span><p className="text-white font-medium mt-0.5">{fmtBytes(acc.quotaUsed)} / {fmtBytes(acc.quotaTotal)}</p></div>
                    <div><span className="text-gray-600">Options TCP</span><p className="text-white font-medium mt-0.5">{[acc.compression && "Compression", acc.tcpNodelay && "NoDelay", acc.slowDns && "SlowDNS"].filter(Boolean).join(", ") || "—"}</p></div>
                    <div><span className="text-gray-600">DNS / SNI</span><p className="text-white font-medium mt-0.5">{acc.dns || acc.sni || "—"}</p></div>
                    {payloadName && <div className="col-span-2 sm:col-span-4"><span className="text-gray-600">Payload associé</span><p className="text-violet-400 font-medium mt-0.5">{payloadName}</p></div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto py-8 px-4">
          <div className="w-full max-w-2xl bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e]">
              <h2 className="text-base font-semibold text-white">{editId ? "Modifier le compte SSH" : "Nouveau compte SSH"}</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Nom *</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Mode</label>
                  <select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value as any }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500">
                    <option value="import">Importer (existant)</option>
                    <option value="create">Créer (nouveau)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Payload SSH</label>
                  <select value={form.payloadId} onChange={e => setForm(f => ({ ...f, payloadId: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500">
                    <option value="">Sans payload</option>
                    {payloads.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="col-span-2 grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm text-gray-400 mb-1.5">Hôte / IP *</label>
                    <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} required
                      placeholder="123.45.67.89" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Port</label>
                    <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: Number(e.target.value) }))}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Nom d'utilisateur *</label>
                  <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Mot de passe {editId ? "(laisser vide = inchangé)" : "*"}</label>
                  <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Quota (GB)</label>
                  <input type="number" step="0.1" value={form.quotaGB} onChange={e => setForm(f => ({ ...f, quotaGB: e.target.value }))}
                    placeholder="Illimité" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Expiration</label>
                  <input type="date" value={form.expireAt} onChange={e => setForm(f => ({ ...f, expireAt: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Limit connexions</label>
                  <input type="number" min={1} value={form.connectionLimit} onChange={e => setForm(f => ({ ...f, connectionLimit: Number(e.target.value) }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
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
              <div>
                <label className="block text-sm text-gray-400 mb-2">Options TCP</label>
                <div className="flex gap-2 flex-wrap">
                  {[{ key: "compression", label: "Compression" }, { key: "tcpNodelay", label: "TCP_NODELAY" }, { key: "slowDns", label: "SlowDNS" }].map(opt => (
                    <button type="button" key={opt.key}
                      onClick={() => setForm(f => ({ ...f, [opt.key]: !(f as any)[opt.key] }))}
                      className={"flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs border transition-colors " + ((form as any)[opt.key]
                        ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-400" : "bg-transparent border-[#1a1f2e] text-gray-500")}>
                      {(form as any)[opt.key] ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}{opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5 transition-colors">Annuler</button>
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

/* ─── Payload Panel ───────────────────────────────────────────── */
function PayloadPanel({ isAdmin, onPayloadsChanged }: { isAdmin: boolean; onPayloadsChanged: () => void }) {
  const [payloads, setPayloads] = useState<SshPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...PAYLOAD_DEFAULT });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setPayloads(await fetchPayloads()); }
    catch { } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm({ ...PAYLOAD_DEFAULT }); setError(""); setShowForm(true); };
  const openEdit = (p: SshPayload) => {
    setEditId(p.id);
    setForm({ name: p.name, host: p.host || "", sni: p.sni || "", port: String(p.port || ""), content: p.content || PAYLOAD_DEFAULT.content });
    setError(""); setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name) { setError("Le nom est requis"); return; }
    setSaving(true); setError("");
    try {
      const data = { ...form, port: form.port ? Number(form.port) : undefined };
      if (editId) await updatePayload(editId, data);
      else await createPayload(data);
      setShowForm(false); load(); onPayloadsChanged();
    } catch (err: any) { setError(err.message || "Erreur"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Supprimer le payload "${name}" ?`)) return;
    await deletePayload(id); load(); onPayloadsChanged();
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const r = await testPayload(id);
      setTestResult(p => ({ ...p, [id]: { ok: r.reachable, msg: r.message } }));
    } catch { setTestResult(p => ({ ...p, [id]: { ok: false, msg: "Erreur" } })); }
    finally { setTesting(null); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl transition-colors cursor-pointer">
          <RefreshCw className="w-4 h-4" />
        </button>
        {isAdmin && (
          <button onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-violet-500/15 hover:bg-violet-500/25 text-violet-400 text-sm font-medium rounded-xl border border-violet-500/20 transition-colors cursor-pointer">
            <Plus className="w-4 h-4" /> Nouveau payload
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-500">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Chargement...
        </div>
      ) : payloads.length === 0 ? (
        <div className="py-16 text-center text-gray-600 text-sm">Aucun payload configuré</div>
      ) : (
        <div className="space-y-3">
          {payloads.map(p => {
            const tr = testResult[p.id];
            return (
              <div key={p.id} className="bg-[#0a0d14] border border-[#1a1f2e] rounded-xl overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
                    <Code2 className="w-4 h-4 text-violet-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{p.name}</span>
                      {(p as any)._count?.sshAccounts > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                          {(p as any)._count.sshAccounts} compte{(p as any)._count.sshAccounts > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 font-mono mt-0.5">{[p.host, p.port && `:${p.port}`].filter(Boolean).join("") || "—"}{p.sni ? ` · SNI: ${p.sni}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {tr && <span className={"text-xs font-medium " + (tr.ok ? "text-emerald-400" : "text-rose-400")}>{tr.ok ? "✓" : "✗"}</span>}
                    <button onClick={() => handleTest(p.id)} disabled={testing === p.id} title="Tester"
                      className="p-1.5 text-gray-600 hover:text-violet-400 rounded-lg hover:bg-violet-500/10 transition-colors cursor-pointer disabled:opacity-40">
                      {testing === p.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Network className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={() => { navigator.clipboard.writeText(p.content || ""); setCopied(p.id); setTimeout(() => setCopied(null), 1500); }} title="Copier le contenu"
                      className="p-1.5 text-gray-600 hover:text-white rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                      {copied === p.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    {isAdmin && (
                      <>
                        <button onClick={() => openEdit(p)} className="p-1.5 text-gray-600 hover:text-white rounded-lg hover:bg-white/5 transition-colors cursor-pointer"><Edit3 className="w-3.5 h-3.5" /></button>
                        <button onClick={() => handleDelete(p.id, p.name)} className="p-1.5 text-gray-600 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                      </>
                    )}
                  </div>
                </div>
                {p.content && (
                  <div className="border-t border-[#1a1f2e] px-4 py-2 bg-[#07090e]">
                    <pre className="text-xs text-gray-500 font-mono whitespace-pre-wrap break-all line-clamp-3">{p.content}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto py-8 px-4">
          <div className="w-full max-w-xl bg-[#0a0d14] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e]">
              <h2 className="text-base font-semibold text-white">{editId ? "Modifier le payload" : "Nouveau payload"}</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white cursor-pointer"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Nom *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                  placeholder="Mon Payload" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Host</label>
                  <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                    placeholder="example.com" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Port</label>
                  <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
                    placeholder="80" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">SNI</label>
                <input value={form.sni} onChange={e => setForm(f => ({ ...f, sni: e.target.value }))}
                  placeholder="example.com" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Contenu du Payload</label>
                <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} rows={7}
                  className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-violet-500 resize-y" />
                <p className="text-xs text-gray-600 mt-1">Utiliser <code className="text-violet-400">[host_port]</code> comme placeholder</p>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">Annuler</button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-violet-500/20 hover:bg-violet-500/30 text-violet-400 text-sm font-medium rounded-xl border border-violet-500/20 disabled:opacity-50">
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

/* ─── Main Export ─────────────────────────────────────────────── */
export default function SSHManagerView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const [tab, setTab] = useState<"ssh" | "payload">("ssh");
  const [payloads, setPayloads] = useState<SshPayload[]>([]);

  const reloadPayloads = async () => {
    try { setPayloads(await fetchPayloads()); } catch { }
  };
  useEffect(() => { reloadPayloads(); }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="p-2.5 bg-cyan-500/10 rounded-xl">
          <Terminal className="w-6 h-6 text-cyan-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">SSH Manager</h1>
          <p className="text-sm text-gray-500">Comptes SSH et payloads WebSocket</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-[#0a0d14] border border-[#1a1f2e] rounded-xl p-1 w-fit">
        <button onClick={() => setTab("ssh")}
          className={"flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer " + (tab === "ssh" ? "bg-cyan-500/15 text-cyan-400 border border-cyan-500/20" : "text-gray-500 hover:text-white")}>
          <Terminal className="w-3.5 h-3.5" /> Comptes SSH
        </button>
        <button onClick={() => setTab("payload")}
          className={"flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer " + (tab === "payload" ? "bg-violet-500/15 text-violet-400 border border-violet-500/20" : "text-gray-500 hover:text-white")}>
          <Code2 className="w-3.5 h-3.5" /> Payloads
        </button>
      </div>

      {tab === "ssh" ? (
        <SshPanel isAdmin={isAdmin} payloads={payloads} />
      ) : (
        <PayloadPanel isAdmin={isAdmin} onPayloadsChanged={reloadPayloads} />
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import {
  fetchPayloads, createPayload, updatePayload, deletePayload,
  testPayload, SshPayload,
} from "../api/payload";
import {
  Code2, Plus, Trash2, RefreshCw, Edit3, Wifi, X,
  AlertTriangle, Copy, Check,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

const DEFAULT_CONTENT = `GET / HTTP/1.1\r\nHost: [host_port]\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`;

const DEFAULT_FORM = {
  name: "", host: "", sni: "", port: "", content: DEFAULT_CONTENT,
};

export default function PayloadManagerView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const [payloads, setPayloads] = useState<SshPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setPayloads(await fetchPayloads()); }
    catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditId(null); setForm({ ...DEFAULT_FORM }); setError(""); setShowForm(true);
  };

  const openEdit = (p: SshPayload) => {
    setEditId(p.id);
    setForm({ name: p.name, host: p.host || "", sni: p.sni || "", port: String(p.port || ""), content: p.content || DEFAULT_CONTENT });
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
      setShowForm(false); load();
    } catch (err: any) { setError(err.message || "Erreur"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Supprimer le payload "${name}" ?`)) return;
    await deletePayload(id); load();
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const r = await testPayload(id);
      setTestResult(prev => ({ ...prev, [id]: { ok: r.reachable, msg: r.message } }));
    } catch { setTestResult(prev => ({ ...prev, [id]: { ok: false, msg: "Erreur" } })); }
    finally { setTesting(null); }
  };

  const copyContent = (id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-violet-500/10 rounded-xl">
            <Code2 className="w-6 h-6 text-violet-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Payload Manager</h1>
            <p className="text-sm text-gray-500">Gestion des payloads HTTP/WebSocket pour tunnels SSH</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-violet-500/20 hover:bg-violet-500/30 text-violet-400 rounded-xl text-sm font-medium border border-violet-500/20 transition-colors">
              <Plus className="w-4 h-4" /> Nouveau Payload
            </button>
          )}
        </div>
      </div>

      {/* Payloads */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading ? (
          <div className="col-span-2 text-center py-12 text-gray-500">Chargement...</div>
        ) : payloads.length === 0 ? (
          <div className="col-span-2 text-center py-12 text-gray-500">
            <Code2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Aucun payload configuré</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-violet-400 hover:text-violet-300 text-sm">+ Créer un payload</button>}
          </div>
        ) : payloads.map(p => (
          <div key={p.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-white font-medium">{p.name}</h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {p.host && <span className="text-xs text-gray-500 font-mono">{p.host}{p.port ? `:${p.port}` : ""}</span>}
                  {p.sni && <span className="text-xs text-violet-400">SNI: {p.sni}</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${p.status === "active" ? "text-emerald-400 bg-emerald-500/10" : "text-gray-400 bg-gray-500/10"}`}>{p.status}</span>
                  {p._count && <span className="text-xs text-gray-600">{p._count.sshAccounts} compte(s) lié(s)</span>}
                </div>
              </div>
              <div className="flex gap-1">
                {testResult[p.id] && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${testResult[p.id].ok ? "text-emerald-400 bg-emerald-500/10" : "text-rose-400 bg-rose-500/10"}`}>
                    {testResult[p.id].ok ? "✓" : "✗"}
                  </span>
                )}
                <button onClick={() => handleTest(p.id)} disabled={testing === p.id} title="Tester"
                  className="p-1.5 text-gray-400 hover:text-violet-400 hover:bg-violet-500/10 rounded-lg transition-colors disabled:opacity-50">
                  {testing === p.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
                </button>
                {isAdmin && <>
                  <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(p.id, p.name)} className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>}
              </div>
            </div>

            {p.content && (
              <div className="relative">
                <pre className="text-xs text-gray-400 bg-[#07090e] rounded-lg p-3 font-mono overflow-x-auto whitespace-pre-wrap break-all border border-[#1a1f2e]">
                  {p.content}
                </pre>
                <button onClick={() => copyContent(p.id, p.content || "")}
                  className="absolute top-2 right-2 p-1 text-gray-500 hover:text-white rounded transition-colors">
                  {copied === p.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold">{editId ? "Modifier" : "Nouveau"} Payload</h2>
              <button onClick={() => setShowForm(false)} className="p-1.5 text-gray-400 hover:text-white rounded-lg"><X className="w-5 h-5" /></button>
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
                  placeholder="My Payload" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
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
                <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} rows={8}
                  className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-violet-500 resize-y" />
                <p className="text-xs text-gray-600 mt-1">Utilisez [host_port] comme placeholder pour l'hôte:port</p>
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

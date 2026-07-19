import React, { useEffect, useState, useCallback } from "react";
import { UserRole } from "../types";
import {
  fetchSubscriptions, createSubscription, updateSubscription,
  deleteSubscription, revokeSubscription, Subscription,
  fetchVpnProfiles, VpnProfile, fetchUnifiedConfigs, UnifiedConfig,
} from "../api/vpnProfiles";
import { fetchClients } from "../api/clients";
import { fetchDevices, Device } from "../api/devices";
import { Client } from "../types";
import {
  CreditCard, Plus, Trash2, RefreshCw, Edit3, X, AlertTriangle,
  Copy, Check, ShieldOff, Clock, HardDrive, Smartphone, Search, Lock,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

function fmtGB(bytes: string | number | null): string {
  if (!bytes) return "0 GB";
  const gb = Number(bytes) / 1024 ** 3;
  return gb.toFixed(2) + " GB";
}

function statusBadge(s: string) {
  const m: Record<string, string> = {
    active:    "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20",
    expired:   "text-rose-400 bg-rose-500/10 border border-rose-500/20",
    revoked:   "text-red-400 bg-red-500/10 border border-red-500/20",
    suspended: "text-amber-400 bg-amber-500/10 border border-amber-500/20",
  };
  return m[s] || "text-gray-400 bg-gray-500/10";
}

const DEFAULT_FORM = {
  clientId: "", profileId: "", deviceId: "",
  name: "", quotaGB: "", durationDays: "30", deviceLimit: "1",
};

export default function SubscriptionsView({ currentUserRole }: Props) {
  const isAdmin =
    currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;

  const [subs, setSubs]         = useState<Subscription[]>([]);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [clients, setClients]   = useState<Client[]>([]);
  const [devices, setDevices]   = useState<Device[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState<string | null>(null);
  const [form, setForm]         = useState({ ...DEFAULT_FORM });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");
  const [copied, setCopied]     = useState<string | null>(null);
  const [search, setSearch]     = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [s, p, c, d] = await Promise.all([
        fetchSubscriptions(),
        fetchUnifiedConfigs(),
        fetchClients(),
        fetchDevices(),
      ]);
      setSubs(s); setProfiles(p); setClients(c); setDevices(d);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Auto-fill deviceId from selected client
  useEffect(() => {
    if (!form.clientId) return;
    const selectedClient = clients.find((c) => c.id === form.clientId);
    if (selectedClient?.deviceId) {
      setForm((f) => ({ ...f, deviceId: selectedClient.deviceId || "" }));
    }
  }, [form.clientId, clients]);

  const openCreate = () => {
    setEditId(null); setForm({ ...DEFAULT_FORM }); setError(""); setShowForm(true);
  };

  const openEdit = (sub: Subscription) => {
    setEditId(sub.id);
    setForm({
      clientId:    sub.clientId,
      profileId:   sub.profileId,
      deviceId:    (sub as any).deviceId ?? "",
      name:        sub.name ?? "",
      quotaGB:     String(Number(sub.quotaBytes) / 1024 ** 3),
      durationDays:String(sub.durationDays),
      deviceLimit: String(sub.deviceLimit),
    });
    setError(""); setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.clientId || !form.profileId || !form.quotaGB || !form.durationDays) {
      setError("Client, profil VPN, quota et duree sont requis"); return;
    }
    setSaving(true); setError("");
    try {
      const payload = {
        ...form,
        quotaGB:     Number(form.quotaGB),
        durationDays:Number(form.durationDays),
        deviceLimit: Number(form.deviceLimit),
        deviceId:    form.deviceId || undefined,
      };
      if (editId) {
        await updateSubscription(editId, payload);
      } else {
        await createSubscription(payload);
      }
      setShowForm(false); load();
    } catch (err: any) { setError(err.message || "Erreur"); }
    finally { setSaving(false); }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!confirm("Revoquer le forfait " + name + " ?")) return;
    await revokeSubscription(id, "Admin revocation manuelle");
    load();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm("Supprimer definitivement " + name + " ?")) return;
    await deleteSubscription(id); load();
  };

  const copyToken = (id: string, token: string) => {
    navigator.clipboard.writeText(token);
    setCopied(id); setTimeout(() => setCopied(null), 1500);
  };

  const filtered = subs.filter((s) =>
    (s.client?.user?.name || "").toLowerCase().includes(search.toLowerCase()) ||
    (s.name || "").toLowerCase().includes(search.toLowerCase()) ||
    s.dataToken.includes(search.toUpperCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-blue-400" /> Forfaits Data
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Gerez les abonnements VPN lies aux clients, devices et configurations
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-white/5 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 text-sm font-medium rounded-xl border border-blue-500/20 transition-colors">
              <Plus className="w-4 h-4" /> Nouveau forfait
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher par client, nom ou token..."
          className="w-full pl-9 pr-4 py-2.5 bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total",    value: subs.length,                                        color: "text-blue-400" },
          { label: "Actifs",   value: subs.filter((s) => s.status === "active").length,   color: "text-emerald-400" },
          { label: "Expires",  value: subs.filter((s) => s.status === "expired").length,  color: "text-rose-400" },
          { label: "Revoques", value: subs.filter((s) => s.status === "revoked").length,  color: "text-red-400" },
        ].map((stat) => (
          <div key={stat.label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <p className="text-xs text-gray-500">{stat.label}</p>
            <p className={"text-2xl font-bold mt-1 " + stat.color}>{stat.value}</p>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <RefreshCw className="w-6 h-6 text-gray-500 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500 bg-[#0f1218] border border-[#1a1f2e] rounded-2xl">
          <CreditCard className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Aucun forfait trouve</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((sub) => (
            <div key={sub.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl p-5 hover:border-[#2a3040] transition-colors">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white">{sub.name || "Forfait sans nom"}</span>
                    <span className={"px-2 py-0.5 rounded-full text-xs font-medium " + statusBadge(sub.status)}>
                      {sub.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-400">
                    <span className="text-gray-600">Client:</span>
                    <span className="text-cyan-400 font-medium">
                      {sub.client?.user?.name || sub.clientId}
                    </span>
                    {sub.client?.user?.email && (
                      <span className="text-gray-600">— {sub.client.user.email}</span>
                    )}
                  </div>
                  {sub.profile && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                      <span className="text-gray-600">Config VPN:</span>
                      <span className="text-violet-400 font-medium">{sub.profile.name}</span>
                      <span className="text-gray-600 uppercase">({sub.profile.protocol})</span>
                    </div>
                  )}
                  {(sub as any).deviceId && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                      <Smartphone className="w-3 h-3 text-gray-600" />
                      <span className="font-mono">{(sub as any).deviceId}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-lg">
                      {sub.dataToken}
                    </code>
                    <button onClick={() => copyToken(sub.id, sub.dataToken)}
                      className="text-gray-600 hover:text-gray-400 transition-colors">
                      {copied === sub.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                    <span className="flex items-center gap-1">
                      <HardDrive className="w-3 h-3" />
                      {fmtGB(sub.quotaUsed)} / {fmtGB(sub.quotaBytes)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Expire: {new Date(sub.expireAt).toLocaleDateString("fr-FR")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Smartphone className="w-3 h-3" />
                      {sub.deviceLimit} appareil{sub.deviceLimit > 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-1.5 shrink-0">
                    <button onClick={() => openEdit(sub)}
                      className="p-2 rounded-xl text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                      <Edit3 className="w-4 h-4" />
                    </button>
                    {sub.status === "active" && (
                      <button onClick={() => handleRevoke(sub.id, sub.name || "ce forfait")}
                        className="p-2 rounded-xl text-gray-400 hover:text-amber-400 hover:bg-amber-500/10 transition-colors">
                        <ShieldOff className="w-4 h-4" />
                      </button>
                    )}
                    <button onClick={() => handleDelete(sub.id, sub.name || "ce forfait")}
                      className="p-2 rounded-xl text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-[#1a1f2e]">
              <h2 className="font-semibold text-white">
                {editId ? "Modifier le forfait" : "Nouveau forfait data"}
              </h2>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {error && (
                <div className="flex items-center gap-2 px-3 py-2 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Client VPN *</label>
                <select value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} required
                  className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                  <option value="">Selectionner un client...</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {(c as any).user?.name || "Client"}{(c as any).user?.email ? " — " + (c as any).user.email : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Configuration VPN *</label>
                <select value={form.profileId} onChange={(e) => setForm((f) => ({ ...f, profileId: e.target.value }))} required
                  className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                  <option value="">Selectionner une configuration...</option>
                  {profiles.filter((p) => p.status === "active").map((p) => (
                    <option key={p.id} value={p.id}>{p.name} [{String((p as any).sourceType || p.protocol || "")}]</option>
                  ))}
                </select>
              </div>
              {/* Device ID — auto-filled from client, locked to their device */}
              {(() => {
                const sel = clients.find((c) => c.id === form.clientId);
                const hasDeviceId = !!sel?.deviceId;
                return (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5 flex items-center gap-2">
                      <Smartphone className="w-3.5 h-3.5" />
                      Verrou appareil (Device ID)
                      {hasDeviceId && (
                        <span className="ml-auto flex items-center gap-1 text-[10px] text-violet-400 bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 rounded-full">
                          <Lock className="w-2.5 h-2.5" /> Verrouille automatiquement
                        </span>
                      )}
                    </label>
                    {hasDeviceId ? (
                      <div className="flex items-center gap-2 px-3 py-2.5 bg-violet-500/5 border border-violet-500/20 rounded-xl">
                        <Lock className="w-4 h-4 text-violet-400 shrink-0" />
                        <code className="text-sm font-mono text-violet-400 flex-1 truncate">{sel?.deviceId}</code>
                        <span className="text-[10px] text-gray-600">uniquement cet appareil</span>
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={form.deviceId}
                        onChange={(e) => setForm((f) => ({ ...f, deviceId: e.target.value }))}
                        placeholder="Laisser vide pour tous les appareils, ou entrer un Device ID manuellement"
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono placeholder-gray-700 focus:outline-none focus:border-violet-500"
                      />
                    )}
                    {!form.clientId && (
                      <p className="text-xs text-gray-600 mt-1">Selectionnez un client pour verrouiller automatiquement sur son appareil.</p>
                    )}
                    {form.clientId && !hasDeviceId && (
                      <p className="text-xs text-amber-600 mt-1">Ce client n a pas encore de Device ID enregistre. Il sera lie automatiquement a son premier lancement de l app.</p>
                    )}
                  </div>
                );
              })()}
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Nom du forfait</label>
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="SXB Premium 30j" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Quota (GB) *</label>
                  <input type="number" step="0.5" value={form.quotaGB}
                    onChange={(e) => setForm((f) => ({ ...f, quotaGB: e.target.value }))} required
                    placeholder="10" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Duree (jours) *</label>
                  <input type="number" value={form.durationDays}
                    onChange={(e) => setForm((f) => ({ ...f, durationDays: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Appareils</label>
                  <input type="number" value={form.deviceLimit}
                    onChange={(e) => setForm((f) => ({ ...f, deviceLimit: e.target.value }))}
                    min="1" max="10" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">
                  Annuler
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 text-sm font-medium rounded-xl border border-blue-500/20 disabled:opacity-50">
                  {saving ? "..." : editId ? "Enregistrer" : "Creer + Generer token"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

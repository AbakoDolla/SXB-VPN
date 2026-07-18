import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import {
  fetchSubscriptions, createSubscription, updateSubscription,
  deleteSubscription, revokeSubscription, Subscription,
  fetchVpnProfiles, VpnProfile,
} from "../api/vpnProfiles";
import {
  CreditCard, Plus, Trash2, RefreshCw, Edit3, X, AlertTriangle,
  Copy, Check, ShieldOff, Clock, HardDrive, Smartphone,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

function fmtGB(bytes: string | number | null): string {
  if (!bytes) return '0 GB';
  const gb = Number(bytes) / (1024 ** 3);
  return gb.toFixed(2) + ' GB';
}

function statusBadge(s: string) {
  const m: Record<string, string> = {
    active:   'text-emerald-400 bg-emerald-500/10',
    expired:  'text-rose-400 bg-rose-500/10',
    revoked:  'text-red-400 bg-red-500/10',
    suspended:'text-amber-400 bg-amber-500/10',
  };
  return m[s] || 'text-gray-400 bg-gray-500/10';
}

const DEFAULT_FORM = { clientId: '', profileId: '', name: '', quotaGB: '', durationDays: '30', deviceLimit: '1' };

export default function SubscriptionsView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const [subs, setSubs]         = useState<Subscription[]>([]);
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState<string | null>(null);
  const [form, setForm]         = useState({ ...DEFAULT_FORM });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [copied, setCopied]     = useState<string | null>(null);
  const [search, setSearch]     = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([fetchSubscriptions(), fetchVpnProfiles()]);
      setSubs(s); setProfiles(p);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditId(null); setForm({ ...DEFAULT_FORM }); setError(''); setShowForm(true); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.clientId || !form.profileId || !form.quotaGB || !form.durationDays) {
      setError('Client, profil, quota et durée sont requis'); return;
    }
    setSaving(true); setError('');
    try {
      if (editId) {
        await updateSubscription(editId, { ...form, quotaGB: Number(form.quotaGB), durationDays: Number(form.durationDays), deviceLimit: Number(form.deviceLimit) });
      } else {
        await createSubscription({ ...form, quotaGB: Number(form.quotaGB), durationDays: Number(form.durationDays), deviceLimit: Number(form.deviceLimit) });
      }
      setShowForm(false); load();
    } catch (err: any) { setError(err.message || 'Erreur'); }
    finally { setSaving(false); }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!confirm(`Révoquer l'abonnement "${name}" ? L'application mobile sera bloquée.`)) return;
    await revokeSubscription(id, 'Admin révocation manuelle');
    load();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Supprimer définitivement "${name}" ?`)) return;
    await deleteSubscription(id); load();
  };

  const copyToken = (id: string, token: string) => {
    navigator.clipboard.writeText(token);
    setCopied(id); setTimeout(() => setCopied(null), 1500);
  };

  const filtered = subs.filter(s =>
    (s.client?.user?.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (s.name || '').toLowerCase().includes(search.toLowerCase()) ||
    s.dataToken.includes(search.toUpperCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-500/10 rounded-xl">
            <CreditCard className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Abonnements</h1>
            <p className="text-sm text-gray-500">Client ↔ Profil VPN — Tokens DATA générés automatiquement</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-xl text-sm font-medium border border-blue-500/20 transition-colors">
              <Plus className="w-4 h-4" /> Créer abonnement
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher par nom, token ou client..."
        className="w-full px-4 py-2.5 bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />

      {/* Subscription cards */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-500">Chargement...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <CreditCard className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Aucun abonnement</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-blue-400 text-sm">+ Créer un abonnement</button>}
          </div>
        ) : filtered.map(sub => {
          const quotaTotalGB = Number(sub.quotaBytes) / (1024 ** 3);
          const quotaUsedGB  = Number(sub.quotaUsed)  / (1024 ** 3);
          const pct = quotaTotalGB > 0 ? Math.min((quotaUsedGB / quotaTotalGB) * 100, 100) : 0;

          return (
            <div key={sub.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-white font-medium">{sub.name || `Abonnement ${sub.id.slice(-6)}`}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge(sub.status)}`}>
                      {sub.status}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {sub.client?.user?.name || 'Client inconnu'}
                    {sub.profile && <span className="text-gray-600"> · {sub.profile.name}</span>}
                  </p>
                  {/* DATA TOKEN */}
                  <div className="flex items-center gap-2 mt-2 bg-[#07090e] rounded-lg px-3 py-2 w-fit">
                    <code className="text-xs text-amber-400 font-mono">{sub.dataToken}</code>
                    <button onClick={() => copyToken(sub.id, sub.dataToken)}
                      className="text-gray-500 hover:text-white transition-colors ml-1">
                      {copied === sub.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {isAdmin && <>
                    {sub.status === 'active' && (
                      <button onClick={() => handleRevoke(sub.id, sub.name)} title="Révoquer"
                        className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                        <ShieldOff className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => handleDelete(sub.id, sub.name)} title="Supprimer"
                      className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>}
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-3 mt-4 text-xs">
                <div className="bg-[#07090e] rounded-lg p-2.5">
                  <p className="text-gray-500 flex items-center gap-1 mb-0.5"><HardDrive className="w-3 h-3" />Quota</p>
                  <p className="text-white">{fmtGB(sub.quotaUsed)} / {fmtGB(sub.quotaBytes)}</p>
                </div>
                <div className="bg-[#07090e] rounded-lg p-2.5">
                  <p className="text-gray-500 flex items-center gap-1 mb-0.5"><Clock className="w-3 h-3" />Expiration</p>
                  <p className="text-white">{sub.expireAt ? new Date(sub.expireAt).toLocaleDateString('fr') : '∞'}</p>
                </div>
                <div className="bg-[#07090e] rounded-lg p-2.5">
                  <p className="text-gray-500 flex items-center gap-1 mb-0.5"><Smartphone className="w-3 h-3" />Appareils</p>
                  <p className="text-white">{sub.deviceLimit} max</p>
                </div>
              </div>

              {/* Quota bar */}
              {quotaTotalGB > 0 && (
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Consommation</span>
                    <span>{pct.toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 bg-[#1a1f2e] rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${pct > 85 ? 'bg-rose-500' : pct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Create Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold">Créer un abonnement</h2>
              <button onClick={() => setShowForm(false)} className="p-1.5 text-gray-400 hover:text-white rounded-lg"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-3 text-xs text-blue-400">
                Un token <strong>SXB-DATA-XXXX</strong> sera généré automatiquement et lié à cet abonnement.
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1.5">ID Client VPN *</label>
                <input value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} required
                  placeholder="UUID du client VPN" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Profil VPN *</label>
                <select value={form.profileId} onChange={e => setForm(f => ({ ...f, profileId: e.target.value }))} required
                  className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500">
                  <option value="">Sélectionner un profil...</option>
                  {profiles.filter(p => p.status === 'active').map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.protocol.toUpperCase()})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Nom personnalisé</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="SXB Premium 30j" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Quota (GB) *</label>
                  <input type="number" step="0.5" value={form.quotaGB} onChange={e => setForm(f => ({ ...f, quotaGB: e.target.value }))} required
                    placeholder="10" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Durée (jours) *</label>
                  <input type="number" value={form.durationDays} onChange={e => setForm(f => ({ ...f, durationDays: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Appareils</label>
                  <input type="number" value={form.deviceLimit} onChange={e => setForm(f => ({ ...f, deviceLimit: e.target.value }))}
                    min="1" max="10" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">Annuler</button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 text-sm font-medium rounded-xl border border-blue-500/20 disabled:opacity-50">
                  {saving ? '...' : 'Créer + Générer token'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

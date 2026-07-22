import React, { useEffect, useState, useMemo } from 'react';
import { UserRole } from '../types';
import {
  fetchSubscriptions, fetchSubStats, createSubscription,
  updateSubscription, deleteSubscription, revokeSubscription,
  Subscription,
} from '../api/subscriptions';
import { fetchVpnProfiles, VpnProfile } from '../api/vpn-profiles';
import { fetchClients } from '../api/clients';
import { Client } from '../types';
import {
  PackageOpen, Plus, Trash2, RefreshCw, ShieldOff, Search,
  Calendar, HardDrive, Cpu, X, AlertTriangle, CheckCircle,
  Clock, Edit3, ChevronDown,
} from 'lucide-react';
import Pagination from './ui/Pagination';
import { toast } from 'sonner';

interface Props { currentUserRole: UserRole }

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  active:    { label: 'Actif',    cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  expired:   { label: 'Expiré',  cls: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  revoked:   { label: 'Révoqué', cls: 'text-rose-400 bg-rose-500/10 border-rose-500/20' },
  suspended: { label: 'Suspendu', cls: 'text-gray-400 bg-gray-500/10 border-gray-500/20' },
};

function fmtBytes(n: number) {
  if (!n) return '0 Go';
  const gb = n / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} Go` : `${(n / (1024 ** 2)).toFixed(0)} Mo`;
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

const DEFAULT_FORM = {
  clientId: '', profileId: '', name: '', quotaGB: 5, durationDays: 30, deviceLimit: 1,
};

export default function SubscriptionsView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.SUPER_ADMIN || currentUserRole === UserRole.ADMIN;

  const [subs, setSubs] = useState<Subscription[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, expired: 0 });
  const [clients, setClients] = useState<Client[]>([]);
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [editSub, setEditSub] = useState<Subscription | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [s, st, cl, pr] = await Promise.all([
        fetchSubscriptions(),
        fetchSubStats(),
        fetchClients(),
        fetchVpnProfiles(),
      ]);
      setSubs(s);
      setStats(st);
      setClients(cl);
      setProfiles(pr);
    } catch (err: any) {
      toast.error(err?.message || 'Erreur de chargement');
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Filter + pagination
  const filtered = useMemo(() => subs.filter(s => {
    const clientName = s.client?.user?.name || s.client?.token || '';
    const matchSearch = search === '' ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.dataToken.toLowerCase().includes(search.toLowerCase()) ||
      clientName.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || s.status === statusFilter;
    return matchSearch && matchStatus;
  }), [subs, search, statusFilter]);

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  // Reset page when filter changes
  useEffect(() => setPage(1), [search, statusFilter]);

  const openCreate = () => {
    setEditSub(null);
    setForm({ ...DEFAULT_FORM });
    setFormError('');
    setShowModal(true);
  };

  const openEdit = (sub: Subscription) => {
    setEditSub(sub);
    setForm({
      clientId: sub.clientId,
      profileId: sub.profileId,
      name: sub.name,
      quotaGB: sub.quotaBytes ? Math.round(sub.quotaBytes / (1024 ** 3)) : 5,
      durationDays: sub.durationDays,
      deviceLimit: sub.deviceLimit,
    });
    setFormError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.clientId || !form.profileId) { setFormError('Client et profil VPN sont requis'); return; }
    setSaving(true); setFormError('');
    try {
      if (editSub) {
        await updateSubscription(editSub.id, {
          name: form.name || undefined,
          quotaGB: form.quotaGB,
          durationDays: form.durationDays,
          deviceLimit: form.deviceLimit,
        });
        toast.success('Forfait mis à jour');
      } else {
        await createSubscription(form);
        toast.success('Forfait créé avec succès');
      }
      setShowModal(false);
      await load();
    } catch (err: any) {
      setFormError(err?.message || 'Erreur lors de la sauvegarde');
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Supprimer le forfait "${name}" ? Cette action est irréversible.`)) return;
    try {
      await deleteSubscription(id);
      toast.success('Forfait supprimé');
      await load();
    } catch (err: any) { toast.error(err?.message || 'Erreur lors de la suppression'); }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!window.confirm(`Révoquer le forfait "${name}" ? Le client perdra accès au VPN.`)) return;
    try {
      await revokeSubscription(id, 'Révoqué par admin');
      toast.success('Forfait révoqué');
      await load();
    } catch (err: any) { toast.error(err?.message || 'Erreur lors de la révocation'); }
  };

  // Export CSV
  const exportCSV = () => {
    const rows = [
      ['Nom', 'Client', 'Profil', 'Quota', 'Utilisé', 'Durée', 'Expiration', 'Statut', 'Token'],
      ...filtered.map(s => [
        s.name,
        s.client?.user?.name || s.clientId,
        s.profile?.name || s.profileId,
        fmtBytes(s.quotaBytes),
        fmtBytes(s.quotaUsed),
        `${s.durationDays}j`,
        fmtDate(s.expireAt),
        s.status,
        s.dataToken,
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'forfaits.csv'; a.click();
    URL.revokeObjectURL(url);
    toast.success('Export CSV téléchargé');
  };

  const clientMap = useMemo(() => Object.fromEntries(clients.map(c => [c.id, c])), [clients]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <PackageOpen className="w-6 h-6 text-cyan-400" />
            Forfaits Data
          </h1>
          <p className="text-sm text-gray-400 mt-1">Gestion des abonnements VPN par client</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-400 bg-[#0f1218] border border-[#1a1f2e] rounded-lg hover:text-white hover:border-[#252b3b] transition-all cursor-pointer">
            Export CSV
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg transition-all cursor-pointer">
              <Plus className="w-4 h-4" /> Nouveau forfait
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: 'Total', value: stats.total, icon: PackageOpen, color: 'text-white' },
          { label: 'Actifs', value: stats.active, icon: CheckCircle, color: 'text-emerald-400' },
          { label: 'Expirés', value: stats.expired, icon: Clock, color: 'text-amber-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <Icon className={`w-4 h-4 ${color}`} />
              <p className="text-xs text-gray-500">{label}</p>
            </div>
            <p className={`text-2xl font-bold ${color}`}>{loading ? '—' : value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher par nom, client, token…"
            className="w-full pl-9 pr-4 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {['all', 'active', 'expired', 'revoked', 'suspended'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border capitalize transition-all cursor-pointer ${
                statusFilter === s
                  ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400'
                  : 'bg-[#0a0d14] border-[#1a1f2e] text-gray-500 hover:text-gray-200'
              }`}>
              {s === 'all' ? 'Tous' : STATUS_CFG[s]?.label || s}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" />
            Chargement…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <PackageOpen className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">Aucun forfait trouvé</p>
            {isAdmin && (
              <button onClick={openCreate} className="mt-3 text-cyan-400 hover:text-cyan-300 text-sm cursor-pointer">
                + Créer le premier forfait
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1f2e] bg-[#0a0d14]">
                    {['Nom', 'Client', 'Profil VPN', 'Quota', 'Durée', 'Expiration', 'Statut', ''].map(h => (
                      <th key={h} className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1f2e]">
                  {paginated.map(sub => {
                    const pct = sub.quotaBytes > 0 ? Math.min(100, (sub.quotaUsed / sub.quotaBytes) * 100) : 0;
                    const cfg = STATUS_CFG[sub.status] || STATUS_CFG.active;
                    const client = clientMap[sub.clientId];
                    return (
                      <tr key={sub.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-3">
                          <p className="text-white font-medium">{sub.name}</p>
                          <p className="text-xs text-gray-600 font-mono">{sub.dataToken}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm text-gray-300">{sub.client?.user?.name || client?.user?.name || '—'}</p>
                          <p className="text-xs text-gray-600">{sub.client?.user?.email || '—'}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs text-gray-400">{sub.profile?.name || '—'}</span>
                          {sub.profile?.protocol && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 uppercase">{sub.profile.protocol}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="space-y-1 min-w-[100px]">
                            <div className="flex justify-between text-[11px] text-gray-500">
                              <span>{fmtBytes(sub.quotaUsed)}</span>
                              <span>{fmtBytes(sub.quotaBytes)}</span>
                            </div>
                            <div className="w-full h-1 bg-[#1a1f2e] rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${pct > 90 ? 'bg-rose-500' : pct > 70 ? 'bg-amber-500' : 'bg-cyan-500'}`}
                                style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">{sub.durationDays}j</td>
                        <td className="px-4 py-3 text-xs text-gray-400 font-mono">{fmtDate(sub.expireAt)}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.cls}`}>
                            {cfg.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {isAdmin && (
                            <div className="flex items-center gap-1">
                              <button onClick={() => openEdit(sub)} title="Modifier"
                                className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer">
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              {sub.status === 'active' && (
                                <button onClick={() => handleRevoke(sub.id, sub.name)} title="Révoquer"
                                  className="p-1.5 text-gray-500 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors cursor-pointer">
                                  <ShieldOff className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button onClick={() => handleDelete(sub.id, sub.name)} title="Supprimer"
                                className="p-1.5 text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#1a1f2e] px-4">
              <Pagination page={page} pageSize={pageSize} total={filtered.length}
                onPageChange={setPage} onPageSizeChange={p => { setPageSize(p); setPage(1); }} />
            </div>
          </>
        )}
      </div>

      {/* Create / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-[#0f1218] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold flex items-center gap-2">
                <PackageOpen className="w-4 h-4 text-cyan-400" />
                {editSub ? 'Modifier le forfait' : 'Nouveau forfait'}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 text-gray-500 hover:text-white rounded-lg cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {formError}
                </div>
              )}

              {!editSub && (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Client VPN *</label>
                    <div className="relative">
                      <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} required
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 appearance-none cursor-pointer">
                        <option value="">Sélectionner un client…</option>
                        {clients.map(c => (
                          <option key={c.id} value={c.id}>{(c as any).user?.name || c.id}</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Profil VPN *</label>
                    <div className="relative">
                      <select value={form.profileId} onChange={e => setForm(f => ({ ...f, profileId: e.target.value }))} required
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 appearance-none cursor-pointer">
                        <option value="">Sélectionner un profil…</option>
                        {profiles.filter(p => p.status === 'active').map(p => (
                          <option key={p.id} value={p.id}>{p.name} ({p.protocol})</option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Nom (optionnel)</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Auto-généré si vide"
                  className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Quota (Go) *</label>
                  <input type="number" min={0.5} step={0.5} value={form.quotaGB}
                    onChange={e => setForm(f => ({ ...f, quotaGB: Number(e.target.value) }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Durée (jours)</label>
                  <input type="number" min={1} value={form.durationDays}
                    onChange={e => setForm(f => ({ ...f, durationDays: Number(e.target.value) }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Appareils</label>
                  <input type="number" min={1} max={10} value={form.deviceLimit}
                    onChange={e => setForm(f => ({ ...f, deviceLimit: Number(e.target.value) }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500" />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-4 border-t border-[#1a1f2e]">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 bg-[#0a0d14] border border-[#1a1f2e] rounded-xl hover:text-white transition-all cursor-pointer">
                  Annuler
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 text-sm font-semibold bg-cyan-500 hover:bg-cyan-400 text-black rounded-xl transition-all disabled:opacity-60 cursor-pointer flex items-center gap-2">
                  {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  {editSub ? 'Mettre à jour' : 'Créer le forfait'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

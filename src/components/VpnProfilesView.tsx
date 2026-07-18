import React, { useEffect, useState } from "react";
import { UserRole } from "../types";
import {
  fetchVpnProfiles, createVpnProfile, updateVpnProfile, deleteVpnProfile,
  fetchVpnProfileStats, VpnProfile,
} from "../api/vpnProfiles";
import {
  ShieldCheck, Plus, Trash2, RefreshCw, Edit3, X, AlertTriangle,
  Check, Wifi, Activity, Lock, Globe,
} from "lucide-react";

interface Props { currentUserRole: UserRole }

const PROTO_COLORS: Record<string, string> = {
  ssh:          "text-cyan-400 bg-cyan-500/10",
  vless:        "text-blue-400 bg-blue-500/10",
  vmess:        "text-indigo-400 bg-indigo-500/10",
  trojan:       "text-amber-400 bg-amber-500/10",
  shadowsocks:  "text-purple-400 bg-purple-500/10",
  singbox:      "text-pink-400 bg-pink-500/10",
};

const PROTOCOLS = ['ssh', 'vless', 'vmess', 'trojan', 'shadowsocks', 'singbox'];
const NETWORKS  = ['ws', 'grpc', 'tcp', 'h2'];

const DEFAULT_FORM = {
  name: '', description: '', protocol: 'ssh',
  host: '', port: '', username: '', password: '',
  uuid: '', path: '/', network: 'ws', tls: false, sni: '', dns: '1.1.1.1',
  offlineValidDays: 7, method: 'aes-256-gcm', status: 'active',
};

export default function VpnProfilesView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.ADMIN || currentUserRole === UserRole.SUPER_ADMIN;
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [stats, setStats]       = useState({ total: 0, active: 0, byProtocol: [] as any[] });
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState<string | null>(null);
  const [form, setForm]         = useState({ ...DEFAULT_FORM });
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [filterProto, setFilterProto] = useState('all');
  const [search, setSearch]     = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [profs, st] = await Promise.all([fetchVpnProfiles(), fetchVpnProfileStats()]);
      setProfiles(profs);
      setStats(st);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditId(null); setForm({ ...DEFAULT_FORM }); setError(''); setShowForm(true);
  };

  const openEdit = (p: VpnProfile) => {
    setEditId(p.id);
    setForm({
      name: p.name, description: p.description || '', protocol: p.protocol,
      host: p.host, port: String(p.port), username: p.username || '', password: '',
      uuid: p.uuid || '', path: p.path || '/', network: p.network, tls: p.tls,
      sni: p.sni || '', dns: p.dns || '1.1.1.1',
      offlineValidDays: p.offlineValidDays, method: p.method || 'aes-256-gcm', status: p.status,
    });
    setError(''); setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.host || !form.port) { setError('Nom, hôte et port sont requis'); return; }
    setSaving(true); setError('');
    try {
      const data = { ...form, port: Number(form.port), offlineValidDays: Number(form.offlineValidDays) };
      if (editId) await updateVpnProfile(editId, data);
      else await createVpnProfile(data);
      setShowForm(false); load();
    } catch (err: any) { setError(err.message || 'Erreur'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string, count: number) => {
    if (count > 0) { alert(`Impossible — ${count} abonnement(s) actif(s)`); return; }
    if (!confirm(`Supprimer le profil "${name}" ?`)) return;
    await deleteVpnProfile(id); load();
  };

  const filtered = profiles.filter(p =>
    (filterProto === 'all' || p.protocol === filterProto) &&
    (p.name.toLowerCase().includes(search.toLowerCase()) || p.host.includes(search))
  );

  const f = (k: keyof typeof form, v: any) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 rounded-xl">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Profils VPN</h1>
            <p className="text-sm text-gray-500">Templates de configuration — Offline-First VPN</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="p-2 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-xl text-sm font-medium border border-emerald-500/20 transition-colors">
              <Plus className="w-4 h-4" /> Nouveau profil
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total profils', value: stats.total,  color: 'text-white' },
          { label: 'Actifs',        value: stats.active, color: 'text-emerald-400' },
          ...stats.byProtocol.slice(0, 2).map((b: any) => ({
            label: b.protocol.toUpperCase(), value: b._count.id,
            color: (PROTO_COLORS[b.protocol] || 'text-gray-400').split(' ')[0],
          })),
        ].map(s => (
          <div key={s.label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{s.label}</p>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 flex-wrap">
          {['all', ...PROTOCOLS].map(p => (
            <button key={p} onClick={() => setFilterProto(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                filterProto === p
                  ? (p === 'all' ? 'bg-white/10 text-white' : `${PROTO_COLORS[p]} border border-current/20`)
                  : 'text-gray-500 hover:text-gray-300'
              }`}>{p === 'all' ? 'Tous' : p}</button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher..."
          className="px-3 py-1.5 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 sm:ml-auto" />
      </div>

      {/* Profile Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-3 text-center py-12 text-gray-500">Chargement...</div>
        ) : filtered.length === 0 ? (
          <div className="col-span-3 text-center py-12 text-gray-500">
            <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Aucun profil VPN configuré</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-emerald-400 hover:text-emerald-300 text-sm">+ Créer un profil</button>}
          </div>
        ) : filtered.map(p => (
          <div key={p.id} className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <h3 className="text-white font-semibold truncate">{p.name}</h3>
                {p.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{p.description}</p>}
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium ${PROTO_COLORS[p.protocol] || 'text-gray-400 bg-gray-500/10'}`}>
                    {p.protocol}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${p.status === 'active' ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-400 bg-gray-500/10'}`}>
                    {p.status}
                  </span>
                  {p.tls && <span className="text-xs px-2 py-0.5 rounded-full text-cyan-400 bg-cyan-500/10">TLS</span>}
                  {p._count && p._count.subscriptions > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full text-amber-400 bg-amber-500/10">
                      {p._count.subscriptions} abonnement(s)
                    </span>
                  )}
                </div>
              </div>
              {isAdmin && (
                <div className="flex gap-1 ml-2 shrink-0">
                  <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(p.id, p.name, p._count?.subscriptions || 0)}
                    className="p-1.5 text-gray-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Globe className="w-3 h-3" />Serveur</p>
                <p className="text-white font-mono truncate">{p.host}:{p.port}</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Wifi className="w-3 h-3" />Network</p>
                <p className="text-white">{p.network}{p.path ? ` ${p.path}` : ''}</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Activity className="w-3 h-3" />Offline</p>
                <p className="text-white">{p.offlineValidDays}j valide</p>
              </div>
              <div className="bg-[#07090e] rounded-lg p-2.5">
                <p className="text-gray-500 mb-0.5 flex items-center gap-1"><Lock className="w-3 h-3" />Chiffrement</p>
                <p className="text-emerald-400">AES-256-CBC</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-[#1a1f2e]">
              <h2 className="text-white font-semibold">{editId ? 'Modifier' : 'Nouveau'} Profil VPN</h2>
              <button onClick={() => setShowForm(false)} className="p-1.5 text-gray-400 hover:text-white rounded-lg"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-5">
              {error && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Nom du profil *</label>
                  <input value={form.name} onChange={e => f('name', e.target.value)} required
                    placeholder="MTN SSH Premium" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-gray-400 mb-1.5">Description</label>
                  <input value={form.description} onChange={e => f('description', e.target.value)}
                    placeholder="Profil premium pour réseaux MTN" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Protocole *</label>
                  <select value={form.protocol} onChange={e => f('protocol', e.target.value)}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500">
                    {PROTOCOLS.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Statut</label>
                  <select value={form.status} onChange={e => f('status', e.target.value)}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500">
                    <option value="active">Actif</option>
                    <option value="inactive">Inactif</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Hôte *</label>
                  <input value={form.host} onChange={e => f('host', e.target.value)} required
                    placeholder="141.95.112.93" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Port *</label>
                  <input type="number" value={form.port} onChange={e => f('port', e.target.value)} required
                    placeholder="22" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>

                {form.protocol === 'ssh' && <>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Utilisateur SSH</label>
                    <input value={form.username} onChange={e => f('username', e.target.value)}
                      placeholder="ubuntu" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Mot de passe SSH</label>
                    <input type="password" value={form.password} onChange={e => f('password', e.target.value)}
                      placeholder={editId ? 'Laisser vide pour conserver' : '••••••••'}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                  </div>
                </>}

                {['vless', 'vmess'].includes(form.protocol) && (
                  <div className="col-span-2">
                    <label className="block text-sm text-gray-400 mb-1.5">UUID</label>
                    <input value={form.uuid} onChange={e => f('uuid', e.target.value)}
                      placeholder="Laissez vide pour générer automatiquement"
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-emerald-500" />
                  </div>
                )}

                {['trojan', 'shadowsocks'].includes(form.protocol) && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Mot de passe</label>
                    <input type="password" value={form.password} onChange={e => f('password', e.target.value)}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                  </div>
                )}

                {form.protocol !== 'ssh' && (
                  <div>
                    <label className="block text-sm text-gray-400 mb-1.5">Network</label>
                    <select value={form.network} onChange={e => f('network', e.target.value)}
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500">
                      {NETWORKS.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">SNI</label>
                  <input value={form.sni} onChange={e => f('sni', e.target.value)}
                    placeholder="example.com" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">DNS</label>
                  <input value={form.dns} onChange={e => f('dns', e.target.value)}
                    placeholder="1.1.1.1" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Path</label>
                  <input value={form.path} onChange={e => f('path', e.target.value)}
                    placeholder="/" className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1.5">Validité offline (jours)</label>
                  <input type="number" value={form.offlineValidDays} onChange={e => f('offlineValidDays', Number(e.target.value))}
                    min={1} max={30} className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-emerald-500" />
                </div>
              </div>

              <div>
                <button type="button" onClick={() => f('tls', !form.tls)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm border transition-colors ${form.tls ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400' : 'bg-transparent border-[#1a1f2e] text-gray-500'}`}>
                  {form.tls ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />} TLS/SSL
                </button>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm rounded-xl hover:bg-white/5">Annuler</button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 text-sm font-medium rounded-xl border border-emerald-500/20 disabled:opacity-50">
                  {saving ? '...' : editId ? 'Mettre à jour' : 'Créer le profil'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState, useMemo } from 'react';
import { UserRole } from '../types';
import { fetchVpnProfiles, createVpnProfile, updateVpnProfile, deleteVpnProfile, VpnProfile } from '../api/vpn-profiles';
import { Network, Plus, Trash2, RefreshCw, Edit3, Search, X, AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import Pagination from './ui/Pagination';
import { toast } from 'sonner';

interface Props { currentUserRole: UserRole }

const PROTO_COLORS: Record<string, string> = {
  ssh: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  vless: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  vmess: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
  trojan: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  shadowsocks: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
  singbox: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  hysteria2: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
  tuic: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
};

const PROTOCOLS = ['ssh', 'vless', 'vmess', 'trojan', 'shadowsocks', 'singbox', 'hysteria2', 'tuic', 'wireguard', 'reality'];

const DEFAULT_FORM = {
  name: '', description: '', protocol: 'vless', host: '', port: 443,
  username: '', password: '', uuid: '', path: '/', network: 'ws',
  tls: true, sni: '', method: '', offlineValidDays: 7,
};

export default function VpnProfilesView({ currentUserRole }: Props) {
  const isAdmin = currentUserRole === UserRole.SUPER_ADMIN || currentUserRole === UserRole.ADMIN;

  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [protoFilter, setProtoFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [showModal, setShowModal] = useState(false);
  const [editProfile, setEditProfile] = useState<VpnProfile | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchVpnProfiles();
      setProfiles(data);
    } catch (err: any) { toast.error(err?.message || 'Erreur de chargement'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const allProtocols = useMemo(() => [...new Set(profiles.map(p => p.protocol))], [profiles]);

  const filtered = useMemo(() => profiles.filter(p => {
    const matchSearch = search === '' || p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.host.toLowerCase().includes(search.toLowerCase());
    const matchProto = protoFilter === 'all' || p.protocol === protoFilter;
    return matchSearch && matchProto;
  }), [profiles, search, protoFilter]);

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

  useEffect(() => setPage(1), [search, protoFilter]);

  const openCreate = () => {
    setEditProfile(null);
    setForm({ ...DEFAULT_FORM });
    setFormError('');
    setShowModal(true);
  };

  const openEdit = (p: VpnProfile) => {
    setEditProfile(p);
    setForm({
      name: p.name, description: p.description || '',
      protocol: p.protocol, host: p.host, port: p.port,
      username: p.username || '', password: '',
      uuid: p.uuid || '', path: p.path || '/',
      network: p.network || 'ws', tls: p.tls,
      sni: p.sni || '', method: p.method || '',
      offlineValidDays: p.offlineValidDays || 7,
    });
    setFormError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.host) { setFormError('Nom et hôte sont requis'); return; }
    setSaving(true); setFormError('');
    try {
      const payload: any = { ...form };
      if (!payload.password) delete payload.password;
      if (editProfile) {
        await updateVpnProfile(editProfile.id, payload);
        toast.success('Profil VPN mis à jour');
      } else {
        await createVpnProfile(payload);
        toast.success('Profil VPN créé');
      }
      setShowModal(false);
      await load();
    } catch (err: any) { setFormError(err?.message || 'Erreur'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Supprimer le profil "${name}" ?`)) return;
    try {
      await deleteVpnProfile(id);
      toast.success('Profil supprimé');
      await load();
    } catch (err: any) { toast.error(err?.message || 'Erreur de suppression'); }
  };

  const active = profiles.filter(p => p.status === 'active').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Network className="w-6 h-6 text-violet-400" /> Profils VPN
          </h1>
          <p className="text-sm text-gray-400 mt-1">Templates de configuration VPN réutilisables</p>
        </div>
        {isAdmin && (
          <button onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 text-white font-medium text-sm rounded-lg transition-all cursor-pointer">
            <Plus className="w-4 h-4" /> Nouveau profil
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Total</p>
          <p className="text-2xl font-bold text-white">{profiles.length}</p>
        </div>
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1 flex items-center gap-1"><CheckCircle className="w-3 h-3 text-emerald-400" /> Actifs</p>
          <p className="text-2xl font-bold text-emerald-400">{active}</p>
        </div>
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1 flex items-center gap-1"><Clock className="w-3 h-3 text-gray-400" /> Inactifs</p>
          <p className="text-2xl font-bold text-gray-400">{profiles.length - active}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher par nom, hôte…"
            className="w-full pl-9 pr-4 py-2 text-sm bg-[#0a0d14] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 focus:outline-none focus:border-violet-500" />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {['all', ...allProtocols].map(p => (
            <button key={p} onClick={() => setProtoFilter(p)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border capitalize transition-all cursor-pointer ${
                protoFilter === p
                  ? 'bg-violet-500/15 border-violet-500/30 text-violet-400'
                  : 'bg-[#0a0d14] border-[#1a1f2e] text-gray-500 hover:text-gray-200'
              }`}>
              {p === 'all' ? 'Tous' : p}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-gray-400">
            <RefreshCw className="w-5 h-5 animate-spin text-violet-400" /> Chargement…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Network className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">Aucun profil VPN</p>
            {isAdmin && <button onClick={openCreate} className="mt-3 text-violet-400 hover:text-violet-300 text-sm cursor-pointer">+ Créer le premier profil</button>}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1f2e] bg-[#0a0d14]">
                    {['Nom', 'Protocole', 'Serveur', 'Network/TLS', 'Abonnements', 'Statut', ''].map(h => (
                      <th key={h} className="text-left text-xs text-gray-500 font-semibold uppercase tracking-wider px-4 py-3">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1f2e]">
                  {paginated.map(p => (
                    <tr key={p.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3">
                        <p className="text-white font-medium">{p.name}</p>
                        {p.description && <p className="text-xs text-gray-600 truncate max-w-[200px]">{p.description}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium uppercase ${PROTO_COLORS[p.protocol] || 'text-gray-400 bg-gray-500/10 border-gray-500/20'}`}>
                          {p.protocol}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs font-mono text-gray-300">{p.host}:{p.port}</p>
                        {p.sni && <p className="text-xs text-gray-600">SNI: {p.sni}</p>}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        <span>{p.network || 'tcp'}</span>
                        {p.tls && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[10px]">TLS</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-gray-300">{p._count?.subscriptions ?? 0}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${p.status === 'active' ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-500 bg-gray-500/10'}`}>
                          {p.status === 'active' ? 'Actif' : 'Inactif'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin && (
                          <div className="flex items-center gap-1">
                            <button onClick={() => openEdit(p)} className="p-1.5 text-gray-500 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer">
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleDelete(p.id, p.name)} className="p-1.5 text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
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

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[#0f1218] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e] sticky top-0 bg-[#0f1218] z-10">
              <h2 className="text-white font-semibold flex items-center gap-2">
                <Network className="w-4 h-4 text-violet-400" />
                {editProfile ? 'Modifier le profil' : 'Nouveau profil VPN'}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 text-gray-500 hover:text-white rounded-lg cursor-pointer"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {formError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Nom *</label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Description</label>
                  <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                    placeholder="Description optionnelle"
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Protocole *</label>
                  <select value={form.protocol} onChange={e => setForm(f => ({ ...f, protocol: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500 cursor-pointer">
                    {PROTOCOLS.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Network</label>
                  <select value={form.network} onChange={e => setForm(f => ({ ...f, network: e.target.value }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500 cursor-pointer">
                    {['ws', 'grpc', 'tcp', 'h2', 'quic', 'kcp'].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Hôte *</label>
                  <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} required
                    placeholder="vpn.example.com"
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Port *</label>
                  <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: Number(e.target.value) }))} required
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Path</label>
                  <input value={form.path} onChange={e => setForm(f => ({ ...f, path: e.target.value }))}
                    placeholder="/"
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">SNI</label>
                  <input value={form.sni} onChange={e => setForm(f => ({ ...f, sni: e.target.value }))}
                    placeholder="example.com"
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
                {(form.protocol === 'vless' || form.protocol === 'vmess') && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">UUID</label>
                    <input value={form.uuid} onChange={e => setForm(f => ({ ...f, uuid: e.target.value }))}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm font-mono focus:outline-none focus:border-violet-500" />
                  </div>
                )}
                {(form.protocol === 'ssh' || form.protocol === 'trojan' || form.protocol === 'shadowsocks') && (
                  <>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Utilisateur</label>
                      <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">
                        Mot de passe {editProfile && <span className="text-gray-600">(laisser vide = inchangé)</span>}
                      </label>
                      <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                        className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                    </div>
                  </>
                )}
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.tls} onChange={e => setForm(f => ({ ...f, tls: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-700 text-violet-500 focus:ring-violet-500/30" />
                    <span className="text-sm text-gray-300">TLS activé</span>
                  </label>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider font-semibold">Validité hors-ligne (jours)</label>
                  <input type="number" min={1} max={90} value={form.offlineValidDays}
                    onChange={e => setForm(f => ({ ...f, offlineValidDays: Number(e.target.value) }))}
                    className="w-full px-3 py-2.5 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-violet-500" />
                </div>
              </div>

              <div className="flex gap-2 justify-end pt-4 border-t border-[#1a1f2e]">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-400 bg-[#0a0d14] border border-[#1a1f2e] rounded-xl hover:text-white transition-all cursor-pointer">
                  Annuler
                </button>
                <button type="submit" disabled={saving}
                  className="px-5 py-2 text-sm font-semibold bg-violet-500 hover:bg-violet-400 text-white rounded-xl transition-all disabled:opacity-60 cursor-pointer flex items-center gap-2">
                  {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  {editProfile ? 'Mettre à jour' : 'Créer le profil'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

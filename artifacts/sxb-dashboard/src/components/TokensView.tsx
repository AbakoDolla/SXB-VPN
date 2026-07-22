import React, { useEffect, useState } from 'react';
import { useTranslation } from '../contexts/I18nContext';
import { fetchTokens, createToken, revokeToken } from '../api/tokens';
import { fetchClients } from '../api/clients';
import { TokenSXB, Client, UserRole } from '../types';
import { Key, Plus, RefreshCw, Copy, Check, Ban, Search, X, ChevronDown } from 'lucide-react';

interface TokensViewProps {
  currentUserRole: UserRole;
}

const STATUS_CONFIG = {
  active:  { label: 'Actif',   cls: 'text-emerald-400 bg-emerald-500/10' },
  used:    { label: 'Utilisé', cls: 'text-blue-400 bg-blue-500/10' },
  expired: { label: 'Expiré',  cls: 'text-amber-400 bg-amber-500/10' },
  revoked: { label: 'Révoqué', cls: 'text-rose-400 bg-rose-500/10' },
};

function bytesToGb(bytes: string | number | null): string {
  if (!bytes) return '0 Go';
  const n = typeof bytes === 'string' ? parseFloat(bytes) : bytes;
  if (isNaN(n)) return '0 Go';
  return `${(n / (1024 ** 3)).toFixed(1)} Go`;
}

export default function TokensView({ currentUserRole }: TokensViewProps) {
  const { t } = useTranslation();
  const [tokens, setTokens]   = useState<TokenSXB[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Form
  const [clientId, setClientId]       = useState('');
  const [quotaGb, setQuotaGb]         = useState(50);
  const [durationDays, setDurationDays] = useState(30);
  const [deviceLimit, setDeviceLimit]   = useState(1);
  const [formError, setFormError]       = useState('');
  const [submitting, setSubmitting]     = useState(false);

  const isSupport = currentUserRole === UserRole.SUPPORT;

  // ── Load ──────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true);
    try {
      const [toks, cls] = await Promise.all([fetchTokens(), fetchClients()]);
      setTokens(toks);
      setClients(cls);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ── Create ────────────────────────────────────────────────────
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId) { setFormError('Veuillez sélectionner un client'); return; }
    setFormError('');
    setSubmitting(true);
    try {
      await createToken({ clientId, quotaGb, durationDays, deviceLimit });
      setClientId(''); setQuotaGb(50); setDurationDays(30); setDeviceLimit(1);
      setShowModal(false);
      await load();
    } catch (err: any) {
      setFormError(err?.message || 'Erreur lors de la création');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Revoke ────────────────────────────────────────────────────
  const handleRevoke = async (id: string) => {
    if (isSupport) return;
    if (!confirm('Révoquer ce token ? L\'appareil associé perdra son accès VPN.')) return;
    try {
      await revokeToken(id);
      await load();
    } catch (err: any) {
      alert(err?.message || 'Erreur lors de la révocation');
    }
  };

  // ── Copy ──────────────────────────────────────────────────────
  const copy = (id: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  // ── Filter ────────────────────────────────────────────────────
  const clientMap = Object.fromEntries(clients.map(c => [c.id, c]));

  const filtered = tokens.filter((tok) => {
    const clientName = clientMap[tok.clientId]?.user?.name || tok.clientId;
    return (
      tok.token.toLowerCase().includes(search.toLowerCase()) ||
      clientName.toLowerCase().includes(search.toLowerCase())
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            {t('sidebar.tokens') || 'Tokens SXB'}
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Tokens d'activation VPN (<code className="text-cyan-400 text-xs">SXB-DATA-XXXX-XXXX-XXXX</code>)
          </p>
        </div>
        {!isSupport && (
          <button
            onClick={() => { setShowModal(true); setFormError(''); }}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg transition-all"
          >
            <Plus className="h-4 w-4" />
            Générer un Token SXB
          </button>
        )}
      </div>

      {/* Search */}
      <div className="relative w-full md:w-80">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher par token ou client..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm bg-gray-900/60 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <RefreshCw className="h-6 w-6 animate-spin text-cyan-400 mr-3" />
          Chargement...
        </div>
      ) : (
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1a1f2e]">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Token</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Client</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Quota</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Expiration</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Statut</th>
                  {!isSupport && (
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-16">
                      <Key className="w-8 h-8 text-gray-700 mx-auto mb-3" />
                      <p className="text-gray-500">Aucun token trouvé</p>
                      {!isSupport && (
                        <button
                          onClick={() => setShowModal(true)}
                          className="mt-3 text-cyan-400 hover:text-cyan-300 text-sm"
                        >
                          + Générer le premier token
                        </button>
                      )}
                    </td>
                  </tr>
                )}
                {filtered.map((tok) => {
                  const client = clientMap[tok.clientId];
                  const clientName = client?.user?.name || 'Client inconnu';
                  const st = tok.status as keyof typeof STATUS_CONFIG;
                  const cfg = STATUS_CONFIG[st] || STATUS_CONFIG.active;
                  return (
                    <tr key={tok.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Key className="w-4 h-4 text-cyan-500 shrink-0" />
                          <code className="text-xs text-cyan-300 font-mono">{tok.token}</code>
                          <button
                            onClick={() => copy(tok.id, tok.token)}
                            className="text-gray-600 hover:text-gray-300 shrink-0"
                          >
                            {copiedId === tok.id
                              ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                              : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div>
                          <p className="text-white font-medium text-sm">{clientName}</p>
                          {client?.user?.email && (
                            <p className="text-gray-500 text-xs">{client.user?.email ?? "—"}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-gray-300 text-sm font-mono">
                        {bytesToGb(tok.quota)}
                      </td>
                      <td className="px-5 py-3.5 text-gray-400 text-xs">
                        {tok.expiration
                          ? new Date(tok.expiration).toLocaleDateString('fr-FR')
                          : '—'}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${cfg.cls}`}>
                          {cfg.label}
                        </span>
                      </td>
                      {!isSupport && (
                        <td className="px-5 py-3.5 text-right">
                          {tok.status === 'active' && (
                            <button
                              onClick={() => handleRevoke(tok.id)}
                              title="Révoquer"
                              className="p-1.5 text-gray-600 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors"
                            >
                              <Ban className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md bg-[#0d111b] border border-[#1a1f2e] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1a1f2e]">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-cyan-400" />
                <h2 className="text-base font-semibold text-white">Générer un Token SXB</h2>
              </div>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="px-6 py-5 space-y-4">
              {formError && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-sm">
                  {formError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                  Client VPN *
                </label>
                <div className="relative">
                  <select
                    required
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className="w-full appearance-none px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 pr-8"
                  >
                    <option value="">Sélectionner un client...</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.user?.name || c.token} {c.user?.email ? `— ${c.user.email}` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                </div>
                {clients.length === 0 && (
                  <p className="text-xs text-amber-400 mt-1">Aucun client VPN. Créez d'abord un client.</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                    Quota (Go)
                  </label>
                  <input
                    type="number" min="1" max="1000" required
                    value={quotaGb}
                    onChange={(e) => setQuotaGb(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                    Durée (jours)
                  </label>
                  <input
                    type="number" min="1" max="365" required
                    value={durationDays}
                    onChange={(e) => setDurationDays(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">
                  Limite appareils
                </label>
                <input
                  type="number" min="1" max="10"
                  value={deviceLimit}
                  onChange={(e) => setDeviceLimit(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div className="flex gap-2 justify-end pt-2 border-t border-gray-900 mt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={submitting || clients.length === 0}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg disabled:opacity-50"
                >
                  {submitting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  Générer le Token
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchTokens, createToken, updateToken, revokeToken } from "../api/tokens";
import { TokenSXB, UserRole } from "../types";
import { Key, Plus, RefreshCw, Copy, Check, Ban, Search, HelpCircle, ShieldAlert } from "lucide-react";

interface TokensViewProps {
  currentUserRole: UserRole;
}

export default function TokensView({ currentUserRole }: TokensViewProps) {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<TokenSXB[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [showGenerateModal, setShowGenerateModal] = useState(false);

  // Form states
  const [owner, setOwner] = useState("");
  const [quota, setQuota] = useState(100);
  const [expiration, setExpiration] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().split("T")[0];
  });

  const isSupport = currentUserRole === UserRole.SUPPORT;

  const loadTokens = async () => {
    setLoading(true);
    try {
      const data = await fetchTokens();
      setTokens(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTokens();
  }, []);

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!owner) return;

    try {
      await createToken({
        owner,
        quota: Number(quota),
        expiration: new Date(expiration).toISOString(),
      });
      setOwner("");
      setQuota(100);
      setShowGenerateModal(false);
      loadTokens();
    } catch (err) {
      alert("Erreur lors de la création du token");
    }
  };

  const handleRevokeToken = async (id: string) => {
    if (isSupport) return;
    if (!confirm("Voulez-vous révoquer ce token d'accès ? L'appareil associé perdra immédiatement sa connexion VPN.")) return;
    try {
      await revokeToken(id);
      loadTokens();
    } catch (err) {
      alert("Erreur");
    }
  };

  const copyToClipboard = (id: string, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedTokenId(id);
    setTimeout(() => setCopiedTokenId(null), 1500);
  };

  const filtered = tokens.filter((tok) => {
    return tok.owner.toLowerCase().includes(search.toLowerCase()) ||
           tok.code.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t("sidebar.tokens")}</h1>
          <p className="text-sm text-gray-400 mt-1">Générez des tokens d'accès uniques pour authentifier les applications clientes SXB VPN.</p>
        </div>

        {!isSupport && (
          <button
            onClick={() => setShowGenerateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Générer un Token SXB
          </button>
        )}
      </div>

      {/* Filter and Search */}
      <div className="relative w-full md:w-80">
        <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher par propriétaire ou code..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        />
      </div>

      {/* Grid Tokens */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">{t("common.loading")}</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="border border-gray-800/80 rounded-xl bg-gray-950/20 overflow-hidden backdrop-blur-md">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  <th className="py-3 px-4">Code Token</th>
                  <th className="py-3 px-4">Propriétaire</th>
                  <th className="py-3 px-4">Quota Alloué</th>
                  <th className="py-3 px-4">Appareil Associé</th>
                  <th className="py-3 px-4">Expiration</th>
                  <th className="py-3 px-4 text-center">{t("common.status")}</th>
                  {!isSupport && <th className="py-3 px-4 text-right">{t("common.actions")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-900 text-sm">
                {filtered.map((tok) => {
                  const isRevoked = tok.status === "revoked";
                  const isExpired = tok.status === "expired";
                  
                  return (
                    <tr key={tok.id} className="hover:bg-gray-900/20 transition-colors">
                      <td className="py-4 px-4 font-mono text-xs font-bold text-cyan-400 flex items-center gap-2">
                        <span>{tok.code}</span>
                        <button
                          onClick={() => copyToClipboard(tok.id, tok.code)}
                          className="p-1 text-gray-500 hover:text-white rounded hover:bg-gray-900 cursor-pointer"
                        >
                          {copiedTokenId === tok.id ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </td>
                      <td className="py-4 px-4 text-white font-medium">{tok.owner}</td>
                      <td className="py-4 px-4 text-gray-300 font-mono">{tok.quota} Go</td>
                      <td className="py-4 px-4 text-xs text-gray-500 font-mono">
                        {tok.device || "Aucun appareil associé"}
                      </td>
                      <td className="py-4 px-4 text-xs text-gray-400 font-mono">
                        {new Date(tok.expiration).toLocaleDateString()}
                      </td>
                      <td className="py-4 px-4 text-center">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          tok.status === "active" 
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                        }`}>
                          {tok.status === "active" ? "Valide" : "Révoqué"}
                        </span>
                      </td>
                      
                      {!isSupport && (
                        <td className="py-4 px-4 text-right">
                          {tok.status === "active" && (
                            <button
                              onClick={() => handleRevokeToken(tok.id)}
                              title="Révoquer"
                              className="p-1 text-gray-500 hover:text-rose-400 hover:bg-gray-900/60 rounded cursor-pointer"
                            >
                              <Ban className="h-4 w-4" />
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
      ) : (
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <Key className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">Aucun Token SXB Enregistré</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mt-1">Créez des tokens cryptographiques VPN prêts pour les liaisons mobiles clientes.</p>
          {!isSupport && (
            <button
              onClick={() => setShowGenerateModal(true)}
              className="mt-5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800/40 hover:bg-cyan-900/50 transition-all cursor-pointer"
            >
              Créer votre premier token SXB
            </button>
          )}
        </div>
      )}

      {/* Generate Token Modal */}
      {showGenerateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Key className="h-5 w-5 text-cyan-400" />
              Générer un Token SXB
            </h2>
            
            <form onSubmit={handleCreateToken} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Identifiant Propriétaire</label>
                <input
                  type="text"
                  required
                  placeholder="Appareil mobile de Jean (iPhone 15)"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Quota du Token (Go)</label>
                <input
                  type="number"
                  required
                  min="5"
                  value={quota}
                  onChange={(e) => setQuota(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Expiration</label>
                <input
                  type="date"
                  required
                  value={expiration}
                  onChange={(e) => setExpiration(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-gray-900">
                <button
                  type="button"
                  onClick={() => setShowGenerateModal(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 cursor-pointer"
                >
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

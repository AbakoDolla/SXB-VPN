import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchVouchers, createVoucher, useVoucher } from "../api/vouchers";
import { Voucher, UserRole } from "../types";
import { Ticket, Plus, Search, RefreshCw, Sparkles, Check, Copy } from "lucide-react";

interface VouchersViewProps {
  currentUserRole: UserRole;
}

export default function VouchersView({ currentUserRole }: VouchersViewProps) {
  const { t } = useTranslation();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [copiedVchId, setCopiedVchId] = useState<string | null>(null);

  // Activation simulation input
  const [activationInput, setActivationInput] = useState("");

  // Create Voucher Modal
  const [showAddVoucher, setShowAddVoucher] = useState(false);
  const [quota, setQuota] = useState(50);
  const [expiration, setExpiration] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 2);
    return d.toISOString().split("T")[0];
  });

  const isSupport = currentUserRole === UserRole.SUPPORT;

  const loadVouchers = async () => {
    setLoading(true);
    try {
      const data = await fetchVouchers();
      setVouchers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadVouchers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const diffMs = new Date(expiration).getTime() - Date.now();
      const durationDays = Math.max(1, Math.ceil(diffMs / 86400000));
      await createVoucher({
        quotaGb: Number(quota),
        durationDays,
      });
      setQuota(50);
      setShowAddVoucher(false);
      loadVouchers();
    } catch (err) {
      alert("Erreur lors de la création du voucher");
    }
  };

  const handleActivateVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activationInput) return;

    try {
      const result = await useVoucher(activationInput.trim());
      setActivationInput("");
      if (result.success) {
        alert(`Félicitations ! Le voucher a bien été activé !`);
      } else {
        alert(result.message);
      }
      loadVouchers();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erreur lors de l'activation");
    }
  };

  const copyToClipboard = (id: string, code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedVchId(id);
    setTimeout(() => setCopiedVchId(null), 1500);
  };

  const filtered = vouchers.filter((v) => {
    return v.code.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t("sidebar.vouchers")}</h1>
          <p className="text-sm text-gray-400 mt-1">Créez et activez des recharges de data prépayées (Vouchers) pour les comptes VPN.</p>
        </div>

        {!isSupport && (
          <button
            onClick={() => setShowAddVoucher(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Créer un Code Voucher
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Table list */}
        <div className="lg:col-span-2 space-y-4">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
            <input
              type="text"
              placeholder="Filtrer par code voucher..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            />
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
              <p className="text-sm font-mono">{t("common.loading")}</p>
            </div>
          ) : filtered.length > 0 ? (
            <div className="border border-gray-800/80 rounded-xl bg-gray-950/20 overflow-hidden backdrop-blur-md">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      <th className="py-3 px-4">Code Recharge</th>
                      <th className="py-3 px-4">Quota Data</th>
                      <th className="py-3 px-4">Date d'Expiration</th>
                      <th className="py-3 px-4 text-center">{t("common.status")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-900 text-sm">
                    {filtered.map((v) => {
                      const isUsed = v.status === "used";
                      return (
                        <tr key={v.id} className="hover:bg-gray-900/20 transition-colors">
                          <td className="py-4 px-4 font-mono text-xs font-bold text-cyan-400 flex items-center gap-2">
                            <span>{v.code}</span>
                            <button
                              onClick={() => copyToClipboard(v.id, v.code)}
                              className="p-1 text-gray-500 hover:text-white rounded hover:bg-gray-900 cursor-pointer"
                            >
                              {copiedVchId === v.id ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                          </td>
                          <td className="py-4 px-4 font-mono font-semibold text-white">{Math.round(Number(v.quota) / (1024*1024*1024))} Go</td>
                          <td className="py-4 px-4 text-xs text-gray-500 font-mono">
                            {v.createdAt ? new Date(new Date(v.createdAt).getTime() + (v.durationDays ?? 0) * 86400000).toLocaleDateString() : "—"}
                          </td>
                          <td className="py-4 px-4 text-center">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                              v.status === "active" 
                                ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                                : "bg-gray-500/10 text-gray-500 border border-gray-500/20"
                            }`}>
                              {v.status === "active" ? "Disponible" : "Activé / Utilisé"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
              <Ticket className="h-11 w-11 text-gray-700 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-white">Aucun Code Voucher Actif</h3>
              <p className="text-xs text-gray-400 max-w-sm mx-auto mt-1">Créez des cartes de recharges prépayées que vos clients pourront gratter ou activer.</p>
            </div>
          )}
        </div>

        {/* Activation module */}
        <div className="p-6 rounded-xl border border-gray-800/80 bg-gray-950/40 flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-white uppercase tracking-wider mb-2">
              <Sparkles className="h-5 w-5 text-amber-400" />
              Activer une Recharge
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              Testez l'activation directe d'un voucher de recharge créé. Saisissez ou copiez le code (format <code>VCH-XXXXX-XXXXX</code>) dans le champ ci-dessous.
            </p>
          </div>

          <form onSubmit={handleActivateVoucher} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Code Voucher</label>
              <input
                type="text"
                required
                placeholder="VCH-XXXXX-XXXXX"
                value={activationInput}
                onChange={(e) => setActivationInput(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono text-center font-bold bg-gray-900 border border-gray-800 rounded-lg text-amber-400 placeholder-gray-700 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-black font-semibold text-xs rounded-lg transition-all shadow-md shadow-amber-950/20 uppercase tracking-widest cursor-pointer"
            >
              Créditer le compte VPN
            </button>
          </form>
        </div>
      </div>

      {/* Create Voucher Modal */}
      {showAddVoucher && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md p-6 bg-gray-950 border border-gray-800 rounded-xl shadow-2xl relative">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Ticket className="h-5 w-5 text-cyan-400" />
              Créer un Code Voucher
            </h2>
            
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Allocation Data (Go)</label>
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
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Date Limite d'activation</label>
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
                  onClick={() => setShowAddVoucher(false)}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-900 text-gray-400 hover:bg-gray-800 cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 cursor-pointer"
                >
                  Créer Recharge
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

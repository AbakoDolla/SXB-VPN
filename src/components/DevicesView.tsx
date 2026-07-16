
import React, { useEffect, useState } from "react";
import { fetchDevices, generateDeviceToken, revokeDevice, renewDevice, Device } from "../api/devices";
import { Smartphone, Plus, Copy, Check, Ban, RefreshCw, Search, X, Clock, Shield, Key } from "lucide-react";

const STATUS_CONFIG = {
  active:    { label: "Actif",    cls: "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20" },
  suspended: { label: "Révoqué", cls: "text-rose-400 bg-rose-500/10 border border-rose-500/20" },
  expired:   { label: "Expiré",  cls: "text-amber-400 bg-amber-500/10 border border-amber-500/20" },
};

function daysUntil(dateStr: string | null): string {
  if (!dateStr) return "—";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return "Expiré";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  if (days > 365) return `${Math.floor(days / 365)} an${Math.floor(days / 365) > 1 ? "s" : ""}`;
  return `${days} jour${days > 1 ? "s" : ""}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export default function DevicesView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const [deviceId, setDeviceId] = useState("");
  const [label, setLabel] = useState("");
  const [durationDays, setDurationDays] = useState(365);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchDevices();
      setDevices(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId.trim()) { setFormError("L'ID de l'appareil est requis"); return; }
    setFormError("");
    setSubmitting(true);
    setGeneratedToken(null);
    try {
      const result = await generateDeviceToken({ deviceId: deviceId.trim(), label: label.trim() || undefined, durationDays });
      setGeneratedToken(result.token);
      await load();
    } catch (err: any) {
      const respData = err?.responseData;
      if (respData?.device) {
        setGeneratedToken(respData.device.token);
        setFormError("Cet appareil a déjà un token actif — voici le token existant.");
        await load();
      } else {
        setFormError(respData?.message || err?.message || "Erreur lors de la génération");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm("Révoquer le token de cet appareil ? L'accès VPN sera immédiatement coupé.")) return;
    try { await revokeDevice(id); await load(); }
    catch (err: any) { alert(err?.message || "Erreur"); }
  };

  const handleRenew = async (id: string) => {
    if (!confirm("Renouveler pour 365 jours ?")) return;
    try { await renewDevice(id, 365); await load(); }
    catch (err: any) { alert(err?.message || "Erreur"); }
  };

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedId(key);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const filtered = devices.filter(d =>
    (d.deviceId || "").toLowerCase().includes(search.toLowerCase()) ||
    (d.token || "").toLowerCase().includes(search.toLowerCase()) ||
    (d.label || "").toLowerCase().includes(search.toLowerCase())
  );

  const active = devices.filter(d => d.status === "active" && (!d.expireAt || new Date(d.expireAt) > new Date())).length;
  const inactive = devices.length - active;

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
            <Smartphone className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Appareils & Tokens</h2>
            <p className="text-sm text-gray-500">Gérez les tokens d'activation par appareil</p>
          </div>
        </div>
        <button
          onClick={() => { setShowModal(true); setGeneratedToken(null); setFormError(""); setDeviceId(""); setLabel(""); }}
          className="flex items-center gap-2 px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 rounded-xl text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Générer un token
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { icon: Smartphone, label: "Total appareils", value: devices.length, color: "cyan" },
          { icon: Shield, label: "Actifs", value: active, color: "emerald" },
          { icon: Ban, label: "Expirés / Révoqués", value: inactive, color: "rose" },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl p-4 flex items-center gap-4">
            <div className={`p-2.5 rounded-xl bg-${color}-500/10`}>
              <Icon className={`w-5 h-5 text-${color}-400`} />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{value}</p>
              <p className="text-xs text-gray-500">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          placeholder="Rechercher un appareil, token, libellé..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-[#0f1218] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-500 text-sm focus:outline-none focus:border-cyan-500 transition-colors"
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2">
            <X className="w-4 h-4 text-gray-500 hover:text-white" />
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw className="w-6 h-6 text-cyan-400 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <div className="p-4 rounded-2xl bg-cyan-500/5 border border-cyan-500/10">
              <Smartphone className="w-8 h-8 text-cyan-400/40" />
            </div>
            <p className="text-gray-400 font-medium">Aucun appareil enregistré</p>
            <p className="text-gray-600 text-sm">Cliquez sur « Générer un token » pour commencer</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#1a1f2e]">
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Appareil</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Token d'activation</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Statut</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Expiration</th>
                  <th className="text-right px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {filtered.map(device => {
                  const isExpired = device.expireAt && new Date(device.expireAt) < new Date();
                  const effectiveStatus = (isExpired && device.status === "active") ? "expired" : device.status;
                  const { label: sLabel, cls } = STATUS_CONFIG[effectiveStatus as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.active;
                  return (
                    <tr key={device.id} className="hover:bg-white/[0.02] transition-colors group">
                      <td className="px-5 py-4">
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-white">{device.label || "—"}</span>
                          <div className="flex items-center gap-2">
                            <code className="text-xs text-gray-500 font-mono bg-black/30 px-2 py-0.5 rounded">{device.deviceId || "—"}</code>
                            {device.deviceId && (
                              <button onClick={() => copy(`dev-${device.id}`, device.deviceId!)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                                {copiedId === `dev-${device.id}` ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-gray-500 hover:text-white" />}
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-cyan-400 font-mono bg-cyan-500/5 border border-cyan-500/10 px-2 py-1 rounded">{device.token}</code>
                          <button onClick={() => copy(`tok-${device.id}`, device.token)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                            {copiedId === `tok-${device.id}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-gray-500 hover:text-white" />}
                          </button>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium ${cls}`}>{sLabel}</span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm text-white">{formatDate(device.expireAt)}</span>
                          <span className={`text-xs flex items-center gap-1 ${isExpired ? "text-rose-400" : "text-gray-500"}`}>
                            <Clock className="w-3 h-3" />{daysUntil(device.expireAt)}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => copy(`tok2-${device.id}`, device.token)}
                            title="Copier le token"
                            className="p-1.5 rounded-lg hover:bg-cyan-500/10 text-gray-500 hover:text-cyan-400 transition-colors"
                          >
                            {copiedId === `tok2-${device.id}` ? <Check className="w-4 h-4 text-emerald-400" /> : <Key className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => handleRenew(device.id)}
                            title="Renouveler 1 an"
                            className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-gray-500 hover:text-emerald-400 transition-colors"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                          {device.status !== "suspended" && (
                            <button
                              onClick={() => handleRevoke(device.id)}
                              title="Révoquer"
                              className="p-1.5 rounded-lg hover:bg-rose-500/10 text-gray-500 hover:text-rose-400 transition-colors"
                            >
                              <Ban className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Generate Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
                  <Key className="w-4 h-4 text-cyan-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Générer un token d'activation</h3>
              </div>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {generatedToken ? (
              <div className="space-y-4">
                <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-center">
                  <p className="text-emerald-400 text-sm font-medium mb-3">✓ Token généré avec succès !</p>
                  {formError && <p className="text-amber-400 text-xs mb-3">{formError}</p>}
                  <div className="flex items-center gap-2 bg-black/40 border border-emerald-500/20 rounded-xl px-4 py-3">
                    <code className="flex-1 text-emerald-300 font-mono text-base font-bold tracking-widest text-center">{generatedToken}</code>
                    <button onClick={() => copy("modal-tok", generatedToken)}>
                      {copiedId === "modal-tok" ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5 text-gray-400 hover:text-white" />}
                    </button>
                  </div>
                  <p className="text-gray-500 text-xs mt-3">Donnez ce token à l'utilisateur pour qu'il l'active dans l'app mobile.</p>
                </div>
                <button
                  onClick={() => { setShowModal(false); setGeneratedToken(null); setDeviceId(""); setLabel(""); setFormError(""); }}
                  className="w-full py-3 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 rounded-xl text-sm font-medium transition-colors"
                >
                  Fermer
                </button>
              </div>
            ) : (
              <form onSubmit={handleGenerate} className="space-y-4">
                {formError && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl">
                    <p className="text-rose-400 text-sm">{formError}</p>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    ID de l'appareil <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={deviceId}
                    onChange={e => setDeviceId(e.target.value)}
                    placeholder="ex: SXB3F2A9B8C1D4E5F6"
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 font-mono text-sm focus:outline-none focus:border-cyan-500 transition-colors"
                    required
                  />
                  <p className="text-xs text-gray-600 mt-1">Copiez l'ID depuis l'écran d'activation de l'app mobile.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    Nom / Libellé <span className="text-gray-500">(optionnel)</span>
                  </label>
                  <input
                    type="text"
                    value={label}
                    onChange={e => setLabel(e.target.value)}
                    placeholder="ex: iPhone de Jean, Samsung Galaxy S24"
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">Durée de validité</label>
                  <select
                    value={durationDays}
                    onChange={e => setDurationDays(Number(e.target.value))}
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 transition-colors"
                  >
                    <option value={30}>30 jours</option>
                    <option value={90}>3 mois</option>
                    <option value={180}>6 mois</option>
                    <option value={365}>1 an (recommandé)</option>
                    <option value={730}>2 ans</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-gray-400 rounded-xl text-sm font-medium transition-colors"
                  >
                    Annuler
                  </button>
                  <button
                    type="submit"
                    disabled={submitting || !deviceId.trim()}
                    className="flex-1 py-3 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                    {submitting ? "Génération..." : "Générer le token"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

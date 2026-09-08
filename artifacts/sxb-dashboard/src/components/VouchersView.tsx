import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { fetchVouchers, createVoucher, redeemVoucher, revokeVoucher } from "../api/vouchers";
import { fetchClients } from "../api/clients";
import { fetchResellers } from "../api/resellers";
import { Client, Reseller, Voucher, UserRole } from "../types";
import { formatBytes, isUpperRole } from "../lib/resellerAccess";
import { useResellerAccess } from "../contexts/ResellerAccessContext";
import { ResellerActionNotice } from "./ResellerAccessBanner";
import { Ticket, Plus, Search, RefreshCw, Sparkles, Check, Copy, ShieldOff } from "lucide-react";
import { toast } from "sonner";

interface VouchersViewProps {
  currentUserRole: UserRole;
  permissions: string[];
}

export default function VouchersView({ currentUserRole, permissions }: VouchersViewProps) {
  const { t, locale, formatNumber, message, errorText } = useTranslation();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [copiedVchId, setCopiedVchId] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [clientId, setClientId] = useState("");
  const [resellerId, setResellerId] = useState("");
  const [durationDays, setDurationDays] = useState(30);
  const [busy, setBusy] = useState(false);

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
  const showsOwner = isUpperRole(currentUserRole);
  const hasPermission = (permission: string) => currentUserRole === UserRole.OWNER || permissions.includes(permission);
  const { allows, refresh: refreshAccess } = useResellerAccess();
  // Émettre un bon engage du volume : fermé quand l'agrément est expiré ou le
  // plafond atteint.
  const canCreate = !isSupport && hasPermission("vouchers.create") && allows() && !busy;
  const canRedeem = !isSupport && hasPermission("vouchers.redeem") && allows({ reducesExposure: true }) && !busy;
  const canRevoke = !isSupport && hasPermission("vouchers.revoke") && allows({ reducesExposure: true }) && !busy;

  const loadVouchers = async () => {
    setLoading(true);
    try {
      const [data, roster, owners] = await Promise.all([
        fetchVouchers(),
        hasPermission("clients.view") ? fetchClients() : Promise.resolve([]),
        showsOwner && hasPermission("reseller.manage") ? fetchResellers() : Promise.resolve([]),
      ]);
      setVouchers(data);
      setClients(roster);
      setResellers(owners);
    } catch (err) {
      toast.error(errorText(err, 'commerce.vouchers.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadVouchers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    if (showsOwner && !resellerId) { toast.error(message('commerce.vouchers.resellerRequired')); return; }
    const diffMs = new Date(`${expiration}T23:59:59`).getTime() - Date.now();
    if (!Number.isFinite(diffMs) || diffMs <= 0) { toast.error(message('commerce.vouchers.futureDeadline')); return; }
    setBusy(true);
    try {
      await createVoucher({
        quotaGb: Number(quota),
        durationDays,
        activationDays: Math.ceil(diffMs / 86400000),
        ...(showsOwner ? { resellerId } : {}),
      });
      setQuota(50);
      setShowAddVoucher(false);
      toast.success(message('commerce.vouchers.created'));
      await Promise.all([loadVouchers(), refreshAccess()]);
    } catch (err) {
      toast.error(errorText(err, 'commerce.vouchers.createError'));
    } finally {
      setBusy(false);
    }
  };

  const handleActivateVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canRedeem) return;
    if (!activationInput || !clientId) { toast.error(message('commerce.vouchers.clientCodeRequired')); return; }

    setBusy(true);
    try {
      const result = await redeemVoucher(activationInput.trim(), clientId);
      setActivationInput("");
      if (result.success) {
        toast.success(message('commerce.vouchers.activated'));
      } else {
        toast.error(errorText(result.message, 'commerce.vouchers.invalid'));
      }
      await Promise.all([loadVouchers(), refreshAccess()]);
    } catch (err) {
      toast.error(errorText(err, 'commerce.vouchers.activationError'));
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedVchId(id);
      setTimeout(() => setCopiedVchId(null), 1500);
    } catch {
      toast.error(message('commerce.vouchers.copyError'));
    }
  };

  const handleRevoke = async (voucher: Voucher) => {
    if (!canRevoke || !window.confirm(t('commerce.vouchers.confirmRevoke'))) return;
    setBusy(true);
    try {
      await revokeVoucher(voucher.id);
      toast.success(message('commerce.vouchers.revoked'));
      await Promise.all([loadVouchers(), refreshAccess()]);
    } catch (err) {
      toast.error(errorText(err, 'commerce.vouchers.revokeError'));
    } finally {
      setBusy(false);
    }
  };

  const filtered = vouchers.filter((v) => {
    return (v.code || "").toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{t('commerce.vouchers.title')}</h1>
          <p className="text-sm text-gray-400 mt-1">{t('commerce.vouchers.subtitle')}</p>
        </div>

        {!isSupport && hasPermission("vouchers.create") && (
          <button
            onClick={() => setShowAddVoucher(true)}
            disabled={!canCreate}
            title={canCreate ? undefined : t('commerce.common.unavailableQuota')}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
            {t('commerce.vouchers.create')}
          </button>
        )}
      </div>

      {!isSupport && <ResellerActionNotice />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Table list */}
        <div className="lg:col-span-2 space-y-4">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-2.5 h-4.5 w-4.5 text-gray-500" />
            <input
              type="text"
              placeholder={t('commerce.vouchers.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            />
          </div>

          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
              <p className="text-sm font-mono">{t('commerce.common.loading')}</p>
            </div>
          ) : filtered.length > 0 ? (
            <div className="border border-gray-800/80 rounded-xl bg-gray-950/20 overflow-hidden backdrop-blur-md">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-gray-800/80 bg-gray-900/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      <th className="py-3 px-4">{t('commerce.vouchers.code')}</th>
                      <th className="py-3 px-4">{t('commerce.vouchers.reserved')}</th>
                      {showsOwner && <th className="py-3 px-4">{t('commerce.common.reseller')}</th>}
                      <th className="py-3 px-4">{t('commerce.vouchers.beneficiary')}</th>
                      <th className="py-3 px-4">{t('commerce.vouchers.validity')}</th>
                      <th className="py-3 px-4 text-center">{t('commerce.common.status')}</th>
                      <th className="py-3 px-4">{t('commerce.common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-900 text-sm">
                    {filtered.map((v) => {
                      const status = v.isRedeemed ? "used" : (v.status || "active");
                      const label = { active: t('commerce.common.available'), used: t('commerce.common.used'), expired: t('commerce.common.expired'), revoked: t('commerce.common.revoked') }[status];
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
                          <td className="py-4 px-4 font-mono font-semibold text-white">{formatBytes(v.quota)}</td>
                          {showsOwner && <td className="py-4 px-4 text-gray-400">{v.reseller?.name || t('commerce.vouchers.legacyUnassigned')}</td>}
                          <td className="py-4 px-4 text-gray-400">{v.redeemedClient?.name || t('commerce.vouchers.unused')}</td>
                          <td className="py-4 px-4 text-xs text-gray-500 font-mono">
                            {v.expiresAt ? new Date(v.expiresAt).toLocaleDateString(locale) : t('commerce.vouchers.legacyNoExpiry')}
                            <span className="block mt-1">{t('commerce.vouchers.creditedDays', { count: formatNumber(v.durationDays ?? 0) })}</span>
                          </td>
                          <td className="py-4 px-4 text-center">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                              status === "active"
                                ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                                : "bg-gray-500/10 text-gray-500 border border-gray-500/20"
                            }`}>
                              {label}
                            </span>
                          </td>
                          <td className="py-4 px-4">
                            {status === "active" && hasPermission("vouchers.revoke") && (
                              <button onClick={() => handleRevoke(v)} disabled={!canRevoke} title={t('commerce.vouchers.revoke')}
                                className="p-2 text-rose-400 rounded-lg hover:bg-rose-500/10 disabled:opacity-40">
                                <ShieldOff className="h-4 w-4" />
                              </button>
                            )}
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
              <h3 className="text-sm font-semibold text-white">{t('commerce.vouchers.empty')}</h3>
              <p className="text-xs text-gray-400 max-w-sm mx-auto mt-1">{t('commerce.vouchers.emptyHint')}</p>
            </div>
          )}
        </div>

        {/* Activation module */}
        <div className="p-6 rounded-xl border border-gray-800/80 bg-gray-950/40 flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-white uppercase tracking-wider mb-2">
              <Sparkles className="h-5 w-5 text-amber-400" />
              {t('commerce.vouchers.activate')}
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">
              {t('commerce.vouchers.activateHint')}
            </p>
          </div>

          <form onSubmit={handleActivateVoucher} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1" htmlFor="voucher-client">{t('commerce.vouchers.recipientClient')}</label>
              <select id="voucher-client" required value={clientId} onChange={e => setClientId(e.target.value)}
                disabled={!canRedeem} className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm">
                <option value="">{t('commerce.common.chooseClientPlain')}</option>
                {clients.map(client => <option key={client.id} value={client.id}>
                  {client.user?.name || client.name || client.id}{showsOwner && client.resellerName ? ` — ${client.resellerName}` : ""}
                </option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">{t('commerce.vouchers.voucherCode')}</label>
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
              disabled={!canRedeem || !clientId}
              title={canRedeem ? undefined : t('commerce.vouchers.unavailablePermission')}
              className="w-full py-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-black font-semibold text-xs rounded-lg transition-all shadow-md shadow-amber-950/20 uppercase tracking-widest cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('commerce.vouchers.credit')}
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
              {t('commerce.vouchers.create')}
            </h2>
            
            <form onSubmit={handleCreate} className="space-y-4">
              {showsOwner && <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5" htmlFor="voucher-reseller">{t('commerce.vouchers.owner')}</label>
                <select id="voucher-reseller" required value={resellerId} onChange={e => setResellerId(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm">
                  <option value="">{t('commerce.common.chooseReseller')}</option>
                  {resellers.filter(reseller => reseller.accessState !== "expired" && reseller.status === "active").map(reseller =>
                    <option key={reseller.id} value={reseller.id}>{reseller.name}</option>)}
                </select>
              </div>}
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t('commerce.vouchers.dataGb')}</label>
                <input
                  type="number"
                  required
                  min="1"
                  max="1000000"
                  step="1"
                  value={quota}
                  onChange={(e) => setQuota(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5" htmlFor="voucher-duration">{t('commerce.vouchers.duration')}</label>
                <input id="voucher-duration" type="number" required min={1} max={3650} step={1}
                  value={durationDays} onChange={e => setDurationDays(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-white text-sm" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">{t('commerce.vouchers.deadline')}</label>
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
                  {t('commerce.common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={!canCreate}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black shadow-lg shadow-cyan-950/20 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('commerce.vouchers.submit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

import { useTranslation } from '../contexts/I18nContext';

import React, { useEffect, useState, useMemo } from "react";
import { fetchDevices, generateDeviceToken, revokeDevice, renewDevice, Device } from "../api/devices";
import { fetchResellers } from "../api/resellers";
import { Reseller, UserRole } from "../types";
import { useResellerAccess } from "../contexts/ResellerAccessContext";
import { usePermissions } from "../contexts/PermissionsContext";
import { ResellerAccessSummaryCard, ResellerActionNotice } from "./ResellerAccessBanner";
import { isUpperRole, ownerLabel } from "../lib/resellerAccess";
import { Smartphone, Plus, Copy, Check, Ban, RefreshCw, Search, X, Clock, Shield, Key, Store, PackageOpen } from "lucide-react";
import Pagination from "./ui/Pagination";
import { toast } from "sonner";

const createStatusConfig = (t: ReturnType<typeof useTranslation>['t']) => ({
  active:    { label: t('commerce.common.active'),    cls: "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20" },
  suspended: { label: t('commerce.common.revoked'), cls: "text-rose-400 bg-rose-500/10 border border-rose-500/20" },
  expired:   { label: t('commerce.common.expired'),  cls: "text-amber-400 bg-amber-500/10 border border-amber-500/20" },
});

function daysUntil(dateStr: string | null, t: ReturnType<typeof useTranslation>['t'], locale: string): string {
  if (!dateStr) return "—";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return t('commerce.common.expired');
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  const count = days > 365 ? Math.floor(days / 365) : days;
  return t(days > 365
    ? count === 1 ? 'commerce.common.yearsOne' : 'commerce.common.years'
    : count === 1 ? 'commerce.common.daysOne' : 'commerce.common.days',
  { count: new Intl.NumberFormat(locale).format(count) });
}

export default function DevicesView({ currentUserRole }: { currentUserRole?: UserRole }) {
  const { t, locale, formatNumber, formatBytes, formatDate, message, errorMessage, errorText } = useTranslation();
  const STATUS_CONFIG = createStatusConfig(t);
  const [devices, setDevices] = useState<Device[]>([]);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const [deviceId, setDeviceId] = useState("");
  const [label, setLabel] = useState("");
  const [durationDays, setDurationDays] = useState(365);
  const [resellerId, setResellerId] = useState("");
  const [formError, setFormError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);

  const isSupport = currentUserRole === UserRole.SUPPORT;
  const isReseller = currentUserRole === UserRole.RESELLER;
  const showsOwnerColumn = isUpperRole(currentUserRole);
  const { allows, refresh: refreshAccess } = useResellerAccess();
  // Enrôler un appareil engage le parc : fermé si l'agrément est expiré ou le
  // plafond atteint. Révoquer reste ouvert au plafond, c'est un geste libérateur.
  const can = usePermissions();
  const canWrite = can("clients.manage") || can("clients.create");
  const canEnroll = !isSupport && allows() && canWrite;
  const canRevoke = !isSupport && allows({ reducesExposure: true }) && canWrite;

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchDevices();
      setDevices(data);
      if (showsOwnerColumn) setResellers(await fetchResellers().catch(() => [] as Reseller[]));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId.trim()) { setFormError('commerce.devices.idRequired'); return; }
    setFormError("");
    setSubmitting(true);
    setGeneratedToken(null);
    try {
      const result = await generateDeviceToken({
        deviceId: deviceId.trim(),
        label: label.trim() || undefined,
        durationDays,
        resellerId: showsOwnerColumn && resellerId ? resellerId : undefined,
      });
      setGeneratedToken(result.token);
      await Promise.all([load(), refreshAccess()]);
    } catch (err: any) {
      const respData = err?.responseData;
      if (respData?.device) {
        setGeneratedToken(respData.device.token);
        setFormError('commerce.devices.existingToken');
        await Promise.all([load(), refreshAccess()]);
      } else {
        setFormError(err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const handleRevoke = async (id: string) => {
    if (!window.confirm(t('commerce.devices.confirmRevoke'))) return;
    try { await revokeDevice(id); await Promise.all([load(), refreshAccess()]); toast.success(message('commerce.devices.tokenRevoked')); }
    catch (err: any) { toast.error(errorText(err, 'commerce.common.error')); }
  };

  const handleRenew = async (id: string) => {
    if (!window.confirm(t('commerce.devices.confirmRenew'))) return;
    try { await renewDevice(id, 365); await Promise.all([load(), refreshAccess()]); toast.success(message('commerce.devices.renewed')); }
    catch (err: any) { toast.error(errorText(err, 'commerce.common.error')); }
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

  const paginated = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);

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
            <h2 className="text-lg font-semibold text-white">{t('commerce.devices.title')}</h2>
            <p className="text-sm text-gray-500">
              {t('commerce.devices.subtitle')}
            </p>
          </div>
        </div>
        <button
          onClick={() => { setShowModal(true); setGeneratedToken(null); setFormError(""); setDeviceId(""); setLabel(""); setResellerId(""); }}
          disabled={!canEnroll}
          title={canEnroll ? undefined : t('commerce.common.unavailableQuota')}
          className="flex items-center gap-2 px-4 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 rounded-xl text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="w-4 h-4" />
          {t('commerce.devices.generate')}
        </button>
      </div>

      {isReseller && <ResellerAccessSummaryCard />}
      {!isSupport && <ResellerActionNotice />}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { icon: Smartphone, label: t('commerce.devices.total'), value: devices.length, color: "cyan" },
          { icon: Shield, label: t('commerce.common.activePlural'), value: active, color: "emerald" },
          { icon: Ban, label: t('commerce.devices.inactive'), value: inactive, color: "rose" },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl p-4 flex items-center gap-4">
            <div className={`p-2.5 rounded-xl bg-${color}-500/10`}>
              <Icon className={`w-5 h-5 text-${color}-400`} />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">{formatNumber(value)}</p>
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
          placeholder={t('commerce.devices.search')}
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
            <p className="text-gray-400 font-medium">{t('commerce.devices.empty')}</p>
            <p className="text-gray-600 text-sm">{t('commerce.devices.emptyHint')}</p>
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#1a1f2e]">
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.devices.device')}</th>
                  {showsOwnerColumn && (
                    <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.common.reseller')}</th>
                  )}
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.devices.activationToken')}</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.common.status')}</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.common.plan')}</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.common.quota')}</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.devices.actualTraffic')}</th>
                  <th className="text-left px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.common.expiration')}</th>
                  <th className="text-right px-5 py-3 text-xs text-gray-500 font-medium uppercase tracking-wider">{t('commerce.common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1f2e]">
                {paginated.map(device => {
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
                      {showsOwnerColumn && (
                        <td className="px-5 py-4">
                          <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300">
                            <Store className="w-3 h-3 shrink-0" />
                            {ownerLabel(device.resellerName)}
                          </span>
                        </td>
                      )}
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
                      {/* Un appareil SANS forfait est un état normal : le plan est
                          une décision commerciale distincte de l'activation. */}
                      <td className="px-5 py-4">
                        {device.hasSubscription ? (
                          <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">
                            <PackageOpen className="w-3 h-3 shrink-0" />
                            {device.subscriptionName || t('commerce.devices.activePlan')}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500">{t('commerce.devices.noPlan')}</span>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-col gap-1 text-xs">
                          <span className="text-white">{t('commerce.devices.usedBytes', { value: formatBytes(device.quotaUsed) })}</span>
                          <span className="text-emerald-400">{t('commerce.devices.remainingBytes', { value: formatBytes(device.quotaRemaining) })}</span>
                          <span className="text-gray-600">{t('commerce.devices.ofBytes', { value: formatBytes(device.quotaTotal) })}</span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-col gap-1 text-xs">
                          <span className="text-sky-400">↓ {formatBytes(device.trafficDownload)}</span>
                          <span className="text-violet-400">↑ {formatBytes(device.trafficUpload)}</span>
                          <span className="text-gray-600">{t('commerce.devices.totalBytes', { value: formatBytes(device.trafficTotal) })}</span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm text-white">{formatDate(device.expireAt, { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                          <span className={`text-xs flex items-center gap-1 ${isExpired ? "text-rose-400" : "text-gray-500"}`}>
                            <Clock className="w-3 h-3" />{daysUntil(device.expireAt, t, locale)}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => copy(`tok2-${device.id}`, device.token)}
                            title={t('commerce.devices.copyToken')}
                            className="p-1.5 rounded-lg hover:bg-cyan-500/10 text-gray-500 hover:text-cyan-400 transition-colors"
                          >
                            {copiedId === `tok2-${device.id}` ? <Check className="w-4 h-4 text-emerald-400" /> : <Key className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => handleRenew(device.id)}
                            disabled={!canEnroll}
                            title={t('commerce.devices.renewYear')}
                            className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-gray-500 hover:text-emerald-400 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                          {device.status !== "suspended" && (
                            <button
                              onClick={() => handleRevoke(device.id)}
                              disabled={!canRevoke}
                              title={t('commerce.common.revoke')}
                              className="p-1.5 rounded-lg hover:bg-rose-500/10 text-gray-500 hover:text-rose-400 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
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
          <div className="border-t border-[#1a1f2e] px-4">
            <Pagination page={page} pageSize={pageSize} total={filtered.length}
              onPageChange={setPage} onPageSizeChange={s => { setPageSize(s); setPage(1); }} />
          </div>
          </>
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
                <h3 className="text-lg font-semibold text-white">{t('commerce.devices.generateActivation')}</h3>
              </div>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {generatedToken ? (
              <div className="space-y-4">
                <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-center">
                  <p className="text-emerald-400 text-sm font-medium mb-3">{t('commerce.devices.generated')}</p>
                  {!!formError && <p className="text-amber-400 text-xs mb-3">{errorMessage(formError, 'commerce.common.errorGenerate')}</p>}
                  <div className="flex items-center gap-2 bg-black/40 border border-emerald-500/20 rounded-xl px-4 py-3">
                    <code className="flex-1 text-emerald-300 font-mono text-base font-bold tracking-widest text-center">{generatedToken}</code>
                    <button onClick={() => copy("modal-tok", generatedToken)}>
                      {copiedId === "modal-tok" ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5 text-gray-400 hover:text-white" />}
                    </button>
                  </div>
                  <p className="text-gray-500 text-xs mt-3">
                    {t('commerce.devices.shareToken')}
                  </p>
                </div>
                <button
                  onClick={() => { setShowModal(false); setGeneratedToken(null); setDeviceId(""); setLabel(""); setFormError(""); }}
                  className="w-full py-3 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 rounded-xl text-sm font-medium transition-colors"
                >
                  {t('commerce.common.close')}
                </button>
              </div>
            ) : (
              <form onSubmit={handleGenerate} className="space-y-4">
                {!!formError && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl">
                    <p className="text-rose-400 text-sm">{errorMessage(formError, 'commerce.common.errorGenerate')}</p>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    {t('commerce.devices.deviceId')} <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={deviceId}
                    onChange={e => setDeviceId(e.target.value)}
                    placeholder={t('commerce.devices.exampleId')}
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 font-mono text-sm focus:outline-none focus:border-cyan-500 transition-colors"
                    required
                  />
                  <p className="text-xs text-gray-600 mt-1">{t('commerce.devices.idHint')}</p>
                </div>
                {showsOwnerColumn && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1.5">
                      {t('commerce.common.assignReseller')} <span className="text-gray-500">{t('commerce.common.optional')}</span>
                    </label>
                    <select
                      value={resellerId}
                      onChange={e => setResellerId(e.target.value)}
                      className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 transition-colors"
                    >
                      <option value="">{t('commerce.devices.directDevice')}</option>
                      {resellers.map(r => (
                        <option key={r.id} value={r.id}>{r.name} — {r.email}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    {t('commerce.devices.label')} <span className="text-gray-500">{t('commerce.common.optional')}</span>
                  </label>
                  <input
                    type="text"
                    value={label}
                    onChange={e => setLabel(e.target.value)}
                    placeholder={t('commerce.devices.exampleLabel')}
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">{t('commerce.devices.validity')}</label>
                  <select
                    value={durationDays}
                    onChange={e => setDurationDays(Number(e.target.value))}
                    className="w-full px-4 py-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl text-white text-sm focus:outline-none focus:border-cyan-500 transition-colors"
                  >
                    <option value={30}>{t('commerce.devices.thirtyDays')}</option>
                    <option value={90}>{t('commerce.devices.threeMonths')}</option>
                    <option value={180}>{t('commerce.devices.sixMonths')}</option>
                    <option value={365}>{t('commerce.devices.oneYear')}</option>
                    <option value={730}>{t('commerce.devices.twoYears')}</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-gray-400 rounded-xl text-sm font-medium transition-colors"
                  >
                    {t('commerce.common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={submitting || !deviceId.trim() || !canEnroll}
                    className="flex-1 py-3 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                    {submitting ? t('commerce.devices.generating') : t('commerce.devices.submit')}
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

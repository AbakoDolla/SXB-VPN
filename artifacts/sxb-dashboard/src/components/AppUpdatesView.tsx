import { isSuperAdmin as isSuperAdminRole } from '../lib/roles';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, ShieldCheck, Smartphone, Users, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { fetchCurrentAppUpdate, publishAppUpdate, disableAppUpdate, APP_ROLES, type AppRole, type AppUpdate } from '../api/app-updates';
import { fetchDevices, type Device } from '../api/devices';
import { useTranslation } from '../contexts/I18nContext';

interface AppUpdatesViewProps { currentUserRole: string; }

const initialForm = { versionCode: '', versionName: '', apkUrl: '', apkSha256: '', notes: '', minSupportedCode: '0', forceUpdate: false };

export default function AppUpdatesView({ currentUserRole }: AppUpdatesViewProps) {
  const { t, formatDate, formatNumber, message, errorText } = useTranslation();
  const roleLabels: Record<AppRole, string> = {
    OWNER: t('role_owner'), SUPER_ADMIN: t('role_super_admin'), ADMIN: t('admin'),
    SUPPORT: t('support'), RESELLER: t('reseller'),
  };
  const isSuperAdmin = isSuperAdminRole(currentUserRole);
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [eligibleDeviceCount, setEligibleDeviceCount] = useState(0);
  const [devices, setDevices] = useState<Device[]>([]);
  const [targetRoles, setTargetRoles] = useState<AppRole[]>([...APP_ROLES]);
  const [targetDeviceIds, setTargetDeviceIds] = useState<string[]>([]);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const activeDevices = useMemo(() => devices.filter((device) => device.status === 'active' && device.deviceId), [devices]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [current, registeredDevices] = await Promise.all([fetchCurrentAppUpdate(), fetchDevices()]);
      setUpdate(current.update);
      setEligibleDeviceCount(current.eligibleDeviceCount || 0);
      setDevices(registeredDevices);
      if (current.update) {
        setTargetRoles(current.update.targetRoles.filter((role): role is AppRole => APP_ROLES.includes(role as AppRole)));
        setTargetDeviceIds(current.update.targetDeviceIds);
        setForm({
          versionCode: String(current.update.versionCode),
          versionName: current.update.versionName,
          apkUrl: current.update.apkUrl,
          apkSha256: current.update.apkSha256 || '',
          notes: current.update.notes || '',
          minSupportedCode: String(current.update.minSupportedCode || 0),
          forceUpdate: current.update.forceUpdate,
        });
      }
    } catch (error) {
      toast.error(errorText(error, "operations.updates.loadError"));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleRole = (role: AppRole) => setTargetRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]);
  const toggleDevice = (deviceId: string) => setTargetDeviceIds((current) => current.includes(deviceId) ? current.filter((item) => item !== deviceId) : [...current, deviceId]);
  const selectAllDevices = () => setTargetDeviceIds((current) => current.length === activeDevices.length ? [] : activeDevices.map((device) => device.deviceId));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isSuperAdmin) return;
    setSaving(true);
    try {
      const result = await publishAppUpdate({
        versionCode: Number(form.versionCode),
        versionName: form.versionName.trim(),
        apkUrl: form.apkUrl.trim(),
        apkSha256: form.apkSha256.trim(),
        notes: form.notes.trim(),
        minSupportedCode: Number(form.minSupportedCode || 0),
        forceUpdate: form.forceUpdate,
        targetRoles,
        targetDeviceIds,
        active: true,
      });
      setUpdate(result.update);
      setEligibleDeviceCount(result.eligibleDeviceCount || 0);
      toast.success(message("operations.updates.publishSuccess"));
    } catch (error) {
      toast.error(errorText(error, "operations.updates.publishError"));
    } finally { setSaving(false); }
  };

  const disable = async () => {
    if (!isSuperAdmin || !window.confirm(t("operations.updates.disableConfirm"))) return;
    setSaving(true);
    try { await disableAppUpdate(); setUpdate(null); toast.success(message("operations.updates.disableSuccess")); }
    catch (error) { toast.error(errorText(error, "operations.updates.disableError")); }
    finally { setSaving(false); }
  };

  return <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
    <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
      <div><div className="flex items-center gap-2 text-cyan-400 text-xs uppercase tracking-[0.18em] font-semibold"><Download className="w-4 h-4" /> {t("operations.updates.distribution")}</div><h1 className="text-2xl sm:text-3xl font-bold text-white mt-2">{t("operations.updates.title")}</h1><p className="text-sm text-gray-400 mt-1">{t("operations.updates.description")}</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl border border-[#263149] text-gray-300 hover:text-white hover:border-cyan-500/60 transition-colors disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />{t("operations.common.refresh")}</button>
    </header>

    <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4"><div className="text-xs text-gray-500 uppercase tracking-wider">{t("operations.updates.publishedVersion")}</div><div className="text-xl text-white font-semibold mt-3">{update ? `${update.versionName} · ${update.versionCode}` : t("operations.updates.none")}</div><div className="text-xs text-gray-500 mt-2">{update ? t('operations.updates.since', { date: formatDate(update.publishedAt, { dateStyle: 'short', timeStyle: 'short' }) }) : t("operations.updates.noNotification")}</div></div>
      <div className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4"><div className="text-xs text-gray-500 uppercase tracking-wider">{t("operations.updates.activatedDevices")}</div><div className="text-xl text-white font-semibold mt-3">{formatNumber(eligibleDeviceCount)}</div><div className="text-xs text-emerald-400 mt-2"><Smartphone className="inline w-3.5 h-3.5 mr-1" />{t("operations.updates.eligibleTargets")}</div></div>
      <div className="rounded-2xl border border-[#263149] bg-[#0d1422] p-4"><div className="text-xs text-gray-500 uppercase tracking-wider">{t("operations.updates.visibility")}</div><div className="text-xl text-white font-semibold mt-3">{t("operations.updates.allRoles")}</div><div className="text-xs text-gray-500 mt-2">{t("operations.updates.publishRole")}</div></div>
    </section>

    {!isSuperAdmin && <div className="flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-200"><ShieldCheck className="w-5 h-5 shrink-0 mt-0.5" /><span>{t("operations.updates.readOnlyIntro")}{" "}<strong>{t('role_super_admin')}</strong> {t("operations.updates.readOnlyDetails")}</span></div>}

    <form onSubmit={submit} className="rounded-2xl border border-[#263149] bg-[#0b1220] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#1b2840] flex items-center justify-between"><div><h2 className="text-base font-semibold text-white">{t("operations.updates.release")}</h2><p className="text-xs text-gray-500 mt-1">{t("operations.updates.urlHint")}</p></div>{update && isSuperAdmin && <button type="button" onClick={() => void disable()} disabled={saving} className="inline-flex items-center gap-1.5 text-xs text-rose-300 hover:text-rose-200 disabled:opacity-50"><XCircle className="w-4 h-4" />{t("operations.common.disable")}</button>}</div>
      <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-4"><div className="grid grid-cols-2 gap-3"><label className="text-xs text-gray-300">{t("operations.updates.versionCode")}<input required disabled={!isSuperAdmin} type="number" min="1" value={form.versionCode} onChange={(event) => setForm({ ...form, versionCode: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#070c15] px-3 py-2.5 text-sm text-white disabled:opacity-50" placeholder="19" /></label><label className="text-xs text-gray-300">{t("operations.updates.versionName")}<input required disabled={!isSuperAdmin} value={form.versionName} onChange={(event) => setForm({ ...form, versionName: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#070c15] px-3 py-2.5 text-sm text-white disabled:opacity-50" placeholder="1.9.0" /></label></div><label className="text-xs text-gray-300 block">{t("operations.updates.apkUrl")}<input required disabled={!isSuperAdmin} type="url" value={form.apkUrl} onChange={(event) => setForm({ ...form, apkUrl: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#070c15] px-3 py-2.5 text-sm text-white disabled:opacity-50" placeholder="https://vpnsxb.afrihall.com/download/sxbvpn-latest.apk" /></label><label className="text-xs text-gray-300 block">{t("operations.updates.hash")}<input disabled={!isSuperAdmin} value={form.apkSha256} onChange={(event) => setForm({ ...form, apkSha256: event.target.value })} pattern="^\s*(?:[Ss][Hh][Aa]256:)?[0-9a-fA-F]{64}\s*$|^$" className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#070c15] px-3 py-2.5 text-sm text-white font-mono disabled:opacity-50" placeholder={t("operations.updates.hashPlaceholder")} /><span className="mt-1 block text-[11px] text-gray-500">{t("operations.updates.hashHint")}</span></label><label className="text-xs text-gray-300 block">{t("operations.updates.notes")}<textarea disabled={!isSuperAdmin} rows={4} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#070c15] px-3 py-2.5 text-sm text-white resize-y disabled:opacity-50" placeholder={t("operations.updates.notesPlaceholder")} /></label><label className="flex items-center gap-3 text-sm text-gray-300"><input disabled={!isSuperAdmin} type="checkbox" checked={form.forceUpdate} onChange={(event) => setForm({ ...form, forceUpdate: event.target.checked })} className="accent-cyan-400" />{t("operations.updates.force")}</label></div>
        <div className="space-y-5"><div><div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold text-white flex items-center gap-2"><Users className="w-4 h-4 text-cyan-400" />{t("operations.updates.targetRoles")}</h3><span className="text-xs text-gray-500">{formatNumber(targetRoles.length)}/{formatNumber(APP_ROLES.length)}</span></div><div className="grid grid-cols-2 gap-2">{APP_ROLES.map((role) => <label key={role} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${targetRoles.includes(role) ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-100' : 'border-[#263149] text-gray-500'} ${!isSuperAdmin ? 'opacity-60' : 'cursor-pointer'}`}><input disabled={!isSuperAdmin} type="checkbox" checked={targetRoles.includes(role)} onChange={() => toggleRole(role)} className="accent-cyan-400" />{roleLabels[role]}</label>)}</div></div><div><div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold text-white flex items-center gap-2"><Smartphone className="w-4 h-4 text-cyan-400" />{t("operations.updates.activatedDevices")}</h3><button type="button" disabled={!isSuperAdmin || activeDevices.length === 0} onClick={selectAllDevices} className="text-xs text-cyan-400 hover:text-cyan-200 disabled:opacity-50">{targetDeviceIds.length === activeDevices.length && activeDevices.length > 0 ? t("operations.updates.deselectAll") : t("operations.updates.selectAll")}</button></div><div className="max-h-48 overflow-y-auto space-y-2 pr-1">{activeDevices.length === 0 ? <p className="text-xs text-gray-500 rounded-xl border border-dashed border-[#263149] p-4">{t("operations.updates.noDevices")}</p> : activeDevices.map((device) => <label key={device.deviceId} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs ${targetDeviceIds.includes(device.deviceId) ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-100' : 'border-[#263149] text-gray-400'} ${!isSuperAdmin ? 'opacity-60' : 'cursor-pointer'}`}><input disabled={!isSuperAdmin} type="checkbox" checked={targetDeviceIds.includes(device.deviceId)} onChange={() => toggleDevice(device.deviceId)} className="accent-cyan-400" /><span className="truncate">{device.label || t("operations.common.device")} · {device.deviceId}</span></label>)}</div><p className="text-[11px] text-gray-500 mt-2">{t("operations.updates.deviceHint")}</p></div></div>
      </div>
      {isSuperAdmin && <div className="px-5 py-4 border-t border-[#1b2840] flex justify-end"><button disabled={saving || targetRoles.length === 0} type="submit" className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#06101a] hover:bg-cyan-300 disabled:opacity-50"><Download className="w-4 h-4" />{saving ? t("operations.announcements.publishing") : t("operations.updates.publish")}</button></div>}
    </form>
  </div>;
}

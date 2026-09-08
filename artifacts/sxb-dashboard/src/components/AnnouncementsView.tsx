import { useEffect, useMemo, useState } from 'react';
import { BellRing, Megaphone, Plus, RefreshCw, Send, Trash2, ToggleLeft, ToggleRight, X } from 'lucide-react';
import { Announcement, AnnouncementInput, AnnouncementLevel, createAnnouncement, deleteAnnouncement, fetchAnnouncements, updateAnnouncement } from '../api/announcements';
import { Device, fetchDevices } from '../api/devices';
import { useTranslation } from '../contexts/I18nContext';

const LEVELS: Array<{ value: AnnouncementLevel; label: string; className: string }> = [
  { value: 'info', label: "operations.common.level.info", className: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/20' },
  { value: 'success', label: "operations.common.level.success", className: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  { value: 'warning', label: "operations.common.level.warning", className: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  { value: 'error', label: "operations.common.level.error", className: 'text-rose-300 bg-rose-500/10 border-rose-500/20' },
];

const EMPTY_FORM: AnnouncementInput = { title: '', message: '', level: 'info', active: true, expiresAt: null, targetDeviceId: '' };

const DEVICE_STATUS_LABELS: Record<string, string> = {
  active: 'operations.common.active',
  inactive: 'operations.common.inactive',
  pending: 'operations.common.pending',
  suspended: 'operations.common.suspended',
  expired: 'operations.common.expired',
  revoked: 'operations.common.revoked',
};

function levelStyle(level: AnnouncementLevel) {
  return LEVELS.find(item => item.value === level) || LEVELS[0];
}

export default function AnnouncementsView() {
  const { t, formatDate, formatNumber, errorMessage } = useTranslation();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ cause: unknown; key: string } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [form, setForm] = useState<AnnouncementInput>(EMPTY_FORM);

  const activeCount = useMemo(() => announcements.filter(item => item.active && (!item.expiresAt || new Date(item.expiresAt) > new Date())).length, [announcements]);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [nextAnnouncements, nextDevices] = await Promise.all([fetchAnnouncements(), fetchDevices()]);
      setAnnouncements(nextAnnouncements);
      setDevices(nextDevices);
    } catch (err) { setError({ cause: err, key: 'operations.announcements.loadError' }); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setError(null); setFormOpen(true); };
  const openEdit = (announcement: Announcement) => {
    setEditing(announcement);
    setForm({ title: announcement.title, message: announcement.message, level: announcement.level, active: announcement.active, startsAt: announcement.startsAt, expiresAt: announcement.expiresAt, targetDeviceId: announcement.targetDeviceId || '' });
    setError(null); setFormOpen(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const payload: AnnouncementInput = { ...form, startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : undefined, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null };
      if (editing) await updateAnnouncement(editing.id, payload); else await createAnnouncement(payload);
      setFormOpen(false); await load();
    } catch (err) { setError({ cause: err, key: 'operations.announcements.saveError' }); }
    finally { setSaving(false); }
  };

  const toggle = async (announcement: Announcement) => {
    try { await updateAnnouncement(announcement.id, { active: !announcement.active }); await load(); }
    catch (err) { setError({ cause: err, key: 'operations.announcements.updateError' }); }
  };
  const remove = async (announcement: Announcement) => {
    if (!window.confirm(t('operations.announcements.deleteConfirm', { title: announcement.title }))) return;
    try { await deleteAnnouncement(announcement.id); await load(); }
    catch (err) { setError({ cause: err, key: 'operations.announcements.deleteError' }); }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-cyan-400 text-sm font-medium"><Megaphone className="w-4 h-4" /> {t("operations.announcements.communication")}</div>
          <h1 className="text-2xl font-bold text-white mt-1">{t("operations.announcements.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("operations.announcements.description")}</p>
        </div>
        <div className="flex gap-2">
          <button aria-label={t("operations.common.refresh")} onClick={() => void load()} disabled={loading} className="p-2.5 rounded-xl border border-[#1a1f2e] text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
          <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-[#06101a] font-semibold text-sm rounded-xl transition-colors"><Plus className="w-4 h-4" /> {t("operations.announcements.create")}</button>
        </div>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-4 rounded-2xl bg-[#0d1220] border border-[#1a1f2e]"><p className="text-xs text-gray-500">{t("operations.announcements.publications")}</p><p className="mt-1 text-2xl font-bold text-white">{formatNumber(announcements.length)}</p></div>
        <div className="p-4 rounded-2xl bg-[#0d1220] border border-emerald-500/15"><p className="text-xs text-gray-500">{t("operations.announcements.activeNow")}</p><p className="mt-1 text-2xl font-bold text-emerald-300">{formatNumber(activeCount)}</p></div>
        <div className="p-4 rounded-2xl bg-[#0d1220] border border-[#1a1f2e]"><p className="text-xs text-gray-500">{t("operations.announcements.delivery")}</p><p className="mt-1 text-sm font-semibold text-cyan-300">{t("operations.announcements.appAlerts")}</p></div>
      </section>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{errorMessage(error.cause, error.key)}</div>}

      <section className="rounded-2xl border border-[#1a1f2e] bg-[#0b101b] overflow-hidden">
        {loading ? <div className="p-12 text-center text-gray-500">{t("operations.announcements.loading")}</div> : announcements.length === 0 ? (
          <div className="p-12 text-center"><BellRing className="w-10 h-10 text-gray-600 mx-auto" /><p className="text-white font-medium mt-3">{t("operations.announcements.empty")}</p><p className="text-sm text-gray-500 mt-1">{t("operations.announcements.emptyHint")}</p></div>
        ) : <div className="divide-y divide-[#1a1f2e]">{announcements.map(announcement => {
          const style = levelStyle(announcement.level);
          const expired = !!announcement.expiresAt && new Date(announcement.expiresAt) <= new Date();
          return <article key={announcement.id} className="p-5 flex gap-4 items-start">
            <div className={`p-2.5 rounded-xl border ${style.className}`}><Megaphone className="w-4 h-4" /></div>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-white">{announcement.title}</h2><span className={`text-[11px] px-2 py-0.5 rounded-full border ${style.className}`}>{t(style.label)}</span>{!announcement.active && <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-600 text-gray-400">{t("operations.announcements.disabled")}</span>}{expired && <span className="text-[11px] px-2 py-0.5 rounded-full border border-amber-600/50 text-amber-300">{t("operations.announcements.expired")}</span>}</div><p className="text-sm text-gray-400 mt-1.5 whitespace-pre-wrap">{announcement.message}</p><p className="text-xs text-gray-600 mt-3">{t('operations.announcements.publishedAt', { date: formatDate(announcement.createdAt, { dateStyle: 'short', timeStyle: 'short' }) })}{announcement.expiresAt ? t('operations.announcements.endsAt', { date: formatDate(announcement.expiresAt, { dateStyle: 'short', timeStyle: 'short' }) }) : ''}{announcement.targetDeviceId ? t('operations.announcements.target', { device: announcement.targetDeviceId }) : t("operations.announcements.global")}</p></div>
            <div className="flex shrink-0 gap-1"><button title={announcement.active ? t("operations.common.disable") : t("operations.common.enable")} onClick={() => void toggle(announcement)} className="p-2 text-gray-400 hover:text-cyan-300">{announcement.active ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}</button><button title={t("operations.common.edit")} onClick={() => openEdit(announcement)} className="p-2 text-gray-400 hover:text-white">✎</button><button title={t("operations.common.delete")} onClick={() => void remove(announcement)} className="p-2 text-gray-400 hover:text-rose-300"><Trash2 className="w-4 h-4" /></button></div>
          </article>;
        })}</div>}
      </section>

      {formOpen && <div className="fixed inset-0 z-50 p-4 bg-black/70 backdrop-blur-sm flex items-center justify-center"><form onSubmit={submit} className="w-full max-w-xl rounded-2xl border border-[#263149] bg-[#0d1220] shadow-2xl"><header className="flex items-center justify-between px-5 py-4 border-b border-[#1a1f2e]"><div><h2 className="font-semibold text-white">{editing ? t("operations.announcements.edit") : t("operations.announcements.create")}</h2><p className="text-xs text-gray-500 mt-1">{t("operations.announcements.formHint")}</p></div><button type="button" aria-label={t("operations.common.close")} onClick={() => setFormOpen(false)} className="p-2 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button></header><div className="p-5 space-y-4"><label className="block text-sm text-gray-300">{t("operations.announcements.titleLabel")}<input required maxLength={140} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500" placeholder={t("operations.announcements.titlePlaceholder")} /></label><label className="block text-sm text-gray-300">{t("operations.announcements.message")}<textarea required maxLength={2000} rows={5} value={form.message} onChange={event => setForm({ ...form, message: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500 resize-y" placeholder={t("operations.announcements.messagePlaceholder")} /></label><div className="grid sm:grid-cols-2 gap-4"><label className="block text-sm text-gray-300">{t("operations.announcements.level")}<select value={form.level} onChange={event => setForm({ ...form, level: event.target.value as AnnouncementLevel })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500">{LEVELS.map(level => <option key={level.value} value={level.value}>{t(level.label)}</option>)}</select></label><label className="flex items-center gap-3 pt-7 text-sm text-gray-300"><input type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} className="w-4 h-4 accent-cyan-400" />{t("operations.announcements.deliverNow")}</label></div><div className="grid sm:grid-cols-2 gap-4"><label className="block text-sm text-gray-300">{t("operations.announcements.startsAt")}<input type="datetime-local" value={form.startsAt ? form.startsAt.slice(0, 16) : ''} onChange={event => setForm({ ...form, startsAt: event.target.value ? new Date(event.target.value).toISOString() : undefined })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500" /></label><label className="block text-sm text-gray-300">{t("operations.announcements.expiresAt")}<input type="datetime-local" value={form.expiresAt ? form.expiresAt.slice(0, 16) : ''} onChange={event => setForm({ ...form, expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500" /></label></div><label className="block text-sm text-gray-300">{t("operations.announcements.targetLabel")}<select value={form.targetDeviceId || ''} onChange={event => setForm({ ...form, targetDeviceId: event.target.value || null })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500"><option value="">{t("operations.announcements.allDevices")}</option>{devices.map(device => <option key={device.deviceId || device.id} value={device.deviceId}>{device.label ? `${device.label} — ${device.deviceId}` : `${device.deviceId} — ${t(DEVICE_STATUS_LABELS[device.status] || 'operations.common.unknown')}`}</option>)}</select><span className="block mt-1.5 text-xs text-gray-500">{t("operations.announcements.targetHint")}</span></label></div><footer className="flex justify-end gap-3 p-5 border-t border-[#1a1f2e]"><button type="button" onClick={() => setFormOpen(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">{t("operations.common.cancel")}</button><button disabled={saving} type="submit" className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 text-[#06101a] font-semibold text-sm disabled:opacity-50"><Send className="w-4 h-4" />{saving ? t("operations.announcements.publishing") : editing ? t("operations.common.save") : t("operations.announcements.publish")}</button></footer></form></div>}
    </div>
  );
}

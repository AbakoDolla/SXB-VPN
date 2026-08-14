import { useEffect, useMemo, useState } from 'react';
import { BellRing, Megaphone, Plus, RefreshCw, Send, Trash2, ToggleLeft, ToggleRight, X } from 'lucide-react';
import { Announcement, AnnouncementInput, AnnouncementLevel, createAnnouncement, deleteAnnouncement, fetchAnnouncements, updateAnnouncement } from '../api/announcements';

const LEVELS: Array<{ value: AnnouncementLevel; label: string; className: string }> = [
  { value: 'info', label: 'Information', className: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/20' },
  { value: 'success', label: 'Succès', className: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  { value: 'warning', label: 'Avertissement', className: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  { value: 'error', label: 'Urgent', className: 'text-rose-300 bg-rose-500/10 border-rose-500/20' },
];

const EMPTY_FORM: AnnouncementInput = { title: '', message: '', level: 'info', active: true, expiresAt: null, targetDeviceId: '' };

function levelStyle(level: AnnouncementLevel) {
  return LEVELS.find(item => item.value === level) || LEVELS[0];
}

export default function AnnouncementsView() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [form, setForm] = useState<AnnouncementInput>(EMPTY_FORM);

  const activeCount = useMemo(() => announcements.filter(item => item.active && (!item.expiresAt || new Date(item.expiresAt) > new Date())).length, [announcements]);

  const load = async () => {
    setLoading(true); setError('');
    try { setAnnouncements(await fetchAnnouncements()); }
    catch (err: any) { setError(err?.message || 'Impossible de charger les annonces.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setError(''); setFormOpen(true); };
  const openEdit = (announcement: Announcement) => {
    setEditing(announcement);
    setForm({ title: announcement.title, message: announcement.message, level: announcement.level, active: announcement.active, startsAt: announcement.startsAt, expiresAt: announcement.expiresAt, targetDeviceId: announcement.targetDeviceId || '' });
    setError(''); setFormOpen(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const payload: AnnouncementInput = { ...form, startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : undefined, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null };
      if (editing) await updateAnnouncement(editing.id, payload); else await createAnnouncement(payload);
      setFormOpen(false); await load();
    } catch (err: any) { setError(err?.message || 'Enregistrement impossible.'); }
    finally { setSaving(false); }
  };

  const toggle = async (announcement: Announcement) => {
    try { await updateAnnouncement(announcement.id, { active: !announcement.active }); await load(); }
    catch (err: any) { setError(err?.message || 'Mise à jour impossible.'); }
  };
  const remove = async (announcement: Announcement) => {
    if (!window.confirm(`Supprimer l’annonce « ${announcement.title} » ?`)) return;
    try { await deleteAnnouncement(announcement.id); await load(); }
    catch (err: any) { setError(err?.message || 'Suppression impossible.'); }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-cyan-400 text-sm font-medium"><Megaphone className="w-4 h-4" /> Communication mobile</div>
          <h1 className="text-2xl font-bold text-white mt-1">Annonces</h1>
          <p className="text-sm text-gray-500 mt-1">Publiez des messages réels visibles dans les alertes de toutes les applications actives.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void load()} disabled={loading} className="p-2.5 rounded-xl border border-[#1a1f2e] text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
          <button onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-cyan-400 hover:bg-cyan-300 text-[#06101a] font-semibold text-sm rounded-xl transition-colors"><Plus className="w-4 h-4" /> Nouvelle annonce</button>
        </div>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-4 rounded-2xl bg-[#0d1220] border border-[#1a1f2e]"><p className="text-xs text-gray-500">Publications</p><p className="mt-1 text-2xl font-bold text-white">{announcements.length}</p></div>
        <div className="p-4 rounded-2xl bg-[#0d1220] border border-emerald-500/15"><p className="text-xs text-gray-500">Actives maintenant</p><p className="mt-1 text-2xl font-bold text-emerald-300">{activeCount}</p></div>
        <div className="p-4 rounded-2xl bg-[#0d1220] border border-[#1a1f2e]"><p className="text-xs text-gray-500">Diffusion</p><p className="mt-1 text-sm font-semibold text-cyan-300">Alertes de l’application</p></div>
      </section>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>}

      <section className="rounded-2xl border border-[#1a1f2e] bg-[#0b101b] overflow-hidden">
        {loading ? <div className="p-12 text-center text-gray-500">Chargement des annonces…</div> : announcements.length === 0 ? (
          <div className="p-12 text-center"><BellRing className="w-10 h-10 text-gray-600 mx-auto" /><p className="text-white font-medium mt-3">Aucune annonce publiée</p><p className="text-sm text-gray-500 mt-1">Créez une annonce pour l’afficher dans les alertes mobiles.</p></div>
        ) : <div className="divide-y divide-[#1a1f2e]">{announcements.map(announcement => {
          const style = levelStyle(announcement.level);
          const expired = !!announcement.expiresAt && new Date(announcement.expiresAt) <= new Date();
          return <article key={announcement.id} className="p-5 flex gap-4 items-start">
            <div className={`p-2.5 rounded-xl border ${style.className}`}><Megaphone className="w-4 h-4" /></div>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-white">{announcement.title}</h2><span className={`text-[11px] px-2 py-0.5 rounded-full border ${style.className}`}>{style.label}</span>{!announcement.active && <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-600 text-gray-400">Désactivée</span>}{expired && <span className="text-[11px] px-2 py-0.5 rounded-full border border-amber-600/50 text-amber-300">Expirée</span>}</div><p className="text-sm text-gray-400 mt-1.5 whitespace-pre-wrap">{announcement.message}</p><p className="text-xs text-gray-600 mt-3">Publiée le {new Date(announcement.createdAt).toLocaleString('fr-FR')}{announcement.expiresAt ? ` · fin ${new Date(announcement.expiresAt).toLocaleString('fr-FR')}` : ''}{announcement.targetDeviceId ? ` · cible ${announcement.targetDeviceId}` : ' · diffusion globale'}</p></div>
            <div className="flex shrink-0 gap-1"><button title={announcement.active ? 'Désactiver' : 'Activer'} onClick={() => void toggle(announcement)} className="p-2 text-gray-400 hover:text-cyan-300">{announcement.active ? <ToggleRight className="w-5 h-5" /> : <ToggleLeft className="w-5 h-5" />}</button><button title="Modifier" onClick={() => openEdit(announcement)} className="p-2 text-gray-400 hover:text-white">✎</button><button title="Supprimer" onClick={() => void remove(announcement)} className="p-2 text-gray-400 hover:text-rose-300"><Trash2 className="w-4 h-4" /></button></div>
          </article>;
        })}</div>}
      </section>

      {formOpen && <div className="fixed inset-0 z-50 p-4 bg-black/70 backdrop-blur-sm flex items-center justify-center"><form onSubmit={submit} className="w-full max-w-xl rounded-2xl border border-[#263149] bg-[#0d1220] shadow-2xl"><header className="flex items-center justify-between px-5 py-4 border-b border-[#1a1f2e]"><div><h2 className="font-semibold text-white">{editing ? 'Modifier l’annonce' : 'Nouvelle annonce'}</h2><p className="text-xs text-gray-500 mt-1">Le message sera visible dans les alertes mobiles.</p></div><button type="button" onClick={() => setFormOpen(false)} className="p-2 text-gray-400 hover:text-white"><X className="w-5 h-5" /></button></header><div className="p-5 space-y-4"><label className="block text-sm text-gray-300">Titre<input required maxLength={140} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500" placeholder="Information importante" /></label><label className="block text-sm text-gray-300">Message<textarea required maxLength={2000} rows={5} value={form.message} onChange={event => setForm({ ...form, message: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500 resize-y" placeholder="Rédigez votre annonce…" /></label><div className="grid sm:grid-cols-2 gap-4"><label className="block text-sm text-gray-300">Niveau<select value={form.level} onChange={event => setForm({ ...form, level: event.target.value as AnnouncementLevel })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500">{LEVELS.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}</select></label><label className="flex items-center gap-3 pt-7 text-sm text-gray-300"><input type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} className="w-4 h-4 accent-cyan-400" />Diffuser immédiatement</label></div><div className="grid sm:grid-cols-2 gap-4"><label className="block text-sm text-gray-300">Début (facultatif)<input type="datetime-local" value={form.startsAt ? form.startsAt.slice(0, 16) : ''} onChange={event => setForm({ ...form, startsAt: event.target.value ? new Date(event.target.value).toISOString() : undefined })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500" /></label><label className="block text-sm text-gray-300">Fin (facultative)<input type="datetime-local" value={form.expiresAt ? form.expiresAt.slice(0, 16) : ''} onChange={event => setForm({ ...form, expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500" /></label></div><label className="block text-sm text-gray-300">Cibler un Device ID spécifique (laisser vide pour tout le monde)<input type="text" value={form.targetDeviceId || ''} onChange={event => setForm({ ...form, targetDeviceId: event.target.value.trim() || null })} className="mt-1.5 w-full rounded-xl border border-[#263149] bg-[#080c14] px-3 py-2.5 text-white outline-none focus:border-cyan-500 font-mono text-xs" placeholder="Ex: SXB-USER-AGW3-V41E-M65M (laisser vide = broadcast global)" /></label></div><footer className="flex justify-end gap-3 p-5 border-t border-[#1a1f2e]"><button type="button" onClick={() => setFormOpen(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Annuler</button><button disabled={saving} type="submit" className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 text-[#06101a] font-semibold text-sm disabled:opacity-50"><Send className="w-4 h-4" />{saving ? 'Publication…' : editing ? 'Enregistrer' : 'Publier'}</button></footer></form></div>}
    </div>
  );
}

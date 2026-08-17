import React, { useState, useEffect, useCallback } from "react";
import { Megaphone, Search, Plus, RefreshCw, Send, Trash2, Clock, AlertTriangle, Inbox, CheckCircle2, X } from "lucide-react";
import { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement, Announcement } from "../api/announcements";

const TYPE_COLORS = {
  info: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
  warning: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  success: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  critical: "text-rose-400 bg-rose-500/10 border-rose-500/20",
};

const TYPE_LABELS: Record<string, string> = {
  info: "Information",
  warning: "Avertissement",
  success: "Succès",
  critical: "Critique / Pop-up",
};

export default function AnnouncementsView() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [type, setType] = useState<Announcement['type']>("info");
  const [target, setTarget] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAnnouncements();
      setAnnouncements(data);
    } catch (err) {
      setError("Impossible de charger les annonces.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !content) return;
    setSubmitting(true);
    setError(null);

    try {
      const newAnn = await createAnnouncement({
        title,
        content,
        type,
        target: target.trim() || null,
        expiresAt: expiresAt || null,
        isActive: true
      });
      setAnnouncements((prev) => [newAnn, ...prev]);
      resetForm();
      setShowAddModal(false);
    } catch (err: any) {
      setError("Erreur lors de la création de l'annonce");
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setTitle("");
    setContent("");
    setType("info");
    setTarget("");
    setExpiresAt("");
  };

  const handleToggleActive = async (id: string, current: boolean) => {
    try {
      const updated = await updateAnnouncement(id, { isActive: !current });
      setAnnouncements((prev) => prev.map((a) => (a.id === id ? updated : a)));
    } catch (err) {
      setError("Erreur lors de la mise à jour");
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Supprimer cette annonce ?")) return;
    try {
      await deleteAnnouncement(id);
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError("Erreur lors de la suppression");
    }
  };

  const filtered = announcements.filter((a) =>
    a.title.toLowerCase().includes(search.toLowerCase()) ||
    a.content.toLowerCase().includes(search.toLowerCase()) ||
    (a.target || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-cyan-400" />
            Annonces & Notifications
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Envoyez des messages ou des pop-ups ciblés aux utilisateurs de l'application.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          Nouvelle Annonce
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-rose-400/60 hover:text-rose-400">✕</button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
          <input
            type="text"
            placeholder="Rechercher une annonce..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          />
        </div>
        <button onClick={loadData} className="p-2 rounded-lg bg-gray-900 border border-gray-800 text-gray-400 hover:text-white cursor-pointer" title="Actualiser">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <RefreshCw className="h-7 w-7 animate-spin text-cyan-400 mb-4" />
          <p className="text-sm font-mono">Chargement des annonces...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="border border-dashed border-gray-800 rounded-xl p-12 text-center bg-gray-950/10">
          <Inbox className="h-12 w-12 text-gray-700 mx-auto mb-4" />
          <h3 className="text-base font-semibold text-white">Aucune annonce</h3>
          <p className="text-sm text-gray-500 mt-1">Créez votre première annonce pour les utilisateurs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((ann) => (
            <div
              key={ann.id}
              className={`p-4 rounded-xl border transition-all ${
                ann.isActive ? 'bg-gray-950/20 border-gray-800/60' : 'bg-gray-900/10 border-gray-900 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${TYPE_COLORS[ann.type]}`}>
                      {TYPE_LABELS[ann.type]}
                    </span>
                    {!ann.isActive && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-gray-800 text-gray-400 border border-gray-700">
                        Inactif
                      </span>
                    )}
                    {ann.target && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        Ciblé : {ann.target.slice(0, 8)}...
                      </span>
                    )}
                  </div>
                  <h3 className="text-sm font-bold text-white truncate">{ann.title}</h3>
                  <p className="text-xs text-gray-400 mt-1 line-clamp-3 leading-relaxed">{ann.content}</p>
                  <div className="flex items-center gap-3 mt-3 text-[10px] text-gray-500">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(ann.createdAt).toLocaleDateString()}
                    </span>
                    {ann.expiresAt && (
                      <span className={`flex items-center gap-1 ${new Date(ann.expiresAt) < new Date() ? 'text-rose-400' : ''}`}>
                        <AlertTriangle className="h-3 w-3" />
                        Expire : {new Date(ann.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => handleToggleActive(ann.id, ann.isActive)}
                    className={`p-2 rounded-lg border transition-colors cursor-pointer ${
                      ann.isActive ? 'bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/20' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20'
                    }`}
                    title={ann.isActive ? "Désactiver" : "Activer"}
                  >
                    {ann.isActive ? <X className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => handleDelete(ann.id)}
                    className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-colors cursor-pointer"
                    title="Supprimer"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className="w-full max-w-lg bg-[#0a0d14] border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Megaphone className="h-5 w-5 text-cyan-400" />
                Créer une Annonce
              </h2>
              <button onClick={() => setShowAddModal(false)} className="text-gray-500 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Titre</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-900/50 border border-gray-800 rounded-xl text-white focus:outline-none focus:border-cyan-500 transition-colors"
                    placeholder="ex: Maintenance prévue, Promo Forfait..."
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Type / Style</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as any)}
                    className="w-full px-4 py-2.5 bg-gray-900/50 border border-gray-800 rounded-xl text-white focus:outline-none focus:border-cyan-500 transition-colors"
                  >
                    <option value="info">Information (Bleu)</option>
                    <option value="warning">Avertissement (Orange)</option>
                    <option value="success">Succès (Vert)</option>
                    <option value="critical">Critique / Pop-up (Rouge)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Expiration (optionnel)</label>
                  <input
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-900/50 border border-gray-800 rounded-xl text-white focus:outline-none focus:border-cyan-500 transition-colors"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Ciblage Device ID (laisser vide pour TOUS)</label>
                  <input
                    type="text"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-900/50 border border-gray-800 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-cyan-500 transition-colors"
                    placeholder="ex: 8f2a3b..."
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-2">Contenu du message</label>
                  <textarea
                    required
                    rows={4}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-900/50 border border-gray-800 rounded-xl text-white focus:outline-none focus:border-cyan-500 transition-colors resize-none"
                    placeholder="Votre message ici..."
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-3 bg-gray-900 text-gray-400 font-bold rounded-xl hover:bg-gray-800 transition-colors cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-[2] flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-bold rounded-xl hover:from-cyan-600 hover:to-blue-700 transition-all disabled:opacity-50 cursor-pointer shadow-lg shadow-cyan-900/20"
                >
                  {submitting ? <RefreshCw className="h-5 w-5 animate-spin" /> : <><Send className="h-5 w-5" /> Publier l'Annonce</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

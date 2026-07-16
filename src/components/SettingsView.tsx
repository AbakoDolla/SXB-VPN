import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import {
  Settings, Globe, Shield, RefreshCw, Key, Users, Copy,
  CheckCheck, KeyRound, Camera, User, Phone, Mail, Save,
  Upload, X,
} from "lucide-react";
import { fetchRoles } from "../api/permissions";
import { apiRequest } from "../api/client";

interface GeneratedCreds { name: string; email: string; password: string; role: string; }

function CredentialsModal({ credentials, onClose }: { credentials: GeneratedCreds; onClose: () => void }) {
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);
  const copy = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text).then(() => { setter(true); setTimeout(() => setter(false), 2000); });
  };
  const copyAll = () => navigator.clipboard.writeText(
    `Dashboard SXB VPN\nURL: https://vpnsxb.afrihall.com\nNom: ${credentials.name}\nEmail: ${credentials.email}\nMot de passe: ${credentials.password}\nRôle: ${credentials.role}`
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-md p-6 bg-[#0a0d14] border border-[#1a2535] rounded-2xl shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <KeyRound className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Compte {credentials.role} créé</h2>
            <p className="text-xs text-gray-400">Transmettez ces identifiants à l'utilisateur</p>
          </div>
        </div>
        <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
          ⚠️ Le mot de passe ne sera plus affiché après fermeture. Copiez-le maintenant.
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Email</label>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-cyan-400 font-mono">{credentials.email}</div>
              <button onClick={() => copy(credentials.email, setCopiedEmail)} className="px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white cursor-pointer">
                {copiedEmail ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Mot de passe</label>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 bg-[#0f1218] border border-emerald-500/30 rounded-lg text-sm text-emerald-400 font-mono font-bold tracking-wide">{credentials.password}</div>
              <button onClick={() => copy(credentials.password, setCopiedPass)} className="px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white cursor-pointer">
                {copiedPass ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">URL Dashboard</label>
            <div className="px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-gray-300 font-mono">https://vpnsxb.afrihall.com</div>
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button onClick={copyAll} className="flex-1 py-2 text-xs font-semibold rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 cursor-pointer flex items-center justify-center gap-1.5">
            <Copy size={12} /> Tout copier
          </button>
          <button onClick={onClose} className="flex-1 py-2 text-xs font-semibold rounded-xl bg-cyan-500 text-black hover:bg-cyan-400 cursor-pointer">Fermer</button>
        </div>
      </div>
    </div>
  );
}

interface SettingsViewProps {
  currentUser: any;
  onUserUpdated?: (user: any) => void;
}

export default function SettingsView({ currentUser, onUserUpdated }: SettingsViewProps) {
  const { t, language, setLanguage } = useTranslation();

  // Profile state
  const [profileName, setProfileName] = useState(currentUser?.name || "");
  const [profilePhone, setProfilePhone] = useState(currentUser?.phone || "");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState("");

  // Avatar state
  const [avatarUrl, setAvatarUrl] = useState<string | null>(currentUser?.avatarUrl || null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Team creation state
  const [roles, setRoles] = useState<any[]>([]);
  const [teamForm, setTeamForm] = useState({ name: "", email: "", phone: "", role: "", password: "" });
  const [autoGen, setAutoGen] = useState(true);
  const [teamCreating, setTeamCreating] = useState(false);
  const [teamError, setTeamError] = useState("");
  const [createdCreds, setCreatedCreds] = useState<GeneratedCreds | null>(null);

  useEffect(() => {
    fetchRoles().then(r => setRoles(r.filter(role => !["SUPER_ADMIN"].includes(role.name))));
  }, []);

  // ── Avatar handlers ───────────────────────────────────────────────────
  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setAvatarPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleAvatarUpload = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const formData = new FormData();
      formData.append("avatar", file);
      const token = localStorage.getItem("accessToken");
      const res = await fetch("/api/users/me/avatar", {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: formData,
      });
      if (!res.ok) throw new Error("Upload échoué");
      const data = await res.json();
      setAvatarUrl(data.avatarUrl);
      setAvatarPreview(null);
      if (onUserUpdated && data.user) onUserUpdated(data.user);
    } catch (err: any) {
      alert("Erreur upload: " + err.message);
    } finally {
      setAvatarUploading(false);
    }
  };

  const cancelAvatarPreview = () => {
    setAvatarPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Profile save ──────────────────────────────────────────────────────
  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSaving(true);
    setProfileError("");
    try {
      const data = await apiRequest<any>("/users/me", {
        method: "PATCH",
        body: { name: profileName, phone: profilePhone },
      });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 3000);
      if (onUserUpdated && data.user) onUserUpdated(data.user);
    } catch (err: any) {
      setProfileError(err.message || "Erreur de sauvegarde");
    } finally {
      setProfileSaving(false);
    }
  };

  // ── Team member creation ──────────────────────────────────────────────
  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    setTeamCreating(true);
    setTeamError("");
    try {
      const result = await apiRequest<any>("/users", {
        method: "POST",
        body: {
          name: teamForm.name,
          email: teamForm.email,
          phone: teamForm.phone || undefined,
          role: teamForm.role,
          password: autoGen ? undefined : teamForm.password || undefined,
        },
      });
      setCreatedCreds({
        name: result.name || teamForm.name,
        email: result.email || teamForm.email,
        role: result.role?.name || teamForm.role,
        password: result.generatedPassword || teamForm.password || "—",
      });
      setTeamForm({ name: "", email: "", phone: "", role: "", password: "" });
    } catch (err: any) {
      setTeamError(err.message || err.error || "Erreur de création");
    } finally {
      setTeamCreating(false);
    }
  };

  const displayAvatar = avatarPreview || avatarUrl;
  const initials = (currentUser?.name || "?").charAt(0).toUpperCase();

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {createdCreds && <CredentialsModal credentials={createdCreds} onClose={() => setCreatedCreds(null)} />}

      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">{t("settings.title")}</h1>
        <p className="text-sm text-gray-400 mt-1">{t("settings.subtitle")}</p>
      </div>

      {/* ── Profile Section ── */}
      <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 space-y-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
          <User className="h-4 w-4 text-cyan-400" />
          Profil & Photo
        </div>

        {/* Avatar Upload */}
        <div className="flex items-start gap-5">
          <div className="relative shrink-0">
            {displayAvatar ? (
              <img src={displayAvatar} alt="Avatar" className="w-20 h-20 rounded-2xl object-cover border-2 border-gray-700" />
            ) : (
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center border-2 border-gray-700">
                <span className="text-white text-3xl font-bold">{initials}</span>
              </div>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="absolute -bottom-2 -right-2 w-7 h-7 rounded-full bg-cyan-500 hover:bg-cyan-400 flex items-center justify-center shadow-lg transition-colors cursor-pointer"
              title="Changer la photo"
            >
              <Camera className="w-3.5 h-3.5 text-black" />
            </button>
          </div>

          <div className="flex-1 space-y-2">
            <div>
              <p className="text-sm font-semibold text-white">{currentUser?.name}</p>
              <p className="text-xs text-gray-400">{currentUser?.email}</p>
              <span className="inline-block mt-1 text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-semibold">{currentUser?.role}</span>
            </div>

            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarSelect} />

            {avatarPreview && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAvatarUpload}
                  disabled={avatarUploading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                >
                  {avatarUploading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                  {avatarUploading ? "Upload..." : "Enregistrer"}
                </button>
                <button onClick={cancelAvatarPreview} className="p-1.5 text-gray-500 hover:text-rose-400 cursor-pointer">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {!avatarPreview && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors cursor-pointer"
              >
                <Camera className="w-3 h-3" /> Changer la photo
              </button>
            )}
          </div>
        </div>

        {/* Profile form */}
        <form onSubmit={handleProfileSave} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1.5 flex items-center gap-1"><User className="w-3 h-3" /> Nom complet</label>
            <input
              type="text"
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
              placeholder="Votre nom"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1.5 flex items-center gap-1"><Phone className="w-3 h-3" /> Téléphone</label>
            <input
              type="tel"
              value={profilePhone}
              onChange={e => setProfilePhone(e.target.value)}
              className="w-full px-3 py-2.5 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
              placeholder="+33 6 00 00 00 00"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-gray-400 mb-1.5 flex items-center gap-1"><Mail className="w-3 h-3" /> Email (non modifiable)</label>
            <input
              type="email"
              value={currentUser?.email || ""}
              readOnly
              className="w-full px-3 py-2.5 bg-gray-900/40 border border-gray-800/50 rounded-xl text-sm text-gray-500 cursor-not-allowed"
            />
          </div>
          {profileError && <p className="sm:col-span-2 text-xs text-rose-400">{profileError}</p>}
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={profileSaving}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl bg-cyan-500 text-black hover:bg-cyan-400 disabled:opacity-50 cursor-pointer transition-colors"
            >
              {profileSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {profileSaved ? "✓ Sauvegardé !" : profileSaving ? "Sauvegarde..." : "Sauvegarder le profil"}
            </button>
          </div>
        </form>
      </div>

      {/* ── Language Section ── */}
      <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
          <Globe className="h-4 w-4 text-cyan-400" />
          {t("settings.sections.language_selection")}
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={() => setLanguage("fr")}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-xl border flex items-center justify-center gap-2 cursor-pointer transition-all ${language === "fr" ? "bg-cyan-950 text-cyan-400 border-cyan-500/50" : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"}`}>
            🇫🇷 Français
          </button>
          <button type="button" onClick={() => setLanguage("en")}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-xl border flex items-center justify-center gap-2 cursor-pointer transition-all ${language === "en" ? "bg-cyan-950 text-cyan-400 border-cyan-500/50" : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"}`}>
            🇬🇧 English
          </button>
        </div>
      </div>

      {/* ── Create Team Member ── */}
      <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
          <Users className="h-4 w-4 text-violet-400" />
          Créer un membre d'équipe
        </div>
        <form onSubmit={handleCreateTeam} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Nom complet</label>
              <input type="text" required value={teamForm.name} onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white focus:outline-none focus:border-cyan-500"
                placeholder="Ex: Jean Dupont" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Email</label>
              <input type="email" required value={teamForm.email} onChange={e => setTeamForm(f => ({ ...f, email: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white focus:outline-none focus:border-cyan-500"
                placeholder="jean@exemple.com" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Téléphone (optionnel)</label>
              <input type="tel" value={teamForm.phone} onChange={e => setTeamForm(f => ({ ...f, phone: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white focus:outline-none focus:border-cyan-500"
                placeholder="+33 6 00 00 00 00" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Rôle</label>
              <select required value={teamForm.role} onChange={e => setTeamForm(f => ({ ...f, role: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white focus:outline-none focus:border-cyan-500 cursor-pointer">
                <option value="">-- Sélectionner un rôle --</option>
                {roles.map(r => <option key={r.id} value={r.name}>{r.name} {r.description ? `— ${r.description}` : ""}</option>)}
              </select>
            </div>
          </div>

          {/* Password */}
          <div className="flex items-center gap-3">
            <input type="checkbox" checked={autoGen} onChange={e => setAutoGen(e.target.checked)} id="autoGenPw" className="rounded" />
            <label htmlFor="autoGenPw" className="text-xs text-gray-400 cursor-pointer">Générer un mot de passe automatiquement</label>
          </div>
          {!autoGen && (
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Mot de passe (min. 6 caractères)</label>
              <input type="password" value={teamForm.password} onChange={e => setTeamForm(f => ({ ...f, password: e.target.value }))} minLength={6}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white focus:outline-none focus:border-cyan-500"
                placeholder="••••••••••" />
            </div>
          )}

          {teamError && <p className="text-xs text-rose-400 bg-rose-500/10 px-3 py-2 rounded-lg border border-rose-500/20">{teamError}</p>}
          <button type="submit" disabled={teamCreating || !teamForm.name || !teamForm.email || !teamForm.role}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-xl bg-violet-500 text-white hover:bg-violet-400 disabled:opacity-50 cursor-pointer transition-colors">
            {teamCreating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
            {teamCreating ? "Création..." : "Créer le compte"}
          </button>
        </form>
      </div>

      {/* ── Security Info ── */}
      <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
          <Shield className="h-4 w-4 text-emerald-400" />
          Sécurité
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          {[
            { label: "Dashboard", value: "https://vpnsxb.afrihall.com", color: "text-cyan-400" },
            { label: "API Backend", value: "https://vpnsxb.afrihall.com/api", color: "text-purple-400" },
            { label: "Session", value: "JWT · 15min + Refresh 7j", color: "text-amber-400" },
          ].map(item => (
            <div key={item.label} className="p-3 bg-gray-900/60 rounded-lg border border-gray-800/50">
              <p className="text-gray-500 mb-0.5">{item.label}</p>
              <p className={`font-mono font-medium ${item.color} break-all`}>{item.value}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

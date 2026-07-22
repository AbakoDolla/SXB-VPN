import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import {
  Settings, Globe, Shield, RefreshCw, Key, Users, Copy,
  CheckCheck, KeyRound, Camera, User, Phone, Mail, Save,
  Upload, X, Bell, Database, Wrench, Server, Code, Lock,
} from "lucide-react";
import { fetchRoles } from "../api/permissions";
import { apiRequest } from "../api/client";
import { listAdminTokens, generateAdminToken, revokeAdminToken } from "../api/accounts";

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
          {[
            { label: "Email", value: credentials.email, copied: copiedEmail, setter: setCopiedEmail },
            { label: "Mot de passe", value: credentials.password, copied: copiedPass, setter: setCopiedPass },
          ].map(({ label, value, copied, setter }) => (
            <div key={label}>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">{label}</label>
              <div className="flex gap-2">
                <div className="flex-1 px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-cyan-400 font-mono truncate">{value}</div>
                <button onClick={() => copy(value, setter)} className="px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white cursor-pointer shrink-0">
                  {copied ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          ))}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">URL Dashboard</label>
            <div className="px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-gray-300 font-mono">https://vpnsxb.afrihall.com</div>
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <button onClick={copyAll} className="flex-1 py-2 text-xs font-semibold rounded-xl bg-[#0f1218] border border-[#1a1f2e] text-gray-300 hover:text-white cursor-pointer flex items-center justify-center gap-1.5">
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

const TABS = [
  { id: "profile", label: "Profil", icon: User },
  { id: "team", label: "Équipe", icon: Users },
  { id: "security", label: "Sécurité", icon: Shield },
  { id: "api", label: "API & Tokens", icon: Key },
  { id: "language", label: "Langue & Région", icon: Globe },
];

export default function SettingsView({ currentUser, onUserUpdated }: SettingsViewProps) {
  const { t, language, setLanguage } = useTranslation();
  const [activeTab, setActiveTab] = useState("profile");

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

  // Team state
  const [roles, setRoles] = useState<any[]>([]);
  const [teamForm, setTeamForm] = useState({ name: "", email: "", phone: "", role: "", password: "" });
  const [autoGen, setAutoGen] = useState(true);
  const [teamCreating, setTeamCreating] = useState(false);
  const [teamError, setTeamError] = useState("");
  const [createdCreds, setCreatedCreds] = useState<GeneratedCreds | null>(null);

  // Admin tokens state
  const [adminTokens, setAdminTokens] = useState<any[]>([]);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenGen, setTokenGen] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  useEffect(() => {
    fetchRoles().then(r => setRoles(r.filter((role: any) => !["SUPER_ADMIN"].includes(role.name))));
    loadAdminTokens();
  }, []);

  const loadAdminTokens = async () => {
    setTokenLoading(true);
    try {
      const data = await listAdminTokens();
      setAdminTokens(Array.isArray(data) ? data : data.tokens || []);
    } catch { /* ignore */ } finally { setTokenLoading(false); }
  };

  // Avatar handlers
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
      const token = localStorage.getItem("sxb_access_token");
      const res = await fetch("/xapi/users/me/avatar", {
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
      setTimeout(() => setProfileSaved(false), 2000);
      if (onUserUpdated) onUserUpdated(data.user || data);
    } catch (err: any) {
      setProfileError(err.message || "Erreur lors de la sauvegarde");
    } finally {
      setProfileSaving(false);
    }
  };

  const handleTeamCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setTeamCreating(true);
    setTeamError("");
    try {
      const genPass = autoGen ? Math.random().toString(36).slice(-10).toUpperCase() + "!" : teamForm.password;
      const data = await apiRequest<any>("/users", {
        method: "POST",
        body: { name: teamForm.name, email: teamForm.email, phone: teamForm.phone, role: teamForm.role, password: genPass },
      });
      setCreatedCreds({ name: teamForm.name, email: teamForm.email, password: genPass, role: teamForm.role });
      setTeamForm({ name: "", email: "", phone: "", role: "", password: "" });
    } catch (err: any) {
      setTeamError(err.message || "Erreur lors de la création");
    } finally {
      setTeamCreating(false);
    }
  };

  const handleGenerateToken = async () => {
    setTokenGen(true);
    try {
      await generateAdminToken(currentUser.id, 168); // 7 days
      await loadAdminTokens();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setTokenGen(false);
    }
  };

  const handleRevokeToken = async (id: string) => {
    if (!confirm("Révoquer ce token ? Il ne pourra plus être utilisé.")) return;
    try {
      await revokeAdminToken(id);
      await loadAdminTokens();
    } catch { alert("Erreur lors de la révocation"); }
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const sectionClass = "bg-[#0a0d14] border border-[#1a1f2e] rounded-xl p-5";
  const labelClass = "block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider";
  const inputClass = "w-full px-3 py-2.5 text-sm bg-[#07090e] border border-[#1a1f2e] rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40";

  return (
    <div className="space-y-5 max-w-3xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Settings className="w-5 h-5 text-gray-400" />
          <h1 className="text-xl font-bold text-white">Paramètres</h1>
        </div>
        <p className="text-xs text-gray-500">Gérez votre compte, votre équipe et vos préférences</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-[#0a0d14] border border-[#1a1f2e] rounded-xl p-1 overflow-x-auto">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                activeTab === tab.id ? 'bg-[#0f1218] text-white border border-[#252b3b]' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Profile tab */}
      {activeTab === "profile" && (
        <div className="space-y-4">
          <div className={sectionClass}>
            <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2"><User className="w-4 h-4 text-cyan-400" />Informations personnelles</h3>
            {/* Avatar */}
            <div className="flex items-center gap-4 mb-5 pb-5 border-b border-[#1a1f2e]">
              <div className="relative">
                <div className="w-14 h-14 rounded-xl bg-[#0f1218] border border-[#1a1f2e] overflow-hidden flex items-center justify-center">
                  {(avatarPreview || avatarUrl) ? (
                    <img src={avatarPreview || avatarUrl!} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xl font-bold text-gray-400">{currentUser?.name?.charAt(0).toUpperCase()}</span>
                  )}
                </div>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-white">{currentUser?.name}</p>
                <p className="text-xs text-gray-500">{currentUser?.email}</p>
                {avatarPreview ? (
                  <div className="flex gap-2 mt-2">
                    <button onClick={handleAvatarUpload} disabled={avatarUploading} className="text-xs px-3 py-1.5 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded-lg hover:bg-cyan-500/30 cursor-pointer flex items-center gap-1 disabled:opacity-50">
                      {avatarUploading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                      Enregistrer
                    </button>
                    <button onClick={cancelAvatarPreview} className="text-xs px-3 py-1.5 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-gray-400 hover:text-white cursor-pointer">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <button onClick={() => fileInputRef.current?.click()} className="mt-2 text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer flex items-center gap-1">
                    <Camera className="w-3 h-3" /> Changer la photo
                  </button>
                )}
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarSelect} />
              </div>
            </div>
            {/* Profile form */}
            <form onSubmit={handleProfileSave} className="space-y-4">
              <div>
                <label className={labelClass}>Nom complet</label>
                <input value={profileName} onChange={e => setProfileName(e.target.value)} type="text" className={inputClass} placeholder="Votre nom" />
              </div>
              <div>
                <label className={labelClass}>Email</label>
                <input value={currentUser?.email || ""} type="email" className={inputClass + " opacity-60 cursor-not-allowed"} disabled />
              </div>
              <div>
                <label className={labelClass}>Téléphone</label>
                <input value={profilePhone} onChange={e => setProfilePhone(e.target.value)} type="tel" className={inputClass} placeholder="+225 07 XX XX XX" />
              </div>
              {profileError && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{profileError}</p>}
              <button type="submit" disabled={profileSaving} className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black transition-all disabled:opacity-60 cursor-pointer">
                {profileSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : profileSaved ? <CheckCheck className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                {profileSaved ? "Sauvegardé !" : "Enregistrer"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Team tab */}
      {activeTab === "team" && (
        <div className={sectionClass}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2"><Users className="w-4 h-4 text-cyan-400" />Créer un membre d'équipe</h3>
          <form onSubmit={handleTeamCreate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Nom complet *</label>
                <input value={teamForm.name} onChange={e => setTeamForm(f => ({ ...f, name: e.target.value }))} type="text" className={inputClass} placeholder="Jean Dupont" required />
              </div>
              <div>
                <label className={labelClass}>Email *</label>
                <input value={teamForm.email} onChange={e => setTeamForm(f => ({ ...f, email: e.target.value }))} type="email" className={inputClass} placeholder="jean@example.com" required />
              </div>
              <div>
                <label className={labelClass}>Téléphone</label>
                <input value={teamForm.phone} onChange={e => setTeamForm(f => ({ ...f, phone: e.target.value }))} type="tel" className={inputClass} placeholder="+225 07 XX XX XX" />
              </div>
              <div>
                <label className={labelClass}>Rôle *</label>
                <select value={teamForm.role} onChange={e => setTeamForm(f => ({ ...f, role: e.target.value }))} className={inputClass} required>
                  <option value="">Choisir un rôle</option>
                  {roles.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-400">
                  <input type="checkbox" checked={autoGen} onChange={e => setAutoGen(e.target.checked)} className="rounded border-[#1a1f2e] bg-[#07090e] accent-cyan-500" />
                  Générer le mot de passe automatiquement
                </label>
              </div>
              {!autoGen && (
                <input value={teamForm.password} onChange={e => setTeamForm(f => ({ ...f, password: e.target.value }))} type="password" className={inputClass} placeholder="Mot de passe" required />
              )}
            </div>
            {teamError && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{teamError}</p>}
            <button type="submit" disabled={teamCreating} className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black transition-all disabled:opacity-60 cursor-pointer">
              {teamCreating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Users className="w-3.5 h-3.5" />}
              Créer le compte
            </button>
          </form>
          {createdCreds && <CredentialsModal credentials={createdCreds} onClose={() => setCreatedCreds(null)} />}
        </div>
      )}

      {/* Security tab */}
      {activeTab === "security" && (
        <div className={sectionClass}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2"><Lock className="w-4 h-4 text-cyan-400" />Sécurité du compte</h3>
          <div className="space-y-3">
            {[
              { label: "Authentification JWT", desc: "Tokens Bearer avec expiration automatique", status: "actif", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
              { label: "Refresh Token", desc: "Renouvellement automatique de session", status: "actif", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
              { label: "Contrôle d'accès RBAC", desc: "Permissions basées sur les rôles", status: "actif", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
              { label: "Chiffrement des données", desc: "Mots de passe hashés (bcrypt)", status: "actif", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
            ].map(item => (
              <div key={item.label} className="flex items-center justify-between p-4 bg-[#07090e] border border-[#1a1f2e] rounded-xl">
                <div>
                  <p className="text-sm font-medium text-white">{item.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                </div>
                <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${item.color}`}>{item.status}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-400">
            💡 Pour changer votre mot de passe, contactez votre Super Admin ou utilisez la procédure de réinitialisation.
          </div>
        </div>
      )}

      {/* API Tokens tab */}
      {activeTab === "api" && (
        <div className="space-y-4">
          <div className={sectionClass}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Key className="w-4 h-4 text-cyan-400" />Tokens Admin</h3>
              <button
                onClick={handleGenerateToken}
                disabled={tokenGen}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-all disabled:opacity-50 cursor-pointer"
              >
                {tokenGen ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
                Générer un token
              </button>
            </div>
            {tokenLoading ? (
              <div className="py-6 flex justify-center"><RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" /></div>
            ) : adminTokens.length === 0 ? (
              <div className="py-8 text-center text-gray-600">
                <Key className="w-6 h-6 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Aucun token admin actif</p>
              </div>
            ) : (
              <div className="space-y-2">
                {adminTokens.map((token: any) => (
                  <div key={token.id} className="flex items-center gap-3 p-3 bg-[#07090e] border border-[#1a1f2e] rounded-xl">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-cyan-400 truncate">{token.token}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className={`text-[10px] font-medium ${token.status === 'active' ? 'text-emerald-400' : 'text-gray-500'}`}>
                          ● {token.status === 'active' ? 'Actif' : 'Révoqué'}
                        </span>
                        {token.usedAt && <span className="text-[10px] text-gray-600">Utilisé le {new Date(token.usedAt).toLocaleDateString('fr-FR')}</span>}
                        <span className="text-[10px] text-gray-600">Créé le {new Date(token.createdAt).toLocaleDateString('fr-FR')}</span>
                      </div>
                    </div>
                    <button onClick={() => copyToken(token.token)} className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 cursor-pointer">
                      {copiedToken === token.token ? <CheckCheck className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    {token.status === 'active' && (
                      <button onClick={() => handleRevokeToken(token.id)} className="p-1.5 rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Language tab */}
      {activeTab === "language" && (
        <div className={sectionClass}>
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2"><Globe className="w-4 h-4 text-cyan-400" />Langue & Région</h3>
          <div className="grid grid-cols-2 gap-3">
            {[{ code: 'fr', label: 'Français', flag: '🇫🇷' }, { code: 'en', label: 'English', flag: '🇬🇧' }].map(lang => (
              <button
                key={lang.code}
                onClick={() => setLanguage(lang.code as 'fr' | 'en')}
                className={`flex items-center gap-3 p-4 rounded-xl border text-left transition-all cursor-pointer ${
                  language === lang.code
                    ? 'bg-cyan-500/15 border-cyan-500/30 text-white'
                    : 'bg-[#07090e] border-[#1a1f2e] text-gray-400 hover:text-white hover:border-[#252b3b]'
                }`}
              >
                <span className="text-2xl">{lang.flag}</span>
                <div>
                  <p className="text-sm font-semibold">{lang.label}</p>
                  {language === lang.code && <p className="text-[10px] text-cyan-400">Actif</p>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

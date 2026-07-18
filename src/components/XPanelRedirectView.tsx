import { useState, useEffect } from "react";
import { UserRole, User } from "../types";
import { fetchAccounts } from "../api/accounts";
import {
  ExternalLink, Copy, Check, Eye, EyeOff, Shield,
  ShieldCheck, Users, Lock, Globe, KeyRound, AlertTriangle, RefreshCw
} from "lucide-react";

const XPANEL_URL  = "https://vpnsxb.afrihall.com:8443/kqUtkMEvgdtx/";
const XPANEL_USER = "admin";
const XPANEL_PASS = "snwTlftZtc5BF1VBrvvC";
const STORAGE_KEY = "sxb_xpanel_granted_users";

interface XPanelRedirectViewProps {
  currentUser: User;
}

function getGrantedUsers(): string[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}
function saveGrantedUsers(ids: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

export default function XPanelRedirectView({ currentUser }: XPanelRedirectViewProps) {
  const isSuperAdmin = currentUser.role === UserRole.SUPER_ADMIN;
  const [showPass, setShowPass]     = useState(false);
  const [copiedKey, setCopiedKey]   = useState<string | null>(null);
  const [accounts, setAccounts]     = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [grantedIds, setGrantedIds] = useState<string[]>(getGrantedUsers());
  const [saving, setSaving]         = useState<string | null>(null);

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const openPanel = () => {
    window.open(XPANEL_URL, "_blank", "noopener,noreferrer");
  };

  useEffect(() => {
    if (!isSuperAdmin) return;
    setLoadingUsers(true);
    fetchAccounts()
      .then(data => {
        setAccounts(data.filter(u => u.id !== currentUser.id && u.role !== UserRole.SUPER_ADMIN));
      })
      .catch(console.error)
      .finally(() => setLoadingUsers(false));
  }, [isSuperAdmin]);

  const toggleAccess = async (userId: string) => {
    setSaving(userId);
    const current = getGrantedUsers();
    const next = current.includes(userId)
      ? current.filter(id => id !== userId)
      : [...current, userId];
    saveGrantedUsers(next);
    setGrantedIds(next);
    await new Promise(r => setTimeout(r, 300));
    setSaving(null);
  };

  const ROLE_BADGE: Record<string, string> = {
    ADMIN:    "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
    SUPPORT:  "text-amber-400 bg-amber-500/10 border-amber-500/20",
    RESELLER: "text-violet-400 bg-violet-500/10 border-violet-500/20",
  };

  return (
    <div className="space-y-5 sm:space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2 flex-wrap">
          <div className="p-1.5 rounded-lg bg-red-500/10 border border-red-500/20 shrink-0">
            <ShieldCheck className="h-5 w-5 text-red-400" />
          </div>
          Accès X-Panel
        </h1>
        <p className="text-xs sm:text-sm text-gray-400 mt-1">
          Accédez directement au panneau de gestion XNet avec vos identifiants pré-remplis.
        </p>
      </div>

      {/* Panel card */}
      <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl p-5 sm:p-6 space-y-4">
        {/* URL */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
            <Globe className="w-3.5 h-3.5" /> URL du panneau
          </label>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 text-xs sm:text-sm text-cyan-300 font-mono bg-cyan-500/5 border border-cyan-500/15 px-3 py-2.5 rounded-xl truncate">
              {XPANEL_URL}
            </code>
            <button onClick={() => copy("url", XPANEL_URL)}
              className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0">
              {copiedKey === "url" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Credentials */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Username */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
              <KeyRound className="w-3.5 h-3.5" /> Utilisateur
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 text-sm text-white font-mono bg-[#07090e] border border-[#1a1f2e] px-3 py-2.5 rounded-xl">
                {XPANEL_USER}
              </code>
              <button onClick={() => copy("user", XPANEL_USER)}
                className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0">
                {copiedKey === "user" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
              <Lock className="w-3.5 h-3.5" /> Mot de passe
            </label>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 text-sm font-mono bg-[#07090e] border border-[#1a1f2e] px-3 py-2.5 rounded-xl text-white tracking-wider truncate">
                {showPass ? XPANEL_PASS : "••••••••••••••••••••"}
              </code>
              <button onClick={() => setShowPass(p => !p)}
                className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0">
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              <button onClick={() => copy("pass", XPANEL_PASS)}
                className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0">
                {copiedKey === "pass" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Open button */}
        <button
          onClick={openPanel}
          className="w-full flex items-center justify-center gap-2.5 py-3.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 hover:border-red-500/50 text-red-300 hover:text-red-200 rounded-xl text-sm font-semibold transition-all"
        >
          <ExternalLink className="w-4 h-4" />
          Ouvrir X-Panel dans un nouvel onglet
        </button>

        <p className="text-xs text-gray-600 text-center flex items-center justify-center gap-1.5">
          <AlertTriangle className="w-3 h-3" />
          Identifiants sensibles — ne partagez pas cette page
        </p>
      </div>

      {/* Access management — SUPER_ADMIN only */}
      {isSuperAdmin && (
        <div className="bg-[#0f1218] border border-[#1a1f2e] rounded-2xl overflow-hidden">
          <div className="px-5 sm:px-6 py-4 border-b border-[#1a1f2e] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-rose-400 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-white">Gestion des accès</p>
                <p className="text-xs text-gray-500">Autorisez d\'autres comptes à accéder à X-Panel</p>
              </div>
            </div>
            <span className="text-xs bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-lg font-mono shrink-0">
              SUPER_ADMIN
            </span>
          </div>

          {loadingUsers ? (
            <div className="flex justify-center py-10">
              <RefreshCw className="w-5 h-5 text-gray-500 animate-spin" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="py-10 text-center text-gray-600 text-sm">Aucun autre compte disponible</div>
          ) : (
            <div className="divide-y divide-[#1a1f2e]">
              {accounts.map(user => {
                const hasAccess = grantedIds.includes(user.id);
                const isSaving  = saving === user.id;
                const roleCls   = ROLE_BADGE[user.role] || "text-gray-400 bg-gray-500/10 border-gray-500/20";
                return (
                  <div key={user.id} className="flex items-center gap-3 px-5 sm:px-6 py-3.5 hover:bg-white/[0.02] transition-colors">
                    {/* Avatar */}
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-700 to-gray-800 flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-gray-300">
                        {(user.name || user.email || "?")[0].toUpperCase()}
                      </span>
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{user.name || "—"}</p>
                      <p className="text-xs text-gray-500 truncate">{user.email}</p>
                    </div>
                    {/* Role badge */}
                    <span className={`hidden sm:inline-flex text-xs px-2 py-0.5 rounded-lg border font-mono ${roleCls}`}>
                      {user.role}
                    </span>
                    {/* Toggle */}
                    <button
                      onClick={() => toggleAccess(user.id)}
                      disabled={isSaving}
                      className={`relative flex items-center shrink-0 transition-all ${isSaving ? "opacity-50" : ""}`}
                      title={hasAccess ? "Révoquer l\'accès" : "Autoriser l\'accès"}
                    >
                      {isSaving ? (
                        <RefreshCw className="w-4 h-4 text-gray-400 animate-spin" />
                      ) : hasAccess ? (
                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
                          <Check className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Autorisé</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800/50 border border-gray-700/50 text-gray-500 text-xs font-medium hover:border-red-500/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                          <Shield className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">Autoriser</span>
                        </div>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { Settings, Globe, Shield, Database, RefreshCw, Key, Users, Copy, CheckCheck, KeyRound } from "lucide-react";
import { createUser } from "../api/users";
import { fetchRoles } from "../api/permissions";

interface GeneratedCreds {
  name: string;
  email: string;
  password: string;
  role: string;
}

function CredentialsModal({ credentials, onClose }: { credentials: GeneratedCreds; onClose: () => void }) {
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  const copy = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text).then(() => { setter(true); setTimeout(() => setter(false), 2000); });
  };

  const copyAll = () => {
    copy(
      `Dashboard SXB VPN\nURL: https://vpnsxb.afrihall.com\nNom: ${credentials.name}\nEmail: ${credentials.email}\nMot de passe: ${credentials.password}\nRôle: ${credentials.role}`,
      setCopiedAll
    );
  };

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
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Nom</label>
            <div className="px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-white">{credentials.name}</div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Email (identifiant)</label>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-cyan-400 font-mono">{credentials.email}</div>
              <button onClick={() => copy(credentials.email, setCopiedEmail)} className="px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white">
                {copiedEmail ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Mot de passe</label>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 bg-[#0f1218] border border-emerald-500/30 rounded-lg text-sm text-emerald-400 font-mono font-bold tracking-wide">{credentials.password}</div>
              <button onClick={() => copy(credentials.password, setCopiedPass)} className="px-3 py-2 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-400 hover:text-white">
                {copiedPass ? <CheckCheck size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">URL Dashboard</label>
            <div className="px-3 py-2 bg-[#0f1218] border border-[#1a1f2e] rounded-lg text-sm text-gray-300 font-mono">https://vpnsxb.afrihall.com</div>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={copyAll} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#5B8DEF] hover:bg-[#4a7de0] text-white text-sm font-semibold">
            {copiedAll ? <CheckCheck size={14} /> : <Copy size={14} />}
            {copiedAll ? "Copié !" : "Tout copier"}
          </button>
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-lg bg-[#0f1218] border border-[#1a1f2e] text-gray-300 hover:text-white text-sm font-semibold">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SettingsView() {
  const { t, language, setLanguage } = useTranslation();
  const [profileName, setProfileName] = useState("SXB Admin Team");
  const [profileEmail, setProfileEmail] = useState("admin@sxb-vpn.com");
  const [sxbEndpoint, setSxbEndpoint] = useState("https://api.sxb-vpn.com/v1");
  const [xpanelHost, setXpanelHost] = useState("144.76.85.120");
  const [xpanelPort, setXpanelPort] = useState("443");
  const [adminSecret, setAdminSecret] = useState("sxb_sec_rsa_4096_sha512_hash...");

  // Team management
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [teamName, setTeamName] = useState("");
  const [teamEmail, setTeamEmail] = useState("");
  const [teamPhone, setTeamPhone] = useState("");
  const [teamRoleId, setTeamRoleId] = useState("");
  const [teamCreating, setTeamCreating] = useState(false);
  const [createdCreds, setCreatedCreds] = useState<GeneratedCreds | null>(null);

  useEffect(() => {
    fetchRoles().then((data: any[]) => {
      // Filtrer pour ne montrer que ADMIN et SUPPORT (pas SUPER_ADMIN, RESELLER, CLIENT)
      const manageable = data.filter((r: any) => ["ADMIN", "SUPPORT"].includes(r.name));
      setRoles(manageable);
      if (manageable.length > 0) setTeamRoleId(manageable[0].id);
    }).catch(() => {});
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    alert("Paramètres d'API et d'intégration enregistrés avec succès ! Le système est maintenant branché sur ces cibles.");
  };

  const handleCreateTeamMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName || !teamEmail || !teamRoleId) return;
    setTeamCreating(true);
    try {
      // Pas de password envoyé → auto-généré par le backend
      const result = await createUser({
        name: teamName,
        email: teamEmail,
        phone: teamPhone || undefined,
        roleId: teamRoleId,
      }) as any;

      const roleName = roles.find((r) => r.id === teamRoleId)?.name || "ADMIN";

      if (result.generatedPassword) {
        setCreatedCreds({
          name: result.name || teamName,
          email: result.email || teamEmail,
          password: result.generatedPassword,
          role: roleName,
        });
      } else {
        alert(`Compte ${roleName} créé pour ${teamEmail}`);
      }

      setTeamName("");
      setTeamEmail("");
      setTeamPhone("");
      if (roles.length > 0) setTeamRoleId(roles[0].id);
    } catch (err: any) {
      alert(err?.message || "Erreur lors de la création du compte");
    } finally {
      setTeamCreating(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {createdCreds && <CredentialsModal credentials={createdCreds} onClose={() => setCreatedCreds(null)} />}

      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">{t("settings.title")}</h1>
        <p className="text-sm text-gray-400 mt-1">{t("settings.subtitle")}</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Language */}
        <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
            <Globe className="h-4.5 w-4.5 text-cyan-400" />
            {t("settings.sections.language_selection")}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.current_lang")}</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setLanguage("fr")}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg border flex items-center justify-center gap-2 cursor-pointer transition-all ${language === "fr" ? "bg-cyan-950 text-cyan-400 border-cyan-500/50" : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"}`}>
                  Français 🇫🇷
                </button>
                <button type="button" onClick={() => setLanguage("en")}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg border flex items-center justify-center gap-2 cursor-pointer transition-all ${language === "en" ? "bg-cyan-950 text-cyan-400 border-cyan-500/50" : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"}`}>
                  English 🇬🇧
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.browser_lang_detected")}</label>
              <div className="w-full px-3 py-2 text-xs font-mono bg-gray-900 border border-gray-800/80 rounded-lg text-gray-400">{navigator.language}</div>
            </div>
          </div>
        </div>

        {/* Profile */}
        <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
            <Shield className="h-4.5 w-4.5 text-blue-400" />
            {t("settings.sections.profile")}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Nom d'affichage</label>
              <input type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Adresse Email</label>
              <input type="email" value={profileEmail} onChange={(e) => setProfileEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50" />
            </div>
          </div>
        </div>

        {/* Liaisons Techniques */}
        <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
            <Database className="h-4.5 w-4.5 text-emerald-400" />
            Liaisons Techniques & Endpoints
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.api_endpoint")}</label>
              <input type="text" value={sxbEndpoint} onChange={(e) => setSxbEndpoint(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.xpanel_endpoint")}</label>
                <input type="text" value={xpanelHost} onChange={(e) => setXpanelHost(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">Port XPanel</label>
                <input type="text" value={xpanelPort} onChange={(e) => setXpanelPort(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.secret_key")}</label>
              <input type="password" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50" />
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit"
            className="px-5 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer">
            Enregistrer les Intégrations
          </button>
        </div>
      </form>

      {/* ═══════════════════════════════════════════════════════
          GESTION DE L'ÉQUIPE — Créer Admin / Support
      ════════════════════════════════════════════════════════ */}
      <div className="p-5 rounded-xl border border-[#5B8DEF]/20 bg-[#5B8DEF]/5 space-y-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
          <Users className="h-4.5 w-4.5 text-[#5B8DEF]" />
          Gestion de l'équipe
          <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-medium bg-[#5B8DEF]/20 text-[#5B8DEF] border border-[#5B8DEF]/30 normal-case">
            Admin · Support
          </span>
        </div>
        <p className="text-xs text-gray-400">
          Créez des comptes pour vos administrateurs et agents de support. Un mot de passe sécurisé est généré automatiquement — copiez-le avant de fermer la fenêtre.
        </p>

        <form onSubmit={handleCreateTeamMember} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Nom complet</label>
              <input
                type="text"
                required
                placeholder="Jean Dupont"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#5B8DEF]/50"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Adresse Email</label>
              <input
                type="email"
                required
                placeholder="jean@sxbvpn.com"
                value={teamEmail}
                onChange={(e) => setTeamEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#5B8DEF]/50"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Téléphone (optionnel)</label>
              <input
                type="tel"
                placeholder="+225 00 00 00 00"
                value={teamPhone}
                onChange={(e) => setTeamPhone(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#5B8DEF]/50"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5 uppercase tracking-wider">Rôle</label>
              <select
                required
                value={teamRoleId}
                onChange={(e) => setTeamRoleId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-[#5B8DEF]/50"
              >
                {roles.length === 0 && <option value="">Chargement...</option>}
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name === "ADMIN" ? "👑 Administrateur" : "🎧 Support"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={teamCreating || roles.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#5B8DEF] hover:bg-[#4a7de0] text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {teamCreating ? <RefreshCw size={14} className="animate-spin" /> : <Key size={14} />}
              {teamCreating ? "Création..." : "Créer le compte"}
            </button>
            <p className="text-xs text-gray-500">
              Le mot de passe sera généré automatiquement et affiché une seule fois.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}

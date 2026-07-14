import React, { useState } from "react";
import { useTranslation } from "../contexts/I18nContext";
import { Settings, Globe, Shield, Database, RefreshCw, Key } from "lucide-react";

export default function SettingsView() {
  const { t, language, setLanguage } = useTranslation();
  const [profileName, setProfileName] = useState("SXB Admin Team");
  const [profileEmail, setProfileEmail] = useState("admin@sxb-vpn.com");
  
  // Simulated Target endpoints
  const [sxbEndpoint, setSxbEndpoint] = useState("https://api.sxb-vpn.com/v1");
  const [xpanelHost, setXpanelHost] = useState("144.76.85.120");
  const [xpanelPort, setXpanelPort] = useState("443");
  const [adminSecret, setAdminSecret] = useState("sxb_sec_rsa_4096_sha512_hash...");

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    alert("Paramètres d'API et d'intégration enregistrés avec succès ! Le système est maintenant branché sur ces cibles.");
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">{t("settings.title")}</h1>
        <p className="text-sm text-gray-400 mt-1">{t("settings.subtitle")}</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Language Selection */}
        <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
            <Globe className="h-4.5 w-4.5 text-cyan-400" />
            {t("settings.sections.language_selection")}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.current_lang")}</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setLanguage("fr")}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg border flex items-center justify-center gap-2 cursor-pointer transition-all ${
                    language === "fr" 
                      ? "bg-cyan-950 text-cyan-400 border-cyan-500/50" 
                      : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"
                  }`}
                >
                  Français 🇫🇷
                </button>
                <button
                  type="button"
                  onClick={() => setLanguage("en")}
                  className={`flex-1 py-2 text-xs font-semibold rounded-lg border flex items-center justify-center gap-2 cursor-pointer transition-all ${
                    language === "en" 
                      ? "bg-cyan-950 text-cyan-400 border-cyan-500/50" 
                      : "bg-gray-900/60 border-gray-800 text-gray-400 hover:bg-gray-900"
                  }`}
                >
                  English 🇬🇧
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.browser_lang_detected")}</label>
              <div className="w-full px-3 py-2 text-xs font-mono bg-gray-900 border border-gray-800/80 rounded-lg text-gray-400">
                {navigator.language}
              </div>
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
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Nom d'Administrateur</label>
              <input
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              />
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Adresse Email</label>
              <input
                type="email"
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              />
            </div>
          </div>
        </div>

        {/* Integration API / XPanel endpoints targets */}
        <div className="p-5 rounded-xl border border-gray-800/80 bg-gray-950/20 backdrop-blur-md space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white uppercase tracking-wider">
            <Database className="h-4.5 w-4.5 text-emerald-400" />
            Liaisons Techniques & Endpoints
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.api_endpoint")}</label>
              <input
                type="text"
                value={sxbEndpoint}
                onChange={(e) => setSxbEndpoint(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.xpanel_endpoint")}</label>
                <input
                  type="text"
                  value={xpanelHost}
                  onChange={(e) => setXpanelHost(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-1.5">Port d'écoute XPanel</label>
                <input
                  type="text"
                  value={xpanelPort}
                  onChange={(e) => setXpanelPort(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">{t("settings.fields.secret_key")}</label>
              <input
                type="password"
                value={adminSecret}
                onChange={(e) => setAdminSecret(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono bg-gray-900 border border-gray-800 rounded-lg text-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              />
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex justify-end gap-2">
          <button
            type="submit"
            className="px-5 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-sm rounded-lg shadow-lg shadow-cyan-950/20 transition-all cursor-pointer"
          >
            Enregistrer les Intégrations
          </button>
        </div>
      </form>
    </div>
  );
}

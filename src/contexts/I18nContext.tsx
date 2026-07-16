import { createContext, useContext, useState, useEffect, ReactNode } from "react";

// Import locales directly for bundles
import frCommon from "../locales/fr/common.json";
import frDashboard from "../locales/fr/dashboard.json";
import frClients from "../locales/fr/clients.json";
import frResellers from "../locales/fr/resellers.json";
import frSettings from "../locales/fr/settings.json";

import enCommon from "../locales/en/common.json";
import enDashboard from "../locales/en/dashboard.json";
import enClients from "../locales/en/clients.json";
import enResellers from "../locales/en/resellers.json";
import enSettings from "../locales/en/settings.json";

type Language = "fr" | "en";

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

const dictionaries = {
  fr: {
    common: frCommon,
    dashboard: frDashboard,
    clients: frClients,
    resellers: frResellers,
    settings: frSettings,
  },
  en: {
    common: enCommon,
    dashboard: enDashboard,
    clients: enClients,
    resellers: enResellers,
    settings: enSettings,
  },
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem("sxb_vpn_lang");
    if (saved === "fr" || saved === "en") return saved;
    
    // Auto-detect browser language
    const browserLang = navigator.language.split("-")[0];
    if (browserLang === "en") return "en";
    return "fr"; // default to French as requested
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("sxb_vpn_lang", lang);
  };

  const t = (path: string): string => {
    const dict = dictionaries[language];

    const resolve = (obj: any, keys: string[]): string | undefined => {
      let cur: any = obj;
      for (const k of keys) {
        if (cur && typeof cur === "object" && k in cur) cur = cur[k];
        else return undefined;
      }
      return typeof cur === "string" ? cur : undefined;
    };

    const parts = path.split(".");
    // Direct lookup first (e.g. "common.sidebar.rbac")
    const direct = resolve(dict, parts);
    if (direct !== undefined) return direct;
    // Fallback: prepend "common" namespace (e.g. "sidebar.rbac" → "common.sidebar.rbac")
    const viaCommon = resolve(dict, ["common", ...parts]);
    if (viaCommon !== undefined) return viaCommon;
    return path; // Last resort: return key as-is
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useTranslation must be used within an I18nProvider");
  }
  return context;
}

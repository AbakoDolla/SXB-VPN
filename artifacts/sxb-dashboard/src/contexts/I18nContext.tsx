import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { getLanguage, getLocale, setLanguage, subscribeLanguage, type Language } from "../lib/language";
import { translate, formatNumber, formatDate, formatBytes, formatRelativeTime, type Translate, type TranslationParams } from "../lib/i18n";
import { errorMessage } from "../lib/errors";

interface I18nContextType {
  language: Language;
  setLanguage: (language: Language) => void;
  lang: Language;
  setLang: (language: Language) => void;
  locale: "fr-FR" | "en-US";
  t: Translate;
  formatNumber: (value: number | bigint, options?: Intl.NumberFormatOptions) => string;
  formatDate: (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => string;
  formatBytes: (value: number | bigint | string | null | undefined, decimals?: number) => string;
  formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
  errorMessage: (error: unknown, fallbackKey?: string) => string;
  message: (key: string, params?: TranslationParams) => ReactNode;
  errorText: (error: unknown, fallbackKey?: string) => ReactNode;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

function TranslationText({ id, params }: { id: string; params?: TranslationParams }) {
  const { t } = useTranslation();
  return <>{t(id, params)}</>;
}

function ErrorText({ error, fallbackKey }: { error: unknown; fallbackKey?: string }) {
  const { errorMessage: formatError } = useTranslation();
  return <>{formatError(error, fallbackKey)}</>;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, () => "fr" as const);
  const value = useMemo<I18nContextType>(() => ({
    language,
    lang: language,
    setLanguage,
    setLang: setLanguage,
    locale: getLocale(language),
    t: (key, params) => translate(language, key, params),
    formatNumber: (number, options) => formatNumber(number, language, options),
    formatDate: (date, options) => formatDate(date, language, options),
    formatBytes: (bytes, decimals) => formatBytes(bytes, language, decimals),
    formatRelativeTime: (number, unit) => formatRelativeTime(number, unit, language),
    errorMessage: (error, fallbackKey) => errorMessage(error, language, fallbackKey),
    message: (key, params) => <TranslationText id={key} params={params} />,
    errorText: (error, fallbackKey) => <ErrorText error={error} fallbackKey={fallbackKey} />,
  }), [language]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useTranslation must be used within an I18nProvider");
  return context;
}

export const useI18n = useTranslation;

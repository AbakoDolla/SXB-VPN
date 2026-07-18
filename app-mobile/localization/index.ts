import { useContext } from 'react';
import { LanguageContext } from '@/contexts/LanguageContext';
import { fr } from './fr';
import { en } from './en';

export type Language = 'fr' | 'en';
export type TranslationKey = keyof typeof fr;

const translations: Record<Language, Record<string, string>> = {
  fr: fr as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

export function useTranslation() {
  const { language } = useContext(LanguageContext);

  const t = (key: TranslationKey): string => {
    return translations[language]?.[key] ?? translations.fr[key] ?? key;
  };

  return { t, language };
}

export { fr, en };

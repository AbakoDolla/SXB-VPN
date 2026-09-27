import { useCallback, useContext } from 'react';
import { LanguageContext } from '@/contexts/LanguageContext';
import { fr } from './fr';
import { en } from './en';

export type Language = 'fr' | 'en';
export type TranslationKey = keyof typeof fr;

const translations: Record<Language, Record<string, string>> = {
  fr: fr as unknown as Record<string, string>,
  en: en as unknown as Record<string, string>,
};

/**
 * `t` garde la même identité tant que la langue ne change pas.
 *
 * Recréée à chaque rendu, elle rendait instable tout `useCallback` qui la
 * cite — dont l'arrêt d'accès du VpnContext — et relançait sans fin les
 * effets qui en dépendent : l'application se figeait juste après l'activation.
 */
export function useTranslation() {
  const { language } = useContext(LanguageContext);

  const t = useCallback((key: TranslationKey): string => {
    return translations[language]?.[key] ?? translations.fr[key] ?? key;
  }, [language]);

  return { t, language };
}

export { fr, en };

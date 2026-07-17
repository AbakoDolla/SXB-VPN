import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Language } from '@/localization';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
}

export const LanguageContext = createContext<LanguageContextType>({
  language: 'fr',
  setLanguage: () => {},
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>('fr');

  useEffect(() => {
    AsyncStorage.getItem('@sxb_language').then((stored) => {
      if (stored === 'fr' || stored === 'en') {
        setLanguageState(stored);
      }
    });
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    AsyncStorage.setItem('@sxb_language', lang);
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguageContext() {
  return useContext(LanguageContext);
}

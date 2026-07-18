import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';

export type ThemePreference = 'system' | 'dark' | 'light';

interface ThemeContextType {
  themePreference: ThemePreference;
  setThemePreference: (theme: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextType>({
  themePreference: 'system',
  setThemePreference: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themePreference, setThemeState] = useState<ThemePreference>('system');

  useEffect(() => {
    AsyncStorage.getItem('@sxb_theme').then((stored) => {
      if (stored === 'dark' || stored === 'light' || stored === 'system') {
        setThemeState(stored);
        if (stored !== 'system') {
          Appearance.setColorScheme(stored);
        }
      }
    });
  }, []);

  const setThemePreference = (theme: ThemePreference) => {
    setThemeState(theme);
    AsyncStorage.setItem('@sxb_theme', theme);
    Appearance.setColorScheme(theme === 'system' ? null : theme);
  };

  return (
    <ThemeContext.Provider value={{ themePreference, setThemePreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext() {
  return useContext(ThemeContext);
}

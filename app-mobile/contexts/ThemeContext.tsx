import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance, type ColorSchemeName } from "react-native";
import type { AppColorScheme } from "@/constants/colors";

export type ThemePreference = "system" | "dark" | "light";

interface ThemeContextType {
  themePreference: ThemePreference;
  colorScheme: AppColorScheme;
  setThemePreference: (theme: ThemePreference) => Promise<void>;
}

export const ThemeContext = createContext<ThemeContextType>({
  themePreference: "system",
  colorScheme: "dark",
  setThemePreference: async () => {},
});

function normalizeScheme(value: ColorSchemeName): AppColorScheme {
  return value === "light" ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themePreference, setThemeState] = useState<ThemePreference>("system");
  const [systemScheme, setSystemScheme] = useState<AppColorScheme>(normalizeScheme(Appearance.getColorScheme()));

  useEffect(() => {
    AsyncStorage.getItem("@sxb_theme").then((stored) => {
      if (stored === "dark" || stored === "light" || stored === "system") {
        setThemeState(stored);
        Appearance.setColorScheme(stored === "system" ? null : stored);
      }
    }).catch(() => {});

    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(normalizeScheme(colorScheme));
    });
    return () => subscription.remove();
  }, []);

  const setThemePreference = async (theme: ThemePreference) => {
    setThemeState(theme);
    await AsyncStorage.setItem("@sxb_theme", theme);
    Appearance.setColorScheme(theme === "system" ? null : theme);
  };

  const colorScheme = useMemo<AppColorScheme>(
    () => themePreference === "system" ? systemScheme : themePreference,
    [themePreference, systemScheme],
  );

  return (
    <ThemeContext.Provider value={{ themePreference, colorScheme, setThemePreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext() {
  return useContext(ThemeContext);
}

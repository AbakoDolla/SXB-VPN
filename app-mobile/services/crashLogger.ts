/// crashLogger.ts
///
/// Intercepte TOUTE exception JS non gérée (via ErrorUtils, le
/// mécanisme natif de React Native - plus large que ErrorBoundary qui
/// ne couvre que les erreurs de rendu) et la stocke dans AsyncStorage.
/// Le crash précédent est affiché au lancement suivant sur l'écran
/// d'accueil, lisible directement sans PC ni root.
import AsyncStorage from '@react-native-async-storage/async-storage';

const CRASH_LOG_KEY = 'sxb_last_crash';

export function installCrashLogger() {
  const globalAny = global as any;
  const defaultHandler = globalAny.ErrorUtils?.getGlobalHandler?.();

  globalAny.ErrorUtils?.setGlobalHandler((error: Error, isFatal?: boolean) => {
    try {
      const entry = {
        message: error?.message ?? String(error),
        stack: error?.stack ?? 'no stack',
        isFatal: !!isFatal,
        time: new Date().toISOString(),
      };
      // Stockage best-effort, sans bloquer le crash handler par défaut
      AsyncStorage.setItem(CRASH_LOG_KEY, JSON.stringify(entry, null, 2)).catch(() => {});
    } catch {
      // Ne jamais laisser le logger lui-même planter
    }
    // Laisse le comportement normal se produire ensuite (le dialogue
    // système "l'app s'est arrêtée" s'affichera comme avant)
    defaultHandler?.(error, isFatal);
  });
}

export async function getLastCrash(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CRASH_LOG_KEY);
  } catch {
    return null;
  }
}

export async function clearLastCrash(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CRASH_LOG_KEY);
  } catch {
    // ignore
  }
}

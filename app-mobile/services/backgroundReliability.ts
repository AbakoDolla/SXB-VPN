/**
 * backgroundReliability.ts — pourquoi un tunnel s'arrête quand l'écran s'éteint.
 *
 * LE PROBLÈME RÉEL
 * ────────────────
 * Le service VPN tourne au premier plan, avec sa notification : Android le
 * garde donc en vie tant que la batterie n'est pas « optimisée » pour cette
 * application. Quand elle l'est — c'est le réglage PAR DÉFAUT sur la plupart
 * des surcouches (Xiaomi, Oppo, Samsung…) — le système suspend les réveils,
 * coupe les sockets après quelques minutes de veille profonde, et le tunnel
 * tombe sans que rien ne l'explique à l'utilisateur.
 *
 * L'état était déjà LU pour les diagnostics, mais n'était jamais montré. Ce
 * module l'expose à l'interface et sait ouvrir l'écran système correspondant.
 *
 * CE QUE CE MODULE NE FAIT PAS
 * ────────────────────────────
 * Il ne demande JAMAIS l'exemption lui-même : la boîte de dialogue
 * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` est réservée par Google à une poignée
 * de cas d'usage, et son emploi est un motif de refus sur le Play Store. On se
 * contente d'ouvrir la LISTE système, où l'utilisateur décide lui-même. C'est
 * aussi ce que vérifie la garde `play-policy`.
 */
import { Linking, NativeModules, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

export type BackgroundMode = 'unrestricted' | 'optimized' | 'unknown';

const SxbVpnNative = Platform.OS === 'android' ? NativeModules.SxbVpnNative as {
  getBatteryOptimizationState?: () => Promise<string>;
} | null : null;

/** Écran système listant les applications exemptées d'optimisation batterie. */
const BATTERY_SETTINGS_ACTION = 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS';

/**
 * Lit l'état sans rien demander.
 *
 * `unknown` est un état À PART ENTIÈRE : sur iOS, sur une version trop
 * ancienne ou si la lecture échoue, affirmer « sans restriction » serait une
 * promesse que personne ne tient.
 */
export async function readBackgroundMode(): Promise<BackgroundMode> {
  if (!SxbVpnNative?.getBatteryOptimizationState) return 'unknown';
  try {
    const state = await SxbVpnNative.getBatteryOptimizationState();
    return state === 'optimized' || state === 'unrestricted' ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Ouvre l'écran système où l'utilisateur lève lui-même la restriction.
 *
 * Certaines surcouches ne déclarent pas cet écran. Le repli ouvre alors la
 * fiche de l'application, d'où la même option reste atteignable. La fonction
 * rend `false` plutôt que d'échouer en silence : l'interface doit pouvoir dire
 * que le raccourci n'existe pas sur cet appareil au lieu de ne rien faire.
 */
export async function openBackgroundSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    await IntentLauncher.startActivityAsync(BATTERY_SETTINGS_ACTION);
    return true;
  } catch {
    try {
      await Linking.openSettings();
      return true;
    } catch {
      return false;
    }
  }
}

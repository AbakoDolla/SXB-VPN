import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

/**
 * Chronomètre d'affichage ancré sur la durée native.
 *
 * Le VpnService reste l'autorité : chaque mesure native recale l'ancre. Entre
 * deux mesures (2 s), un tick local à 1 Hz évite que l'écran affiche seulement
 * les secondes paires. L'intervalle est détruit en arrière-plan ; au retour,
 * le temps écoulé est rattrapé immédiatement, sans dérive cumulative.
 */
export function useConnectionDuration(isConnected: boolean, nativeSeconds: number): number {
  const [displayedSeconds, setDisplayedSeconds] = useState(0);
  const nativeSecondsRef = useRef(0);
  const anchoredAtRef = useRef(Date.now());

  useEffect(() => {
    const safe = Math.max(0, Math.floor(nativeSeconds || 0));
    nativeSecondsRef.current = safe;
    anchoredAtRef.current = Date.now();
    setDisplayedSeconds(isConnected ? safe : 0);
  }, [isConnected, nativeSeconds]);

  useEffect(() => {
    if (!isConnected) {
      setDisplayedSeconds(0);
      return;
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    const update = () => {
      const elapsed = Math.floor((Date.now() - anchoredAtRef.current) / 1000);
      setDisplayedSeconds(nativeSecondsRef.current + Math.max(0, elapsed));
    };
    const start = () => {
      update();
      if (!timer) timer = setInterval(update, 1_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    if (AppState.currentState === "active") start();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") start();
      else stop();
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [isConnected]);

  return displayedSeconds;
}

import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

export function useMotionPreference() {
  const [reduceMotion, setReduceMotion] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    const preference = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      preferenceChanged = true;
      setReduceMotion(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted && !preferenceChanged) setReduceMotion(value);
      })
      .catch(() => {
        console.warn('[Accessibility] Motion preference unavailable; animations remain disabled.');
      });
    const activity = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => {
      mounted = false;
      preference.remove();
      activity.remove();
    };
  }, []);

  return { reduceMotion, motionEnabled: !reduceMotion && foreground };
}

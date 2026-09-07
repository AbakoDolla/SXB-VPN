import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import {
  type AppLockPreferences,
  type BiometricCapability,
  clearStoredAppLock,
  clearPinThrottleState,
  deletePin,
  getBiometricCapability,
  getPinThrottleState,
  loadAppLockPreferences,
  registerFailedPinAttempt,
  requestBiometricAuthentication,
  saveAppLockPreferences,
  storePin,
  verifyPin,
} from "@/services/appLock";
import {
  APP_LOCK_DELAY_MS,
  shouldLockAfterBackground,
} from "@/services/appLockPolicy";

type BiometricEnableResult =
  | "enabled"
  | "pin_required"
  | "unavailable"
  | "not_enrolled"
  | "authentication_failed";

type PinUnlockResult =
  | { success: true }
  | { success: false; reason: "invalid" | "throttled"; retryAfterMs?: number };

interface AppLockContextValue {
  isReady: boolean;
  isLocked: boolean;
  isAuthenticating: boolean;
  preferences: AppLockPreferences;
  biometricCapability: BiometricCapability;
  setPin: (pin: string) => Promise<void>;
  removePin: () => Promise<void>;
  enableBiometrics: (promptMessage: string, cancelLabel: string) => Promise<BiometricEnableResult>;
  disableBiometrics: () => Promise<void>;
  unlockWithBiometrics: (promptMessage: string, cancelLabel: string) => Promise<boolean>;
  unlockWithPin: (pin: string) => Promise<PinUnlockResult>;
  clearAppLock: () => Promise<void>;
  refreshBiometricCapability: () => Promise<BiometricCapability>;
}

const DEFAULT_PREFERENCES: AppLockPreferences = {
  version: 1,
  pinEnabled: false,
  biometricsEnabled: false,
  lockAfterMs: APP_LOCK_DELAY_MS,
};

const EMPTY_CAPABILITY: BiometricCapability = {
  hasHardware: false,
  isEnrolled: false,
  supportedTypes: [],
};

const AppLockContext = createContext<AppLockContextValue | null>(null);

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [biometricCapability, setBiometricCapability] = useState(EMPTY_CAPABILITY);
  const preferencesRef = useRef(preferences);
  const backgroundedAtRef = useRef<number | null>(null);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  const refreshBiometricCapability = useCallback(async () => {
    const capability = await getBiometricCapability();
    setBiometricCapability(capability);
    return capability;
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      loadAppLockPreferences(),
      getBiometricCapability().catch(() => EMPTY_CAPABILITY),
    ]).then(([storedPreferences, capability]) => {
      if (!mounted) return;
      preferencesRef.current = storedPreferences;
      setPreferences(storedPreferences);
      setBiometricCapability(capability);
      setIsLocked(storedPreferences.pinEnabled || storedPreferences.biometricsEnabled);
    }).catch(() => {
      if (!mounted) return;
      const failClosedPreferences = { ...DEFAULT_PREFERENCES, pinEnabled: true };
      preferencesRef.current = failClosedPreferences;
      setPreferences(failClosedPreferences);
      setIsLocked(true);
    }).finally(() => {
      if (mounted) setIsReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const clearLockTimer = () => {
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    };
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === "background") {
        if (backgroundedAtRef.current === null) {
          backgroundedAtRef.current = Date.now();
        }
        clearLockTimer();
        lockTimerRef.current = setTimeout(() => {
          const current = preferencesRef.current;
          if (current.pinEnabled || current.biometricsEnabled) setIsLocked(true);
        }, preferencesRef.current.lockAfterMs);
        return;
      }
      if (nextState === "active") {
        clearLockTimer();
        const current = preferencesRef.current;
        if (
          (current.pinEnabled || current.biometricsEnabled)
          && shouldLockAfterBackground(
            backgroundedAtRef.current,
            Date.now(),
            current.lockAfterMs,
          )
        ) {
          setIsLocked(true);
        }
        backgroundedAtRef.current = null;
      }
    };

    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      clearLockTimer();
      subscription.remove();
    };
  }, []);

  const persistPreferences = useCallback(async (next: AppLockPreferences) => {
    const stored = await saveAppLockPreferences(next);
    preferencesRef.current = stored;
    setPreferences(stored);
  }, []);

  const setPin = useCallback(async (pin: string) => {
    await storePin(pin);
    await persistPreferences({
      ...preferencesRef.current,
      pinEnabled: true,
    });
  }, [persistPreferences]);

  const removePin = useCallback(async () => {
    if (preferencesRef.current.biometricsEnabled) {
      throw new Error("disable_biometrics_first");
    }
    await deletePin();
    await persistPreferences(DEFAULT_PREFERENCES);
    setIsLocked(false);
  }, [persistPreferences]);

  const enableBiometrics = useCallback(async (
    promptMessage: string,
    cancelLabel: string,
  ): Promise<BiometricEnableResult> => {
    if (!preferencesRef.current.pinEnabled) return "pin_required";
    const capability = await refreshBiometricCapability().catch(() => EMPTY_CAPABILITY);
    if (!capability.hasHardware) return "unavailable";
    if (!capability.isEnrolled) return "not_enrolled";

    setIsAuthenticating(true);
    try {
      const result = await requestBiometricAuthentication(promptMessage, cancelLabel);
      if (!result.success) return "authentication_failed";
      await persistPreferences({
        ...preferencesRef.current,
        pinEnabled: true,
        biometricsEnabled: true,
      });
      return "enabled";
    } finally {
      setIsAuthenticating(false);
    }
  }, [persistPreferences, refreshBiometricCapability]);

  const disableBiometrics = useCallback(async () => {
    await persistPreferences({
      ...preferencesRef.current,
      biometricsEnabled: false,
    });
  }, [persistPreferences]);

  const unlockWithBiometrics = useCallback(async (
    promptMessage: string,
    cancelLabel: string,
  ) => {
    if (!preferencesRef.current.biometricsEnabled || isAuthenticating) return false;
    setIsAuthenticating(true);
    try {
      const result = await requestBiometricAuthentication(promptMessage, cancelLabel);
      if (!result.success) return false;
      await clearPinThrottleState();
      setIsLocked(false);
      return true;
    } finally {
      setIsAuthenticating(false);
    }
  }, [isAuthenticating]);

  const unlockWithPin = useCallback(async (pin: string): Promise<PinUnlockResult> => {
    const now = Date.now();
    const throttle = await getPinThrottleState();
    if (throttle.retryAt > now) {
      return {
        success: false,
        reason: "throttled",
        retryAfterMs: throttle.retryAt - now,
      };
    }

    const matches = await verifyPin(pin);
    if (matches) {
      await clearPinThrottleState();
      setIsLocked(false);
      return { success: true };
    }

    const failed = await registerFailedPinAttempt(now);
    if (failed.retryAt > now) {
      return {
        success: false,
        reason: "throttled",
        retryAfterMs: failed.retryAt - now,
      };
    }
    return { success: false, reason: "invalid" };
  }, []);

  const clearAppLock = useCallback(async () => {
    await clearStoredAppLock();
    preferencesRef.current = DEFAULT_PREFERENCES;
    setPreferences(DEFAULT_PREFERENCES);
    setIsLocked(false);
  }, []);

  const value = useMemo<AppLockContextValue>(() => ({
    isReady,
    isLocked,
    isAuthenticating,
    preferences,
    biometricCapability,
    setPin,
    removePin,
    enableBiometrics,
    disableBiometrics,
    unlockWithBiometrics,
    unlockWithPin,
    clearAppLock,
    refreshBiometricCapability,
  }), [
    biometricCapability,
    clearAppLock,
    disableBiometrics,
    enableBiometrics,
    isAuthenticating,
    isLocked,
    isReady,
    preferences,
    refreshBiometricCapability,
    removePin,
    setPin,
    unlockWithBiometrics,
    unlockWithPin,
  ]);

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
}

export function useAppLock() {
  const context = useContext(AppLockContext);
  if (!context) throw new Error("useAppLock must be used inside AppLockProvider");
  return context;
}

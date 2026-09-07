import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  APP_LOCK_DELAY_MS,
  constantTimeEqual,
  isValidPin,
} from "./appLockPolicy";

export const APP_LOCK_PREFERENCES_KEY = "@sxb_app_lock_preferences";
export const LEGACY_PIN_KEY = "@sxb_pin";
const PIN_CREDENTIAL_KEY = "sxb.app-lock.pin.v1";
const PIN_THROTTLE_KEY = "sxb.app-lock.throttle.v1";
const PIN_HASH_VERSION = 1;
const PIN_LOCK_BASE_MS = 30_000;
const PIN_LOCK_MAX_MS = 15 * 60_000;

export type AppLockPreferences = {
  version: 1;
  pinEnabled: boolean;
  biometricsEnabled: boolean;
  lockAfterMs: number;
};

export type BiometricCapability = {
  hasHardware: boolean;
  isEnrolled: boolean;
  supportedTypes: LocalAuthentication.AuthenticationType[];
};

type StoredPinCredential = {
  version: 1;
  algorithm: "sha256";
  salt: string;
  digest: string;
};

export type PinThrottleState = {
  failures: number;
  retryAt: number;
};

const DEFAULT_PREFERENCES: AppLockPreferences = {
  version: 1,
  pinEnabled: false,
  biometricsEnabled: false,
  lockAfterMs: APP_LOCK_DELAY_MS,
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePreferences(value: unknown): AppLockPreferences {
  if (!value || typeof value !== "object") return DEFAULT_PREFERENCES;
  const candidate = value as Partial<AppLockPreferences>;
  const pinEnabled = candidate.pinEnabled === true;
  return {
    version: 1,
    pinEnabled,
    biometricsEnabled: pinEnabled && candidate.biometricsEnabled === true,
    lockAfterMs: APP_LOCK_DELAY_MS,
  };
}

function decodeLegacyPin(encodedPin: string): string | null {
  try {
    const decodedPin = globalThis.atob(encodedPin);
    return isValidPin(decodedPin) ? decodedPin : null;
  } catch {
    return null;
  }
}

async function digestPin(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `sxb-app-lock:v${PIN_HASH_VERSION}:${salt}:${pin}`,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
}

async function readPinCredential(): Promise<StoredPinCredential | null> {
  if (Platform.OS === "web") return null;
  const serialized = await SecureStore.getItemAsync(PIN_CREDENTIAL_KEY);
  if (!serialized) return null;

  try {
    const parsed = JSON.parse(serialized) as Partial<StoredPinCredential>;
    if (
      parsed.version !== PIN_HASH_VERSION
      || parsed.algorithm !== "sha256"
      || typeof parsed.salt !== "string"
      || typeof parsed.digest !== "string"
    ) {
      return null;
    }
    return parsed as StoredPinCredential;
  } catch {
    return null;
  }
}

async function readPinThrottleState(): Promise<PinThrottleState> {
  if (Platform.OS === "web") return { failures: 0, retryAt: 0 };
  const serialized = await SecureStore.getItemAsync(PIN_THROTTLE_KEY);
  if (!serialized) return { failures: 0, retryAt: 0 };
  try {
    const parsed = JSON.parse(serialized) as Partial<PinThrottleState>;
    const failures = Number.isInteger(parsed.failures) && Number(parsed.failures) >= 0
      ? Number(parsed.failures)
      : 0;
    const retryAt = Number.isFinite(parsed.retryAt) && Number(parsed.retryAt) > 0
      ? Number(parsed.retryAt)
      : 0;
    return { failures, retryAt };
  } catch {
    return { failures: 0, retryAt: 0 };
  }
}

async function writePinThrottleState(state: PinThrottleState): Promise<void> {
  if (Platform.OS === "web") return;
  await SecureStore.setItemAsync(PIN_THROTTLE_KEY, JSON.stringify(state), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function getPinThrottleState(): Promise<PinThrottleState> {
  return readPinThrottleState();
}

export async function registerFailedPinAttempt(now = Date.now()): Promise<PinThrottleState> {
  const current = await readPinThrottleState();
  if (current.retryAt > now) return current;
  const failures = current.failures + 1;
  const exponent = Math.max(0, failures - 5);
  const retryAt = failures >= 5
    ? now + Math.min(PIN_LOCK_BASE_MS * (2 ** exponent), PIN_LOCK_MAX_MS)
    : 0;
  const next = { failures, retryAt };
  await writePinThrottleState(next);
  return next;
}

export async function clearPinThrottleState(): Promise<void> {
  if (Platform.OS !== "web") await SecureStore.deleteItemAsync(PIN_THROTTLE_KEY);
}

export async function loadAppLockPreferences(): Promise<AppLockPreferences> {
  const [serializedPreferences, initialCredential, legacyPin] = await Promise.all([
    AsyncStorage.getItem(APP_LOCK_PREFERENCES_KEY),
    readPinCredential(),
    AsyncStorage.getItem(LEGACY_PIN_KEY),
  ]);
  let credential = initialCredential;

  let parsed: unknown = null;
  if (serializedPreferences) {
    try {
      parsed = JSON.parse(serializedPreferences);
    } catch {
      parsed = null;
    }
  }

  if (!credential && legacyPin) {
    const decodedPin = decodeLegacyPin(legacyPin);
    if (decodedPin) {
      await storePin(decodedPin);
      credential = await readPinCredential();
    }
  }
  if (legacyPin) await AsyncStorage.removeItem(LEGACY_PIN_KEY);

  const preferences = normalizePreferences(parsed);
  if (!preferences.pinEnabled && credential) {
    const repaired = { ...DEFAULT_PREFERENCES, pinEnabled: true };
    await saveAppLockPreferences(repaired);
    return repaired;
  }
  if (preferences.pinEnabled && !credential) {
    await saveAppLockPreferences(DEFAULT_PREFERENCES);
    return DEFAULT_PREFERENCES;
  }
  return preferences;
}

export async function saveAppLockPreferences(
  preferences: AppLockPreferences,
): Promise<AppLockPreferences> {
  const normalized = normalizePreferences(preferences);
  await AsyncStorage.setItem(APP_LOCK_PREFERENCES_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function storePin(pin: string): Promise<void> {
  if (Platform.OS === "web") throw new Error("secure_storage_unavailable");
  if (!isValidPin(pin)) throw new Error("invalid_pin");

  const salt = bytesToHex(await Crypto.getRandomBytesAsync(32));
  const credential: StoredPinCredential = {
    version: PIN_HASH_VERSION,
    algorithm: "sha256",
    salt,
    digest: await digestPin(pin, salt),
  };
  await SecureStore.setItemAsync(PIN_CREDENTIAL_KEY, JSON.stringify(credential), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await clearPinThrottleState();
}

export async function verifyPin(pin: string): Promise<boolean> {
  if (!isValidPin(pin)) return false;
  const credential = await readPinCredential();
  if (!credential) return false;
  return constantTimeEqual(await digestPin(pin, credential.salt), credential.digest);
}

export async function deletePin(): Promise<void> {
  if (Platform.OS !== "web") {
    await Promise.all([
      SecureStore.deleteItemAsync(PIN_CREDENTIAL_KEY),
      SecureStore.deleteItemAsync(PIN_THROTTLE_KEY),
    ]);
  }
  await AsyncStorage.removeItem(LEGACY_PIN_KEY);
}

export async function clearStoredAppLock(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(APP_LOCK_PREFERENCES_KEY),
    AsyncStorage.removeItem(LEGACY_PIN_KEY),
    Platform.OS === "web"
      ? Promise.resolve()
      : Promise.all([
          SecureStore.deleteItemAsync(PIN_CREDENTIAL_KEY),
          SecureStore.deleteItemAsync(PIN_THROTTLE_KEY),
        ]),
  ]);
}

export async function getBiometricCapability(): Promise<BiometricCapability> {
  if (Platform.OS === "web") {
    return { hasHardware: false, isEnrolled: false, supportedTypes: [] };
  }
  const [hasHardware, isEnrolled, supportedTypes] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);
  return { hasHardware, isEnrolled, supportedTypes };
}

export async function requestBiometricAuthentication(
  promptMessage: string,
  cancelLabel: string,
): Promise<LocalAuthentication.LocalAuthenticationResult> {
  return LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel,
    disableDeviceFallback: true,
    biometricsSecurityLevel: "strong",
  });
}

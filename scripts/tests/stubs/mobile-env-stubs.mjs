/**
 * mobile-env-stubs.mjs — Doublures d'environnement React Native pour tests.
 * Utilisées par device-sim.e2e.mjs via alias esbuild.
 */

// ── expo-secure-store (Android Keystore / iOS Keychain) ─────────────────────
export const secureStoreState = new Map();
export const SecureStoreStub = {
  setItemAsync:    async (k, v) => { secureStoreState.set(k, String(v)); },
  getItemAsync:    async (k)    => (secureStoreState.has(k) ? secureStoreState.get(k) : null),
  deleteItemAsync: async (k)    => { secureStoreState.delete(k); },
};

// ── AsyncStorage ────────────────────────────────────────────────────────────
export const asyncStorageState = new Map();
export const AsyncStorageStub = {
  setItem:     async (k, v) => { asyncStorageState.set(k, String(v)); },
  getItem:     async (k)    => (asyncStorageState.has(k) ? asyncStorageState.get(k) : null),
  removeItem:  async (k)    => { asyncStorageState.delete(k); },
  multiRemove: async (keys) => { for (const k of keys) asyncStorageState.delete(k); },
};

// ── react-native (Plateforme simulée Android) ───────────────────────────────
export const PlatformStub = { OS: 'android' };

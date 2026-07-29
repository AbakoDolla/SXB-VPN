// Doublure expo-secure-store — ré-exporte l'état partagé (instance unique).
export {
  SecureStoreStub as default,
} from './mobile-env-stubs.mjs';
import { SecureStoreStub } from './mobile-env-stubs.mjs';
export const setItemAsync = SecureStoreStub.setItemAsync;
export const getItemAsync = SecureStoreStub.getItemAsync;
export const deleteItemAsync = SecureStoreStub.deleteItemAsync;

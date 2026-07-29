// Doublure @react-native-async-storage/async-storage — état partagé unique.
export {
  AsyncStorageStub as default,
} from './mobile-env-stubs.mjs';
import { AsyncStorageStub } from './mobile-env-stubs.mjs';
export const setItem = AsyncStorageStub.setItem;
export const getItem = AsyncStorageStub.getItem;
export const removeItem = AsyncStorageStub.removeItem;
export const multiRemove = AsyncStorageStub.multiRemove;

// Doublure react-native (uniquement ce que les services consomment).
import { PlatformStub } from './mobile-env-stubs.mjs';
export const Platform = PlatformStub;
export const NativeModules = {};
export const NativeEventEmitter = class { addListener() { return { remove() {} }; } };
export default { Platform: PlatformStub };

import Constants from 'expo-constants';
import { NativeModules } from 'react-native';
import { resolveDistribution } from './distributionPolicy';

export { PLAY_STORE_URL, PRIVACY_URL, DATA_DELETION_URL } from './distributionPolicy';
export const distribution = resolveDistribution(
  process.env.EXPO_PUBLIC_DISTRIBUTION,
  Constants.expoConfig?.extra?.distribution,
  NativeModules.SxbVpnNative?.distribution,
);
export const isPlayDistribution = distribution === 'play';

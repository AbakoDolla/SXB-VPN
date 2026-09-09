export type Distribution = 'direct' | 'play';

// A conflicting or unknown build marker must never enable the APK installer.
export function resolveDistribution(...markers: unknown[]): Distribution {
  return markers.some(value => value !== undefined && value !== null && value !== '' && value !== 'direct')
    ? 'play'
    : 'direct';
}

export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.sxbvpn.mobile';
export const PRIVACY_URL = 'https://vpnsxb.afrihall.com/api/public/privacy';
export const DATA_DELETION_URL = 'https://vpnsxb.afrihall.com/api/public/data-deletion';

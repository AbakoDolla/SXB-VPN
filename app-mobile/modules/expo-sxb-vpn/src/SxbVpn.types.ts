export type VpnState = disconnected | connecting | connected | disconnecting | error;

export type VpnProtocolType = ssh;

export interface VpnProfile {
  protocol: VpnProtocolType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  sni?: string;
}

export interface VpnTrafficStats {
  uploadBytes: number;
  downloadBytes: number;
  uploadSpeed: number;
  downloadSpeed: number;
}

export interface StartVpnOptions {
  profile: VpnProfile;
  profileName: string;
  dns?: string[];
}

export type VpnState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error';

export type VpnProtocolType =
  | 'ssh'
  | 'ssh+payload'
  | 'vless'
  | 'vmess'
  | 'trojan'
  | 'shadowsocks'
  | 'wireguard'
  | 'hysteria2'
  | 'tuic';

export interface VpnProfile {
  protocol: VpnProtocolType;
  host: string;
  port: number;
  // SSH
  username?: string;
  password?: string;
  sni?: string;
  // VLESS / VMess / Trojan
  uuid?: string;
  path?: string;
  network?: string;
  tls?: boolean;
  flow?: string;
  // Shadowsocks
  method?: string;
  // WireGuard
  privateKey?: string;
  peerPublicKey?: string;
  localAddress?: string;
  // Hysteria2 / TUIC
  // (uses password + sni above)
}

export interface VpnTrafficStats {
  uploadBytes: number;
  downloadBytes: number;
  uploadSpeed: number;
  downloadSpeed: number;
}

export interface StartVpnOptions extends VpnProfile {
  profileName?: string;
  dns?: string[];
}

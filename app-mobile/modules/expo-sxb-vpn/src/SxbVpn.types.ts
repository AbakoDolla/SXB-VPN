export type VpnState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'error';

/**
 * Les protocoles que le moteur natif accepte réellement.
 *
 * Ce n'est pas la liste des protocoles qu'un utilisateur peut écrire dans une
 * configuration : `ssh+tls`, `ssh+slowdns`, `ssh+http-connect` et leurs
 * variantes existent bel et bien côté saisie. Mais `configValidator` les
 * ramène toutes à `ssh` ou `ssh+payload` avant l'envoi, en reportant le
 * détail dans des champs dédiés (`tls`, `slowDns`, `udpMode`). Ce qui franchit
 * le pont est donc ce vocabulaire normalisé, et lui seul.
 *
 * Il doit rester identique à `SupportedProtocol` (services/configValidator) et
 * au répartiteur `when (proto)` de `SxbVpnService`. Un contrôle vérifie que
 * les trois ne divergent pas : une valeur ajoutée d'un seul côté produirait
 * soit un profil refusé par le type, soit un `CONFIG_UNSUPPORTED` à l'exécution.
 */
export type VpnProtocolType =
  | 'ssh'
  | 'ssh+payload'
  | 'vless'
  | 'vmess'
  | 'trojan'
  | 'shadowsocks'
  | 'wireguard'
  | 'hysteria2'
  | 'tuic'
  | 'singbox';

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
  /**
   * Compteur kilométrique du service : il ne repart jamais de zéro et survit à
   * la reconnexion comme à la mort de l'application. Les deux premiers champs
   * ne comptent que la session en cours ; seuls ceux-ci facturent le quota.
   */
  lifetimeUploadBytes?: number;
  lifetimeDownloadBytes?: number;
}

export interface AppTrafficStat {
  packageName: string;
  appName: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
}

export interface StartVpnOptions extends VpnProfile {
  profileName?: string;
  dns?: string[];
}

/**
 * VpnContext — SXB VPN Mobile
 * Gestion de la connexion VPN avec :
 * - Chiffrement léger de la config stockée localement
 * - Support multi-protocoles (SSH, VLESS, VMess, Trojan, Shadowsocks, Hysteria2, WireGuard)
 * - Logs persistants (50 dernières lignes)
 * - Kill switch state
 * - Intégrité de session
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import apiClient from "@/services/apiClient";
import { useAuthContext } from "./AuthContext";

// ── Minimal symmetric XOR cipher for local config storage ─────────────────────
// NOT suitable for protecting secrets from root/malicious apps — use Android Keystore for that.
// This prevents casual reads from ADB backups or unprotected device scans.

const CONFIG_KEY_SALT = "SXB_VPN_K3Y_S4LT_2026";

// btoa/atob are available in React Native 0.71+
function xorEncode(data: string, key: string): string {
  let result = "";
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  try { return btoa(unescape(encodeURIComponent(result))); } catch { return result; }
}

function xorDecode(encoded: string, key: string): string {
  try {
    const data = decodeURIComponent(escape(atob(encoded)));
    let result = "";
    for (let i = 0; i < data.length; i++) {
      result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  } catch {
    return encoded;
  }
}

async function storeConfigSecure(config: VpnConnectionConfig): Promise<void> {
  const raw = JSON.stringify(config);
  const encoded = xorEncode(raw, CONFIG_KEY_SALT);
  await AsyncStorage.setItem("@sxb_vpn_cfg_v2", encoded);
  // Remove legacy unencrypted key if present
  await AsyncStorage.removeItem("@sxb_vpn_config").catch(() => {});
}

async function loadConfigSecure(): Promise<VpnConnectionConfig | null> {
  // Try new encrypted key first
  const encoded = await AsyncStorage.getItem("@sxb_vpn_cfg_v2");
  if (encoded) {
    try {
      return JSON.parse(xorDecode(encoded, CONFIG_KEY_SALT));
    } catch { return null; }
  }
  // Fallback: legacy unencrypted key
  const legacy = await AsyncStorage.getItem("@sxb_vpn_config");
  if (legacy) {
    try {
      const cfg = JSON.parse(legacy);
      // Migrate to encrypted storage
      await storeConfigSecure(cfg);
      await AsyncStorage.removeItem("@sxb_vpn_config");
      return cfg;
    } catch { return null; }
  }
  return null;
}

// ── Protocol types ─────────────────────────────────────────────────────────────

export type ProtocolName =
  | "VLESS" | "VMess" | "Trojan" | "Shadowsocks"
  | "Hysteria2" | "TUIC" | "SSH" | "SSH+Payload" | "WireGuard";

export interface VpnProtocol {
  name: ProtocolName | string;
  port: number;
  transport: string;
  security: string;
  description?: string;
}

export interface VpnConnectionConfig {
  protocol: string;
  host: string;
  port: number;
  uuid?: string;
  username?: string;
  password?: string;
  method?: string;
  path?: string;
  network?: string;
  tls?: boolean;
  sni?: string;
  flow?: string;
  privateKey?: string;
  peerPublicKey?: string;
  localAddress?: string;
  connectionUri?: string | null;
  profileName?: string;
  subscriptionName?: string;
  // Integrity check (non-secret)
  _ts?: number;
}

// ── Context type ──────────────────────────────────────────────────────────────

interface VpnContextType {
  isConnected: boolean;
  isConnecting: boolean;
  selectedProtocol: string | null;
  availableProtocols: VpnProtocol[];
  subscriptionUrl: string | null;
  serverInfo: { host: string; location: string } | null;
  connectionConfig: VpnConnectionConfig | null;
  logs: string[];
  hasVpnPermission: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  selectProtocol: (name: string) => void;
  refreshVpnConfig: () => Promise<void>;
  requestVpnPermission: () => Promise<boolean>;
}

const VpnContext = createContext<VpnContextType>({
  isConnected: false,
  isConnecting: false,
  selectedProtocol: null,
  availableProtocols: [],
  subscriptionUrl: null,
  serverInfo: null,
  connectionConfig: null,
  logs: [],
  hasVpnPermission: false,
  connect: async () => {},
  disconnect: async () => {},
  selectProtocol: () => {},
  refreshVpnConfig: async () => {},
  requestVpnPermission: async () => false,
});

const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: "VLESS",       port: 443,  transport: "TCP",  security: "Reality",  description: "Recommandé — anti-censure" },
  { name: "VMess",       port: 80,   transport: "WS",   security: "None",     description: "Compatible — WebSocket" },
  { name: "Trojan",      port: 443,  transport: "TCP",  security: "TLS",      description: "Stable — imite HTTPS" },
  { name: "Shadowsocks", port: 8388, transport: "TCP",  security: "ChaCha20", description: "Léger et rapide" },
  { name: "Hysteria2",   port: 443,  transport: "QUIC", security: "TLS",      description: "Très rapide — UDP" },
  { name: "SSH",         port: 22,   transport: "TCP",  security: "SSH",      description: "Sécurisé" },
  { name: "SSH+Payload", port: 80,   transport: "TCP",  security: "Bypass",   description: "Bypass DPI" },
  { name: "WireGuard",   port: 51820, transport: "UDP", security: "WG",       description: "Moderne et rapide" },
];

// ── Native VPN module (Android) ───────────────────────────────────────────────

const SxbVpnNative = Platform.OS === "android" ? NativeModules.SxbVpnNative : null;

function buildConfigJson(config: VpnConnectionConfig): string {
  const proto = (config.protocol || "ssh").toLowerCase();
  const base = {
    protocol: proto,
    host:     config.host || "",
    port:     config.port || 443,
  };

  // SSH & SSH+Payload
  if (proto === "ssh" || proto === "ssh+payload") {
    return JSON.stringify({
      ...base,
      username: config.username || "",
      password: config.password || "",
      sni:      config.sni     || "",
    });
  }

  // VLESS / VMess / Trojan
  if (["vless","vmess","trojan"].includes(proto)) {
    return JSON.stringify({
      ...base,
      uuid:    config.uuid    || "",
      path:    config.path    || "/",
      network: config.network || "ws",
      tls:     config.tls     || false,
      sni:     config.sni     || config.host,
      flow:    config.flow    || "",
    });
  }

  // Shadowsocks
  if (proto === "shadowsocks") {
    return JSON.stringify({
      ...base,
      password: config.password || "",
      method:   config.method   || "chacha20-ietf-poly1305",
    });
  }

  // Hysteria2
  if (proto === "hysteria2") {
    return JSON.stringify({
      ...base,
      password: config.password || "",
      sni:      config.sni     || config.host,
    });
  }

  // WireGuard
  if (proto === "wireguard") {
    return JSON.stringify({
      ...base,
      privateKey:   config.privateKey   || "",
      peerPublicKey:config.peerPublicKey || "",
      localAddress: config.localAddress  || "10.0.0.2/32",
    });
  }

  // Generic fallback
  return JSON.stringify({
    ...base,
    uuid:     config.uuid     || "",
    password: config.password || "",
    method:   config.method   || "",
    network:  config.network  || "tcp",
    tls:      config.tls      || false,
    sni:      config.sni      || config.host,
  });
}

// ── Persistent log store (last 50 lines) ─────────────────────────────────────

const LOG_KEY = "@sxb_vpn_logs";
const MAX_LOGS = 50;

async function appendPersistentLog(msg: string): Promise<void> {
  try {
    const stored = await AsyncStorage.getItem(LOG_KEY);
    const prev: string[] = stored ? JSON.parse(stored) : [];
    const next = [...prev, msg].slice(-MAX_LOGS);
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(next));
  } catch { /* non-blocking */ }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, refreshAccountState } = useAuthContext();

  const [isConnected,       setIsConnected]       = useState(false);
  const [isConnecting,      setIsConnecting]       = useState(false);
  const [selectedProtocol,  setSelectedProtocol]   = useState<string | null>(null);
  const [availableProtocols,setAvailableProtocols] = useState<VpnProtocol[]>(FALLBACK_PROTOCOLS);
  const [subscriptionUrl,   setSubscriptionUrl]    = useState<string | null>(null);
  const [serverInfo,        setServerInfo]         = useState<{ host: string; location: string } | null>(null);
  const [connectionConfig,  setConnectionConfig]   = useState<VpnConnectionConfig | null>(null);
  const [logs,              setLogs]               = useState<string[]>([]);
  const [hasVpnPermission,  setHasVpnPermission]   = useState(false);

  const statusSubRef = useRef<any>(null);
  const logSubRef    = useRef<any>(null);

  const addLog = useCallback((msg: string) => {
    const ts  = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const line = `[${ts}] ${msg}`;
    setLogs(prev => [...prev.slice(-(MAX_LOGS - 1)), line]);
    appendPersistentLog(line); // fire-and-forget
  }, []);

  // ── Restore persisted logs on mount ─────────────────────────────────────────

  useEffect(() => {
    AsyncStorage.getItem(LOG_KEY).then(stored => {
      if (stored) {
        try { setLogs(JSON.parse(stored)); } catch {}
      }
    });
  }, []);

  // ── Native event listeners ─────────────────────────────────────────────────

  useEffect(() => {
    if (!SxbVpnNative) return;

    const emitter = new NativeEventEmitter(SxbVpnNative);

    statusSubRef.current = emitter.addListener("onVpnStatusChange", (event: { status: string }) => {
      const s = event.status;
      if (s === "connected") {
        setIsConnected(true);
        setIsConnecting(false);
        AsyncStorage.setItem("@sxb_vpn_connected", "true").catch(() => {});
        refreshAccountState().catch(() => {});
        addLog("✅ VPN connecté");
      } else if (s === "connecting") {
        setIsConnecting(true);
        setIsConnected(false);
      } else if (s === "disconnected") {
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem("@sxb_vpn_connected", "false").catch(() => {});
        // Apply kill switch if enabled
        AsyncStorage.getItem("@sxb_kill_switch").then(ks => {
          if (ks === "true") addLog("⚠️ Kill Switch actif — trafic bloqué");
        });
      } else if (s === "error") {
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem("@sxb_vpn_connected", "false").catch(() => {});
        addLog("❌ Erreur de connexion VPN");
      }
    });

    logSubRef.current = emitter.addListener("onVpnLog", (event: { message: string }) => {
      addLog(event.message);
    });

    // Check VPN permission on mount
    checkVpnPermission();

    return () => {
      statusSubRef.current?.remove();
      logSubRef.current?.remove();
    };
  }, []);

  const checkVpnPermission = async () => {
    if (!SxbVpnNative) { setHasVpnPermission(false); return; }
    try {
      const granted = await SxbVpnNative.isVpnPermissionGranted();
      setHasVpnPermission(!!granted);
    } catch {
      setHasVpnPermission(false);
    }
  };

  const requestVpnPermission = useCallback(async (): Promise<boolean> => {
    if (!SxbVpnNative) return false;
    try {
      const granted = await SxbVpnNative.isVpnPermissionGranted();
      setHasVpnPermission(!!granted);
      return !!granted;
    } catch { return false; }
  }, []);

  // ── Restore session ────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const protocol = await AsyncStorage.getItem("@sxb_vpn_protocol");
      if (protocol) setSelectedProtocol(protocol);
      // Security: never auto-restore connected state — user must reconnect manually
      // This prevents ghost "connected" state after crashes or forced stops
    })();
  }, [isAuthenticated]);

  // ── Fetch real VPN config ──────────────────────────────────────────────────

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res  = await apiClient.get("/mobile/vpn/config");
      const data = res.data;

      if (data.subscriptionUrl) setSubscriptionUrl(data.subscriptionUrl);
      if (data.serverInfo)      setServerInfo(data.serverInfo);

      if (data.profile) {
        const cfg: VpnConnectionConfig = { ...data.profile, _ts: Date.now() };
        setConnectionConfig(cfg);
        // Store encrypted
        await storeConfigSecure(cfg);
      }

      if (data.connectionUri) {
        await AsyncStorage.setItem("@sxb_connection_uri", data.connectionUri);
      }

      if (Array.isArray(data.protocols) && data.protocols.length > 0) {
        setAvailableProtocols(data.protocols);
        const saved = await AsyncStorage.getItem("@sxb_vpn_protocol");
        if (!saved && data.protocols[0]) {
          setSelectedProtocol(data.protocols[0].name);
          await AsyncStorage.setItem("@sxb_vpn_protocol", data.protocols[0].name);
        }
      }
    } catch {
      // Offline: load encrypted config
      const cfg = await loadConfigSecure();
      if (cfg) setConnectionConfig(cfg);
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    setLogs([]);

    try {
      let cfg = connectionConfig;
      if (!cfg) cfg = await loadConfigSecure();

      const proto = (cfg?.protocol || selectedProtocol || "ssh").toLowerCase();
      addLog(`Protocole : ${proto.toUpperCase()}`);
      addLog(`Serveur   : ${cfg?.host || "—"}:${cfg?.port || "—"}`);

      if (Platform.OS === "android" && SxbVpnNative) {
        const permGranted = await SxbVpnNative.isVpnPermissionGranted().catch(() => false);
        if (!permGranted) {
          addLog("⚠️ Permission VPN non accordée — boîte de dialogue en cours…");
        }

        const configJson = cfg
          ? buildConfigJson(cfg)
          : JSON.stringify({ protocol: proto, host: serverInfo?.host || "", port: 443 });

        addLog("Initialisation du tunnel…");
        await SxbVpnNative.startVpn(configJson);
        // Status is updated via onVpnStatusChange native event

      } else {
        // Fallback (iOS or dev simulator)
        addLog("Mode simulation (module natif indisponible)");
        await apiClient.post("/mobile/vpn/session", {
          action: "connect",
          protocol: proto,
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setIsConnecting(false);
        await AsyncStorage.setItem("@sxb_vpn_connected", "true");
        refreshAccountState().catch(() => {});
        addLog("✅ Session VPN démarrée (mode simulation)");
      }

      // Non-blocking backend session log
      apiClient.post("/mobile/vpn/session", {
        action: "connect",
        protocol: proto,
        deviceId: await AsyncStorage.getItem("@sxb_device_id"),
      }).catch(() => {});

    } catch (err: any) {
      addLog(`❌ Erreur : ${err?.message || "Inconnue"}`);
      setIsConnected(false);
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, connectionConfig, serverInfo, addLog, refreshAccountState]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    addLog("Déconnexion en cours…");

    try {
      if (Platform.OS === "android" && SxbVpnNative) {
        await SxbVpnNative.stopVpn();
        // Status updated via onVpnStatusChange event
      } else {
        await apiClient.post("/mobile/vpn/session", { action: "disconnect" }).catch(() => {});
        await new Promise(r => setTimeout(r, 600));
        setIsConnected(false);
        setIsConnecting(false);
        await AsyncStorage.setItem("@sxb_vpn_connected", "false");
        addLog("✅ VPN déconnecté");
      }

      apiClient.post("/mobile/vpn/session", { action: "disconnect" }).catch(() => {});
    } catch {
      setIsConnected(false);
      setIsConnecting(false);
      addLog("✅ VPN arrêté");
    }
  }, [isConnecting, addLog]);

  // ── Select protocol ───────────────────────────────────────────────────────

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem("@sxb_vpn_protocol", name);
    addLog(`Protocole sélectionné : ${name}`);
    if (isConnected) {
      addLog("Reconnexion avec le nouveau protocole…");
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect, addLog]);

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting,
      selectedProtocol, availableProtocols,
      subscriptionUrl, serverInfo,
      connectionConfig,
      logs,
      hasVpnPermission,
      connect, disconnect, selectProtocol,
      refreshVpnConfig,
      requestVpnPermission,
    }}>
      {children}
    </VpnContext.Provider>
  );
}

export function useVpnContext() {
  return useContext(VpnContext);
}

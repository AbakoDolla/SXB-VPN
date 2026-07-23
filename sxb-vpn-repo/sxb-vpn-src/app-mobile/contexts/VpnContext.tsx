/**
 * VpnContext — SXB VPN Mobile v4
 *
 * ═══════════════════════════════════════════════════════════════════
 * AMÉLIORATIONS v4
 * ═══════════════════════════════════════════════════════════════════
 *  ✅ Config chiffrée  — expo-secure-store (Android Keystore AES-256)
 *  ✅ Kill Switch      — état persistant, transmis au service natif
 *  ✅ Auto-Reconnect   — toggle persistant + transmission au service
 *  ✅ TrafficStats     — affichage upload/download/débit en temps réel
 *  ✅ Bouton Refresh   — synchronisation delta avec le backend
 *  ✅ Session offline  — config disponible sans réseau
 *  ✅ Logs sécurisés   — données sensibles masquées
 */

import React, {
  createContext, useCallback, useContext,
  useEffect, useRef, useState
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import apiClient from "@/services/apiClient";
import { useAuthContext } from "./AuthContext";

// ── Clés de stockage ──────────────────────────────────────────────────────────
const STORE = {
  CONFIG:          "sxb_vpn_cfg_v4",     // SecureStore (Keystore AES-256)
  PROTOCOL:        "@sxb_vpn_protocol",
  CONNECTED:       "@sxb_vpn_connected",
  KILL_SWITCH:     "@sxb_vpn_ks",
  AUTO_RECONNECT:  "@sxb_vpn_ar",
  SUB_URL:         "@sxb_connection_uri",
  SERVER_INFO:     "@sxb_server_info",
  LOGS:            "@sxb_vpn_logs_v2",
} as const;

// ── Stockage sécurisé config VPN (Android Keystore via expo-secure-store) ─────
async function storeConfigSecure(config: VpnConnectionConfig): Promise<void> {
  const raw = JSON.stringify(config);
  if (Platform.OS !== "web") {
    await SecureStore.setItemAsync(STORE.CONFIG, raw, {
      keychainAccessible: SecureStore.ALWAYS,    // accessible même hors ligne
    });
  } else {
    await AsyncStorage.setItem("@" + STORE.CONFIG, raw);
  }
  // Supprimer les anciennes clés legacy
  await Promise.all([
    AsyncStorage.removeItem("@sxb_vpn_config"),
    AsyncStorage.removeItem("@sxb_vpn_cfg_v2"),
  ]).catch(() => {});
}

async function loadConfigSecure(): Promise<VpnConnectionConfig | null> {
  try {
    if (Platform.OS !== "web") {
      const raw = await SecureStore.getItemAsync(STORE.CONFIG);
      if (raw) return JSON.parse(raw);
    } else {
      const raw = await AsyncStorage.getItem("@" + STORE.CONFIG);
      if (raw) return JSON.parse(raw);
    }
    // Fallback : lire l'ancienne config XOR (migration)
    const legacy = await AsyncStorage.getItem("@sxb_vpn_cfg_v2");
    if (legacy) {
      // Décodage XOR v3 (legacy)
      const xorKey = "SXB_VPN_K3Y_S4LT_2026";
      const HEX_PREFIX = "H:";
      let cfg: VpnConnectionConfig | null = null;
      if (legacy.startsWith(HEX_PREFIX)) {
        const hex = legacy.slice(HEX_PREFIX.length);
        let result = "";
        for (let i = 0; i < hex.length; i += 4) {
          const code = parseInt(hex.substring(i, i + 4), 16);
          result += String.fromCharCode(code ^ xorKey.charCodeAt((i / 4) % xorKey.length));
        }
        cfg = JSON.parse(result);
      }
      if (cfg) {
        await storeConfigSecure(cfg);   // migrer vers Keystore
        await AsyncStorage.removeItem("@sxb_vpn_cfg_v2");
        return cfg;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
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
  payload?: string;
  usePayload?: boolean;
  connectionUri?: string | null;
  profileName?: string;
  subscriptionName?: string;
  [key: string]: unknown;
}

export interface TrafficStats {
  uploadBytes: number;
  downloadBytes: number;
  uploadSpeed: number;    // bytes/sec
  downloadSpeed: number;  // bytes/sec
  sessionStart: number;   // timestamp ms
}

interface VpnContextType {
  isConnected: boolean;
  isConnecting: boolean;
  selectedProtocol: string;
  availableProtocols: VpnProtocol[];
  subscriptionUrl: string | null;
  serverInfo: string | null;
  connectionConfig: VpnConnectionConfig | null;
  logs: string[];
  hasVpnPermission: boolean;
  killSwitch: boolean;
  autoReconnect: boolean;
  traffic: TrafficStats;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  selectProtocol: (name: string) => Promise<void>;
  refreshVpnConfig: () => Promise<void>;
  requestVpnPermission: () => Promise<boolean>;
  setKillSwitch: (enabled: boolean) => Promise<void>;
  setAutoReconnect: (enabled: boolean) => Promise<void>;
  manuallySetConfig: (config: VpnConnectionConfig) => Promise<void>;
}

// ── Contexte ─────────────────────────────────────────────────────────────────
const VpnContext = createContext<VpnContextType>({
  isConnected: false, isConnecting: false,
  selectedProtocol: "", availableProtocols: [],
  subscriptionUrl: null, serverInfo: null, connectionConfig: null,
  logs: [], hasVpnPermission: false,
  killSwitch: false, autoReconnect: true,
  traffic: { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0, sessionStart: 0 },
  connect: async () => {}, disconnect: async () => {},
  selectProtocol: async () => {}, refreshVpnConfig: async () => {},
  requestVpnPermission: async () => false,
  setKillSwitch: async () => {}, setAutoReconnect: async () => {},
  manuallySetConfig: async () => {},
});

// ── Module natif ──────────────────────────────────────────────────────────────
const SxbVpnNative = NativeModules.SxbVpnNative ?? null;
const vpnEmitter   = SxbVpnNative ? new NativeEventEmitter(SxbVpnNative) : null;

// ── Masquage données sensibles dans les logs ──────────────────────────────────
function maskLog(line: string): string {
  return line
    .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, "*.*.*.*")
    .replace(/password[=:]\s*\S+/gi, "password=********")
    .replace(/username[=:]\s*\S+/gi, "username=********")
    .replace(/uuid[=:]\s*[\w-]+/gi, "uuid=********")
    .replace(/key[=:]\s*[A-Za-z0-9+/=]{10,}/gi, "key=********");
}

// ── Formatage trafic ──────────────────────────────────────────────────────────
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1_048_576) return `${(bytesPerSec / 1_048_576).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1_024)     return `${(bytesPerSec / 1_024).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Provider
// ═════════════════════════════════════════════════════════════════════════════

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { refreshAccountState, deviceId } = useAuthContext();

  // ── État ──────────────────────────────────────────────────────────────────
  const [isConnected,         setIsConnected]         = useState(false);
  const [isConnecting,        setIsConnecting]        = useState(false);
  const [selectedProtocol,    setSelectedProtocol]    = useState("");
  const [availableProtocols,  setAvailableProtocols]  = useState<VpnProtocol[]>([]);
  const [subscriptionUrl,     setSubscriptionUrl]     = useState<string | null>(null);
  const [serverInfo,          setServerInfo]          = useState<string | null>(null);
  const [connectionConfig,    setConnectionConfig]    = useState<VpnConnectionConfig | null>(null);
  const [subscriptionId,      setSubscriptionId]      = useState<string | null>(null);
  const [logs,                setLogs]                = useState<string[]>([]);
  const [hasVpnPermission,    setHasVpnPermission]    = useState(false);
  const [killSwitch,          setKillSwitchState]     = useState(false);
  const [autoReconnect,       setAutoReconnectState]  = useState(true);
  const [traffic,             setTraffic]             = useState<TrafficStats>({
    uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0, sessionStart: 0,
  });

  // Refs
  const connectTimeout   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trafficTimer     = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef  = useRef<number>(0);

  // ── Helpers logs ──────────────────────────────────────────────────────────
  const addLog = useCallback((line: string) => {
    const masked = maskLog(line);
    setLogs(prev => {
      const next = [...prev, masked].slice(-100);
      // Persister les 50 dernières lignes
      AsyncStorage.setItem(STORE.LOGS, JSON.stringify(next.slice(-50))).catch(() => {});
      return next;
    });
  }, []);

  // ── Événements natifs ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!vpnEmitter) return;

    const stateSubscription = vpnEmitter.addListener("onVpnStateChange", (evt: { status: string }) => {
      const s = evt.status;
      if (s === "connected") {
        clearTimeout(connectTimeout.current!);
        connectTimeout.current = null;
        setIsConnected(true);
        setIsConnecting(false);
        sessionStartRef.current = Date.now();
        AsyncStorage.setItem(STORE.CONNECTED, "true").catch(() => {});
        addLog("✅ VPN connecté");
      } else if (s === "connecting") {
        setIsConnecting(true);
      } else if (s === "disconnected") {
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem(STORE.CONNECTED, "false").catch(() => {});
        addLog("⏹ VPN déconnecté");
        stopTrafficPoller();
      } else if (s === "error") {
        clearTimeout(connectTimeout.current!);
        connectTimeout.current = null;
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem(STORE.CONNECTED, "false").catch(() => {});
        stopTrafficPoller();
      }
    });

    const logSubscription = vpnEmitter.addListener("onVpnLog", (evt: { message: string }) => {
      addLog(evt.message);
    });

    return () => {
      stateSubscription.remove();
      logSubscription.remove();
    };
  }, [addLog]);

  // ── Permission VPN ────────────────────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS === "android" && SxbVpnNative) {
      const granted = SxbVpnNative.isVpnPermissionGranted?.() ?? false;
      setHasVpnPermission(granted);
    } else {
      setHasVpnPermission(true);
    }
  }, []);

  const requestVpnPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "android" || !SxbVpnNative) return true;
    try {
      const granted: boolean = await SxbVpnNative.requestVpnPermission();
      setHasVpnPermission(granted);
      return granted;
    } catch { return false; }
  }, []);

  // ── Chargement initial ────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [cfg, proto, ks, ar, subUrl, serverInfoStr, savedLogs] = await Promise.all([
        loadConfigSecure(),
        AsyncStorage.getItem(STORE.PROTOCOL),
        AsyncStorage.getItem(STORE.KILL_SWITCH),
        AsyncStorage.getItem(STORE.AUTO_RECONNECT),
        AsyncStorage.getItem(STORE.SUB_URL),
        AsyncStorage.getItem(STORE.SERVER_INFO),
        AsyncStorage.getItem(STORE.LOGS),
      ]);

      if (cfg) setConnectionConfig(cfg);
      if (proto) setSelectedProtocol(proto);
      if (ks !== null) setKillSwitchState(ks === "true");
      if (ar !== null) setAutoReconnectState(ar !== "false");  // true par défaut
      if (subUrl) setSubscriptionUrl(subUrl);
      if (serverInfoStr) setServerInfo(serverInfoStr);
      if (savedLogs) {
        try { setLogs(JSON.parse(savedLogs)); } catch {}
      }
    })();
  }, []);

  // ── TrafficStats poller ───────────────────────────────────────────────────
  const startTrafficPoller = useCallback(() => {
    if (trafficTimer.current) return;
    trafficTimer.current = setInterval(async () => {
      if (!SxbVpnNative?.getTrafficStats) return;
      try {
        const stats = await SxbVpnNative.getTrafficStats();
        setTraffic({
          uploadBytes:   stats.uploadBytes   ?? 0,
          downloadBytes: stats.downloadBytes ?? 0,
          uploadSpeed:   stats.uploadSpeed   ?? 0,
          downloadSpeed: stats.downloadSpeed ?? 0,
          sessionStart:  sessionStartRef.current,
        });
      } catch {}
    }, 2_000);
  }, []);

  const stopTrafficPoller = useCallback(() => {
    if (trafficTimer.current) {
      clearInterval(trafficTimer.current);
      trafficTimer.current = null;
    }
  }, []);

  // Démarrer le poller quand connecté
  useEffect(() => {
    if (isConnected) {
      startTrafficPoller();
    } else {
      stopTrafficPoller();
    }
  }, [isConnected, startTrafficPoller, stopTrafficPoller]);

  // Synchro trafic vers backend toutes les 90s (et de l'usage pour le Dashboard)
  useEffect(() => {
    if (!isConnected) return;

    const syncTimer = setInterval(async () => {
      if (!traffic.uploadBytes && !traffic.downloadBytes) return;
      const duration = Math.round((Date.now() - sessionStartRef.current) / 1000);
      try {
        // Envoi au nouvel endpoint Dashboard /mobile/vpn/usage
        await apiClient.post("/mobile/vpn/usage", {
          download:       traffic.downloadBytes,
          upload:         traffic.uploadBytes,
          duration,
          deviceId:       deviceId || undefined,
          subscriptionId: subscriptionId || undefined,
        });

        // Envoi au fallback historique /mobile/vpn/traffic
        await apiClient.post("/mobile/vpn/traffic", {
          bytesUp:   traffic.uploadBytes,
          bytesDown: traffic.downloadBytes,
        });
      } catch {}
    }, 90_000);

    return () => clearInterval(syncTimer);
  }, [isConnected, traffic, deviceId, subscriptionId]);

  // ── Kill Switch ───────────────────────────────────────────────────────────
  const setKillSwitch = useCallback(async (enabled: boolean) => {
    setKillSwitchState(enabled);
    await AsyncStorage.setItem(STORE.KILL_SWITCH, String(enabled));
    SxbVpnNative?.setKillSwitch?.(enabled);
    addLog(`Kill Switch : ${enabled ? "activé" : "désactivé"}`);
  }, [addLog]);

  // ── Auto-Reconnect ────────────────────────────────────────────────────────
  const setAutoReconnect = useCallback(async (enabled: boolean) => {
    setAutoReconnectState(enabled);
    await AsyncStorage.setItem(STORE.AUTO_RECONNECT, String(enabled));
    SxbVpnNative?.setAutoReconnect?.(enabled);
    addLog(`Auto-reconnect : ${enabled ? "activé" : "désactivé"}`);
  }, [addLog]);

  // ── Refresh config depuis le backend ──────────────────────────────────────
  const refreshVpnConfig = useCallback(async () => {
    addLog("🔄 Synchronisation configuration...");
    try {
      const res = await apiClient.get("/mobile/vpn/config");
      const data = res.data;

      if (!data) { addLog("ℹ️ Aucune configuration disponible"); return; }

      // Conserver l'ancienne config en cas d'erreur (rollback automatique)
      const previousConfig = connectionConfig;

      try {
        const newCfg: VpnConnectionConfig = {
          protocol: data.protocol ?? previousConfig?.protocol ?? "",
          host:     data.host     ?? previousConfig?.host     ?? "",
          port:     data.port     ?? previousConfig?.port     ?? 0,
          ...data,
          profileName:      data.profileName      ?? data.name,
          subscriptionName: data.subscriptionName ?? "",
        };

        await storeConfigSecure(newCfg);
        setConnectionConfig(newCfg);

        if (data.connectionUri) {
          await AsyncStorage.setItem(STORE.SUB_URL, data.connectionUri);
          setSubscriptionUrl(data.connectionUri);
        }

        if (data.protocols?.length) {
          setAvailableProtocols(data.protocols);
          if (!selectedProtocol && data.protocols[0]?.name) {
            setSelectedProtocol(data.protocols[0].name);
          }
        }

        if (data.serverInfo) {
          setServerInfo(data.serverInfo);
          await AsyncStorage.setItem(STORE.SERVER_INFO, data.serverInfo);
        }

        if (data.subscription?.id) {
          setSubscriptionId(data.subscription.id);
        }

        addLog("✅ Configuration synchronisée avec succès");
      } catch (parseErr) {
        // Rollback : conserver l'ancienne config
        if (previousConfig) {
          setConnectionConfig(previousConfig);
          await storeConfigSecure(previousConfig);
        }
        addLog("⚠️ Erreur de format — ancienne configuration conservée");
      }

    } catch (err: unknown) {
      // Hors ligne ou erreur serveur — la config locale est conservée
      addLog("⚠️ Synchronisation impossible — configuration locale maintenue");
    }
  }, [connectionConfig, selectedProtocol, addLog]);

  useEffect(() => { refreshVpnConfig(); }, []);  // eslint-disable-line

  // ── Connexion ─────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;

    try {
      setIsConnecting(true);
      addLog("🔌 Démarrage de la connexion VPN...");

      // Permission VPN
      if (Platform.OS === "android") {
        const granted = await requestVpnPermission();
        if (!granted) {
          addLog("❌ Permission VPN refusée");
          setIsConnecting(false);
          return;
        }
      }

      // Charger config
      let cfg = connectionConfig ?? await loadConfigSecure();
      if (!cfg) {
        addLog("❌ Aucune configuration VPN — actualisez ou activez un forfait");
        setIsConnecting(false);
        return;
      }

      // Sélectionner le protocole
      const proto = (selectedProtocol || cfg.protocol || "").toLowerCase();
      if (!proto) {
        addLog("❌ Aucun protocole sélectionné");
        setIsConnecting(false);
        return;
      }

      // Injecter killSwitch + autoReconnect dans la config
      const startOpts = {
        ...cfg,
        protocol:      proto,
        killSwitch:    killSwitch,
        autoReconnect: autoReconnect,
      };

      if (Platform.OS === "android" && SxbVpnNative) {
        addLog(`🔌 Connexion ${proto.toUpperCase()}...`);
        await SxbVpnNative.startVpn(JSON.stringify(startOpts));
      } else {
        throw new Error("Moteur VPN réel uniquement supporté sur Android avec le module natif SXB");
      }

      // Timeout de sécurité 65s
      if (connectTimeout.current) clearTimeout(connectTimeout.current);
      connectTimeout.current = setTimeout(() => {
        if (!isConnected) {
          addLog("❌ Timeout — connexion impossible");
          setIsConnecting(false);
          setIsConnected(false);
          AsyncStorage.setItem(STORE.CONNECTED, "false").catch(() => {});
          connectTimeout.current = null;
        }
      }, 65_000);

      // Notifier le backend
      apiClient.post("/mobile/vpn/session", {
        action: "connect",
        protocol: proto,
      }).catch(() => {});

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "erreur inconnue";
      addLog(`❌ Erreur de connexion : ${maskLog(msg)}`);
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, connectionConfig, selectedProtocol, killSwitch, autoReconnect,
      addLog, requestVpnPermission]);

  // ── Déconnexion ───────────────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (!isConnecting && !isConnected) return;
    try {
      addLog("⏹ Déconnexion...");
      setIsConnecting(false);
      await AsyncStorage.setItem(STORE.CONNECTED, "false");

      if (Platform.OS === "android" && SxbVpnNative) {
        await SxbVpnNative.stopVpn();
        await new Promise(r => setTimeout(r, 600));
      }
      setIsConnected(false);
      addLog("✅ VPN déconnecté");

      // Envoi final des stats de trafic
      if (traffic.uploadBytes || traffic.downloadBytes) {
        const dur = Math.round((Date.now() - sessionStartRef.current) / 1000);
        apiClient.post("/mobile/vpn/usage", {
          download:       traffic.downloadBytes,
          upload:         traffic.uploadBytes,
          duration:       dur,
          deviceId:       deviceId || undefined,
          subscriptionId: subscriptionId || undefined,
        }).catch(() => {});

        apiClient.post("/mobile/vpn/traffic", {
          bytesUp:   traffic.uploadBytes,
          bytesDown: traffic.downloadBytes,
        }).catch(() => {});
      }

      apiClient.post("/mobile/vpn/session", { action: "disconnect" }).catch(() => {});

    } catch {
      setIsConnected(false);
      setIsConnecting(false);
      addLog("✅ VPN arrêté");
    }
  }, [isConnecting, isConnected, traffic, addLog]);

  // ── Sélection protocole ───────────────────────────────────────────────────
  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem(STORE.PROTOCOL, name);
    addLog(`Protocole sélectionné : ${name}`);
    if (isConnected) {
      addLog("🔄 Reconnexion avec le nouveau protocole...");
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect, addLog]);

  const manuallySetConfig = useCallback(async (cfg: VpnConnectionConfig) => {
    await storeConfigSecure(cfg);
    setConnectionConfig(cfg);
    if (cfg.protocol) {
      setSelectedProtocol(cfg.protocol.toUpperCase());
      await AsyncStorage.setItem(STORE.PROTOCOL, cfg.protocol.toUpperCase());
    }
    addLog("✅ Nouvelle configuration V2Ray JSON appliquée manuellement");
  }, [addLog]);

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting,
      selectedProtocol, availableProtocols,
      subscriptionUrl, serverInfo,
      connectionConfig,
      logs,
      hasVpnPermission,
      killSwitch,
      autoReconnect,
      traffic,
      connect, disconnect, selectProtocol,
      refreshVpnConfig,
      requestVpnPermission,
      setKillSwitch,
      setAutoReconnect,
      manuallySetConfig,
    }}>
      {children}
    </VpnContext.Provider>
  );
}

export function useVpnContext() {
  return useContext(VpnContext);
}

/**
 * VpnContext — SXB VPN Mobile
 * Gestion de la connexion VPN avec :
 * - Chiffrement léger de la config stockée localement
 * - Support multi-protocoles (SSH, VLESS, VMess, Trojan, Shadowsocks, Hysteria2, WireGuard, TUIC)
 * - Logs persistants (50 dernières lignes)
 * - Kill switch state
 * - Mode offline (config chiffrée locale)
 * - Permission VPN correctement gérée (popup Android réelle)
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, NativeEventEmitter, Platform } from "react-native";
import apiClient from "@/services/apiClient";
import { useAuthContext } from "./AuthContext";

// ── Minimal symmetric XOR cipher for local config storage ─────────────────────
const CONFIG_KEY_SALT = "SXB_VPN_K3Y_S4LT_2026";

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
  await AsyncStorage.removeItem("@sxb_vpn_config").catch(() => {});
}

async function loadConfigSecure(): Promise<VpnConnectionConfig | null> {
  const encoded = await AsyncStorage.getItem("@sxb_vpn_cfg_v2");
  if (encoded) {
    try { return JSON.parse(xorDecode(encoded, CONFIG_KEY_SALT)); } catch { return null; }
  }
  const legacy = await AsyncStorage.getItem("@sxb_vpn_config");
  if (legacy) {
    try {
      const cfg = JSON.parse(legacy);
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
  payload?: string;  // SSH+Payload : headers HTTP injectés avant handshake SSH
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
  selectProtocol: (name: string) => Promise<void>;
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
  selectProtocol: async () => {},
  refreshVpnConfig: async () => {},
  requestVpnPermission: async () => false,
});

// ── Fallback protocols ────────────────────────────────────────────────────────

const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: "SSH",         port: 443,   transport: "TCP",  security: "SSH",      description: "Sécurisé — tunnel direct" },
  { name: "SSH+Payload", port: 80,    transport: "TCP",  security: "Bypass",   description: "Bypass DPI — HTTPS fake" },
  { name: "VLESS",       port: 443,   transport: "TCP",  security: "TLS",      description: "Léger et moderne" },
  { name: "VMess",       port: 443,   transport: "WS",   security: "TLS",      description: "Stable — obfusqué" },
  { name: "Trojan",      port: 443,   transport: "TCP",  security: "TLS",      description: "Stable — imite HTTPS" },
  { name: "Shadowsocks", port: 8388,  transport: "TCP",  security: "ChaCha20", description: "Léger et rapide" },
  { name: "Hysteria2",   port: 443,   transport: "QUIC", security: "TLS",      description: "Très rapide — UDP" },
  { name: "WireGuard",   port: 51820, transport: "UDP",  security: "WG",       description: "Moderne et rapide" },
];

// ── Native VPN module (Android) ───────────────────────────────────────────────

const SxbVpnNative = Platform.OS === "android" ? NativeModules.SxbVpnNative : null;

function buildConfigJson(config: VpnConnectionConfig): string {
  const proto = (config.protocol || "ssh").toLowerCase();
  const base = { protocol: proto, host: config.host || "", port: config.port || 443 };

  if (proto === "ssh" || proto === "ssh+payload") {
    return JSON.stringify({ ...base, username: config.username || "", password: config.password || "", sni: config.sni || "", payload: config.payload || "" });
  }
  if (["vless","vmess","trojan"].includes(proto)) {
    return JSON.stringify({ ...base, uuid: config.uuid || "", path: config.path || "/", network: config.network || "ws", tls: config.tls ?? false, sni: config.sni || config.host, flow: config.flow || "", password: config.password || "" });
  }
  if (proto === "shadowsocks") {
    return JSON.stringify({ ...base, password: config.password || "", method: config.method || "chacha20-ietf-poly1305" });
  }
  if (proto === "hysteria2") {
    return JSON.stringify({ ...base, password: config.password || "", sni: config.sni || config.host, tls: true });
  }
  if (proto === "tuic") {
    return JSON.stringify({ ...base, uuid: config.uuid || "", password: config.password || "", sni: config.sni || config.host, tls: true });
  }
  if (proto === "wireguard") {
    return JSON.stringify({ ...base, privateKey: config.privateKey || "", peerPublicKey: config.peerPublicKey || "", localAddress: config.localAddress || "10.0.0.2/32" });
  }
  return JSON.stringify({ ...base, uuid: config.uuid || "", password: config.password || "", method: config.method || "", network: config.network || "tcp", tls: config.tls || false, sni: config.sni || config.host });
}

// ── Persistent log store ──────────────────────────────────────────────────────

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

  const [isConnected,        setIsConnected]        = useState(false);
  const [isConnecting,       setIsConnecting]        = useState(false);
  const [selectedProtocol,   setSelectedProtocol]    = useState<string | null>(null);
  const [availableProtocols, setAvailableProtocols]  = useState<VpnProtocol[]>(FALLBACK_PROTOCOLS);
  const [subscriptionUrl,    setSubscriptionUrl]     = useState<string | null>(null);
  const [serverInfo,         setServerInfo]          = useState<{ host: string; location: string } | null>(null);
  const [connectionConfig,   setConnectionConfig]    = useState<VpnConnectionConfig | null>(null);
  const [logs,               setLogs]                = useState<string[]>([]);
  const [hasVpnPermission,   setHasVpnPermission]    = useState(false);

  const statusSubRef   = useRef<any>(null);
  const logSubRef      = useRef<any>(null);
  const connectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Log helper ────────────────────────────────────────────────────────────

  const addLog = useCallback((msg: string) => {
    const line = `[${new Date().toLocaleTimeString("fr-FR")}] ${msg}`;
    setLogs(prev => [...prev.slice(-49), line]);
    appendPersistentLog(line);
  }, []);

  // ── Native events ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!SxbVpnNative) return;

    const emitter = new NativeEventEmitter(SxbVpnNative);

    statusSubRef.current = emitter.addListener("onVpnStateChange", (event: { status: string }) => {
      const s = event.status;
      addLog(`État VPN : ${s}`);
      if (s === "connected") {
        if (connectTimeout.current) { clearTimeout(connectTimeout.current); connectTimeout.current = null; }
        setIsConnected(true);
        setIsConnecting(false);
        AsyncStorage.setItem("@sxb_vpn_connected", "true").catch(() => {});
        refreshAccountState().catch(() => {});
      } else if (s === "connecting") {
        setIsConnected(false);
        setIsConnecting(true);
      } else if (s === "disconnected") {
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem("@sxb_vpn_connected", "false").catch(() => {});
        AsyncStorage.getItem("@sxb_kill_switch").then(ks => {
          if (ks === "true") addLog("⚠️ Kill Switch actif — trafic bloqué");
        });
      } else if (s === "error") {
        if (connectTimeout.current) { clearTimeout(connectTimeout.current); connectTimeout.current = null; }
        setIsConnected(false);
        setIsConnecting(false);
        AsyncStorage.setItem("@sxb_vpn_connected", "false").catch(() => {});
      }
    });

    logSubRef.current = emitter.addListener("onVpnLog", (event: { message: string }) => {
      addLog(event.message);
    });

    checkVpnPermission();

    return () => {
      statusSubRef.current?.remove();
      logSubRef.current?.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkVpnPermission = async () => {
    if (!SxbVpnNative) { setHasVpnPermission(false); return; }
    try {
      const granted = SxbVpnNative.isVpnPermissionGranted();
      setHasVpnPermission(!!granted);
    } catch {
      setHasVpnPermission(false);
    }
  };

  // ── requestVpnPermission — CORRECTIF : déclenche la popup Android réelle ──

  const requestVpnPermission = useCallback(async (): Promise<boolean> => {
    if (!SxbVpnNative || Platform.OS !== "android") return true;
    try {
      // Vérifier d'abord si déjà accordée (synchrone)
      const alreadyGranted = SxbVpnNative.isVpnPermissionGranted();
      if (alreadyGranted) {
        setHasVpnPermission(true);
        return true;
      }
      // Déclencher la popup Android (asynchrone — attend le résultat de l'Activity)
      const granted = await SxbVpnNative.requestVpnPermission();
      setHasVpnPermission(!!granted);
      return !!granted;
    } catch (e: any) {
      addLog(`❌ Erreur permission VPN : ${e?.message || "Inconnue"}`);
      return false;
    }
  }, [addLog]);

  // ── Restore session ────────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      const protocol = await AsyncStorage.getItem("@sxb_vpn_protocol");
      if (protocol) setSelectedProtocol(protocol);
      // Ne jamais restaurer l'état "connecté" automatiquement — l'utilisateur doit
      // reconnecter manuellement. Évite les états fantômes après crash.
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
        await storeConfigSecure(cfg);
        addLog("✅ Configuration VPN synchronisée depuis le serveur");
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
      // Mode offline : charger la config locale chiffrée
      const cfg = await loadConfigSecure();
      if (cfg) {
        setConnectionConfig(cfg);
        addLog("📦 Configuration chargée depuis le cache local (hors ligne)");
      }
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated, addLog]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    setLogs([]);

    try {
      let cfg = connectionConfig;
      if (!cfg) cfg = await loadConfigSecure();

      // Vérifier que la config est complète avant de tenter la connexion
      if (!cfg) {
        addLog("❌ Aucune configuration VPN trouvée — importez ou activez un forfait");
        setIsConnecting(false);
        return;
      }
      if (!cfg.host) {
        addLog("❌ Configuration incomplète : serveur (host) manquant");
        setIsConnecting(false);
        return;
      }
      const proto = (cfg?.protocol || selectedProtocol || "ssh").toLowerCase();
      if ((proto === "ssh" || proto === "ssh+payload") && !cfg.username) {
        addLog("❌ Configuration SSH incomplète : nom d'utilisateur manquant — resynchronisez votre configuration");
        setIsConnecting(false);
        return;
      }

      addLog(`Protocole : ${proto.toUpperCase()}`);
      if (cfg?.host) addLog(`Serveur   : ${cfg.host}:${cfg.port}`);

      if (Platform.OS === "android" && SxbVpnNative) {
        // ── Étape 1 : Vérifier / demander la permission VPN ─────────────────
        const alreadyGranted = SxbVpnNative.isVpnPermissionGranted();
        if (!alreadyGranted) {
          addLog("🔐 Demande d'autorisation VPN Android…");
          const granted = await requestVpnPermission();
          if (!granted) {
            addLog("❌ Autorisation VPN refusée — connexion annulée");
            setIsConnecting(false);
            return;
          }
          addLog("✅ Autorisation VPN accordée");
        }

        // ── Étape 2 : Construire la config et démarrer ──────────────────────
        const configJson = cfg
          ? buildConfigJson(cfg)
          : JSON.stringify({ protocol: proto, host: serverInfo?.host || "", port: 443 });

        addLog("Initialisation du tunnel…");
        await SxbVpnNative.startVpn(configJson);
        // L'état sera mis à jour via les events natifs (onVpnStateChange)
        // Timeout de sécurité : si après 65s toujours pas d'état "connected" ou "error",
        // on reset l'état pour ne pas laisser l'interface bloquée indéfiniment
        if (connectTimeout.current) clearTimeout(connectTimeout.current);
        connectTimeout.current = setTimeout(() => {
          setIsConnecting(prev => {
            if (prev) {
              addLog("⏱️ Délai dépassé — connexion annulée (serveur injoignable ?)");
              setIsConnected(false);
              AsyncStorage.setItem("@sxb_vpn_connected", "false").catch(() => {});
            }
            return false;
          });
          connectTimeout.current = null;
        }, 65_000);

      } else {
        // Fallback simulateur iOS / dev
        addLog("Mode simulation (module natif indisponible sur cette plateforme)");
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

      // Log de session (non-bloquant)
      apiClient.post("/mobile/vpn/session", {
        action: "connect",
        protocol: proto,
        deviceId: await AsyncStorage.getItem("@sxb_device_id"),
      }).catch(() => {});

    } catch (err: any) {
      const msg = err?.message || "Erreur inconnue";
      // Si la permission est requise, la demander automatiquement
      if (msg.includes("VPN_PERMISSION_REQUIRED") || msg.includes("permission")) {
        addLog("🔐 Permission VPN requise — affichage de la demande…");
        setIsConnecting(false);
        const granted = await requestVpnPermission();
        if (granted) {
          // Réessayer la connexion après accord de permission
          connect();
        }
        return;
      }
      addLog(`❌ Erreur : ${msg}`);
      setIsConnected(false);
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, connectionConfig, serverInfo, addLog, refreshAccountState, requestVpnPermission]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    if (!isConnecting && !isConnected) return;
    addLog("Déconnexion en cours…");

    // ── Réinitialiser l'état local immédiatement ──────────────────────────
    // Ne pas attendre les events natifs — si le service est crashé ou bloqué,
    // les events n'arriveront jamais et l'interface restera figée.
    setIsConnected(false);
    setIsConnecting(false);
    await AsyncStorage.setItem("@sxb_vpn_connected", "false").catch(() => {});

    try {
      if (Platform.OS === "android" && SxbVpnNative) {
        await SxbVpnNative.stopVpn();
        // État déjà réinitialisé ci-dessus
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
  }, [isConnecting, isConnected, addLog]);

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


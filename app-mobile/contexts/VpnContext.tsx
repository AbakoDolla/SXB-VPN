/**
 * VpnContext — Moteur VPN réel SXB v5.1
 *
 * Sur Android : utilise le module natif SxbVpnNative (SxbVpnService.kt)
 *   - requestVpnPermission → dialog système Android
 *   - startVpn(json)       → démarre le vrai tunnel VPN (SSH / sing-box)
 *   - stopVpn()            → arrête proprement le service
 *   - getTrafficStats()    → données réelles via Android TrafficStats
 *   - events : onVpnStateChange, onVpnLog
 *
 * Hors Android (dev web / iOS) : bridge stub sans crash
 */

import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { legacyDebugLog } from '@/services/secureLogger';
import {
  NativeModules, NativeEventEmitter, Platform, PermissionsAndroid,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import { saveVpnConfig, loadVpnConfig, saveQuotaData, loadQuotaData, isQuotaExhausted, isConfigExpired } from '@/services/offlineStorage';
import type { QuotaData } from '@/services/offlineStorage';
import { provisionAndStore, loadProvisionedConfig, clearProvisionedConfig } from '@/services/provisionClient';
import {
  isCompleteOfflineConfig,
  mergeConnectionMetadata,
  mergeProvisionedConfig,
  sanitizeEngineConfig,
  detectProtocolFromFields,
} from '@/services/configValidator';
import { useAuthContext } from './AuthContext';
import type { VpnConnection } from '@/types/api';

// ── Helper : sauvegarde protégée (jamais de config incomplète) ──────────────────
// Retourne true si la config a été sauvegardée, false si elle était incomplète.
async function saveCompleteConfig(
  config: Record<string, any>,
  protocol: string,
  configId?: string,
  expiresAt?: string | null,
): Promise<boolean> {
  const check = isCompleteOfflineConfig(config);
  if (!check.complete) {
    console.warn(`[SXB] saveCompleteConfig refusé — champs manquants: ${check.missing.join(', ')}`);
    return false;
  }
  await saveVpnConfig(config, protocol, configId, expiresAt);
  return true;
}

// ── Native bridge ─────────────────────────────────────────────────────────────

const IS_ANDROID = Platform.OS === 'android';
const SxbVpnNative = IS_ANDROID ? (NativeModules.SxbVpnNative as any) : null;
const vpnEmitter   = SxbVpnNative ? new NativeEventEmitter(SxbVpnNative) : null;

// ── Protocol types ────────────────────────────────────────────────────────────

export type ProtocolName =
  | 'VLESS' | 'VMess' | 'Trojan' | 'Shadowsocks'
  | 'Hysteria2' | 'SSH' | 'SSH+Payload' | 'WireGuard' | 'TUIC';

export interface VpnProtocol {
  name: ProtocolName | string;
  port: number;
  transport: string;
  security: string;
  description?: string;
}

export interface TrafficStats {
  uploadBytes:   number;
  downloadBytes: number;
  uploadSpeed:   number;   // bytes/sec
  downloadSpeed: number;   // bytes/sec
}

export interface AppTrafficStat {
  packageName: string;
  appName: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
}

// ── StepLogs types ────────────────────────────────────────────────────────────

export interface StepLogItem {
  key: string;
  translationKey: string;
  status: 'pending' | 'active' | 'done' | 'error' | 'warning';
  timestamp?: string;
  detail?: string;
}

// ── Context type ─────────────────────────────────────────────────────────────

interface VpnContextType {
  isConnected:        boolean;
  isConnecting:       boolean;
  vpnState:           string;
  selectedProtocol:   string | null;
  connectedProtocol:  string | null;
  availableProtocols: VpnProtocol[];
  trafficStats:       TrafficStats;
  vpnLogs:            string[];
  hasVpnPermission:   boolean;
  hasValidConfig:     boolean;
  activeConnection:   VpnConnection | null;
  stepLogs:           StepLogItem[];
  // Multi-config
  savedConfigs:       Array<{ id: string; name: string; protocol: string; isActive: boolean }>;
  activeConfigId:     string | null;
  switchConfig:       (configId: string) => Promise<void>;
  isSwitchingConfig:  boolean;
  // Quota
  quotaData:          QuotaData | null;
  // Revocation
  revokedStatus:      'none' | 'revoked' | 'suspended' | 'expired' | 'disabled';
  perAppTraffic:      AppTrafficStat[];
  logs:                string[];
  traffic:             TrafficStats;
  killSwitch:          boolean;
  autoReconnect:       boolean;
  setKillSwitch:       (v: boolean) => void;
  setAutoReconnect:    (v: boolean) => void;
  syncFromConnection:  (conn: VpnConnection) => void;
  connect:            () => Promise<void>;
  disconnect:         () => Promise<void>;
  selectProtocol:     (name: string) => void;
  refreshVpnConfig:   () => Promise<void>;
  requestPermission:  () => Promise<boolean>;
}

const DEFAULT_STATS: TrafficStats = { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0 };

const VpnContext = createContext<VpnContextType>({
  isConnected: false, isConnecting: false, vpnState: 'disconnected',
  selectedProtocol: null, connectedProtocol: null, availableProtocols: [],
  trafficStats: DEFAULT_STATS, vpnLogs: [],
  hasVpnPermission: false, hasValidConfig: false, activeConnection: null,
  stepLogs: [],
  savedConfigs: [], activeConfigId: null, switchConfig: async () => {}, isSwitchingConfig: false,
  quotaData: null,
  revokedStatus: 'none',
  perAppTraffic: [],
  logs: [], traffic: DEFAULT_STATS,
  killSwitch: false, autoReconnect: true,
  setKillSwitch: () => {}, setAutoReconnect: () => {},
  syncFromConnection: () => {},
  connect: async () => {}, disconnect: async () => {},
  selectProtocol: () => {}, refreshVpnConfig: async () => {},
  requestPermission: async () => false,
});

// ── Provider ─────────────────────────────────────────────────────────────────

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, refreshAccountState, deviceId } = useAuthContext();

  const [isConnected,        setIsConnected]        = useState(false);
  const [isConnecting,       setIsConnecting]        = useState(false);
  const [vpnState,           setVpnState]            = useState('disconnected');
  const [selectedProtocol,   setSelectedProtocol]    = useState<string | null>(null);
  const [connectedProtocol,  setConnectedProtocol]   = useState<string | null>(null);
  const [availableProtocols, setAvailableProtocols]  = useState<VpnProtocol[]>([]);
  const [trafficStats,       setTrafficStats]        = useState<TrafficStats>(DEFAULT_STATS);
  const [vpnLogs,            setVpnLogs]             = useState<string[]>([]);
  const [hasVpnPermission,   setHasVpnPermission]    = useState(false);
  const [vpnConfig,          setVpnConfig]           = useState<any>(null);
  const [activeConnection,   setActiveConnection]    = useState<VpnConnection | null>(null);
  const [killSwitch,         setKillSwitchState]      = useState<boolean>(false);
  const [autoReconnect,      setAutoReconnectState]   = useState<boolean>(true);
  const [stepLogs,           setStepLogs]             = useState<StepLogItem[]>([]);
  const [savedConfigs,       setSavedConfigs]         = useState<Array<{ id: string; name: string; protocol: string; isActive: boolean }>>([]);
  const [activeConfigId,     setActiveConfigId]       = useState<string | null>(null);
  const [isSwitchingConfig,  setIsSwitchingConfig]     = useState<boolean>(false);
  const [quotaData,          setQuotaData]             = useState<QuotaData | null>(null);
  const [revokedStatus,      setRevokedStatus]        = useState<'none' | 'revoked' | 'suspended' | 'expired' | 'disabled'>('none');
  const [perAppTraffic,      setPerAppTraffic]        = useState<AppTrafficStat[]>([]);

  const trafficTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const quotaTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef  = useRef<number>(0);

  // ── F1 — QUOTA DELTA : derniers compteurs envoyés au backend ────────────────
  // Le backend INCÉMENTE le quota de ce que l'app lui envoie. On ne doit donc
  // JAMAIS envoyer de totaux cumulés (sur-décompte), mais uniquement l'écart
  // depuis le dernier envoi RÉUSSI. Initialisés à 0 au CONNECT réussi, remis
  // à 0 à la déconnexion.
  const lastReportUpRef   = useRef(0);
  const lastReportDownRef = useRef(0);

  // ── F3 — Référence vers le connect() le plus récent (évite qu'un connect
  // capturé dans un closure périmé soit bloqué par son propre garde
  // `if (isConnecting || isConnected) return;` après un switch). ─────────────
  const connectRef = useRef<(() => Promise<void>) | null>(null);

  const watchdogRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStepRef  = useRef<string>('INIT');

  // ── StepLogs helpers ────────────────────────────────────────────────────────
  const resetStepLogs = useCallback(() => {
    setStepLogs([]);
  }, []);

  const addStepLog = useCallback((key: string, translationKey: string, status: StepLogItem['status'], detail?: string) => {
    const now = new Date().toISOString();
    setStepLogs(prev => {
      const existing = prev.findIndex(s => s.key === key);
      const newStep: StepLogItem = { key, translationKey, status, timestamp: now, detail };
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = newStep;
        return updated;
      }
      return [...prev, newStep];
    });
  }, []);

  const updateStepStatus = useCallback((key: string, status: StepLogItem['status'], detail?: string) => {
    setStepLogs(prev => prev.map(s =>
      s.key === key ? { ...s, status, ...(detail ? { detail } : {}), timestamp: new Date().toISOString() } : s
    ));
  }, []);

  // ── Revocation detection ────────────────────────────────────────────────────
  const checkRevocation = useCallback((conn: VpnConnection | null) => {
    if (!conn) { setRevokedStatus('none'); return 'none'; }
    const status = conn.status?.toLowerCase();
    if (status === 'revoked')   { setRevokedStatus('revoked');   return 'revoked'; }
    if (status === 'suspended') { setRevokedStatus('suspended'); return 'suspended'; }
    if (status === 'disabled')  { setRevokedStatus('disabled');  return 'disabled'; }
    if (status === 'expired' || (conn.expiresAt && new Date(conn.expiresAt).getTime() < Date.now())) {
      setRevokedStatus('expired'); return 'expired';
    }
    setRevokedStatus('none');
    return 'none';
  }, []);

  // ── F2 — Révocation APPLIQUÉE (pas seulement affichée) ──────────────────────
  // Dès que revokedStatus quitte 'none', on arrête effectivement le VPN natif
  // (s'il est actif), on repasse l'état à disconnected, on persiste
  // '@sxb_vpn_connected'='false' et on purge la config provisionnée : avec une
  // configuration révoquée, l'app ne peut plus rester connectée ni se
  // reconnecter. Le guard revocationAppliedRef évite de ré-appliquer plusieurs
  // fois le même statut (l'effet se redéclenche sur isConnected/isConnecting).
  const revocationAppliedRef = useRef<string>('none');

  useEffect(() => {
    if (revokedStatus !== 'none') {
      if (revocationAppliedRef.current === revokedStatus) return;
      revocationAppliedRef.current = revokedStatus;
      const applyRevocation = async () => {
        if (isConnected || isConnecting) {
          legacyDebugLog(`REVOCATION_APPLY status=${revokedStatus} — arrêt natif du VPN`);
          if (IS_ANDROID && SxbVpnNative) {
            try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
          }
          setIsConnected(false);
          setIsConnecting(false);
        }
        setVpnState('disconnected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
        await clearProvisionedConfig().catch(() => {});
        const label = revokedStatus === 'revoked' ? 'révoquée' : revokedStatus === 'suspended' ? 'suspendue' : revokedStatus === 'expired' ? 'expirée' : 'désactivée';
        addLog(`🚫 Configuration ${label} par le serveur — VPN arrêté`);
        legacyDebugLog(`REVOCATION_APPLIED status=${revokedStatus} — VPN arrêté, config provisionnée purgée`);
      };
      applyRevocation().catch(() => {});
    } else {
      revocationAppliedRef.current = 'none';
    }
  }, [revokedStatus, isConnected, isConnecting, addLog]);

  // ── F2 — Surveillance /mobile/connections ───────────────────────────────────
  // Si la config active n'est plus présente dans la liste rafraîchie
  // (suppression côté dashboard), on la traite comme 'revoked' — même chemin
  // d'application que ci-dessus. On vérifie aussi le statut courant de la
  // config active (révoquée/suspendue/expirée) pour déclencher l'arrêt.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const checkConnections = async () => {
      try {
        const res = await apiClient.get('/mobile/connections');
        const conns: VpnConnection[] = res.data?.connections || [];
        if (cancelled) return;
        const activeId = await AsyncStorage.getItem('@sxb_active_config_id');
        if (activeId) {
          const activeConn = conns.find(c => c.id === activeId);
          if (activeConn) {
            checkRevocation(activeConn);
          } else {
            // Config active absente de la liste → traitée comme révoquée
            legacyDebugLog(`ACTIVE_CONFIG_MISSING id=${activeId} — traité comme révoqué`);
            setRevokedStatus('revoked');
          }
        }
      } catch { /* ignore — non-bloquant */ }
    };
    checkConnections();
    const t = setInterval(checkConnections, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isAuthenticated, checkRevocation]);

  // ── Multi-config: load saved configs from AsyncStorage ──────────────────────
  useEffect(() => {
    const loadSavedConfigs = async () => {
      try {
        const stored = await AsyncStorage.getItem('@sxb_saved_configs');
        if (stored) {
          const configs = JSON.parse(stored);
          setSavedConfigs(configs);
        }
        const activeId = await AsyncStorage.getItem('@sxb_active_config_id');
        if (activeId) setActiveConfigId(activeId);
      } catch { /* ignore */ }
    };
    loadSavedConfigs();
  }, []);

  // ── F3 — Switch TRANSACTIONNEL multi-configs ────────────────────────────────
  // Règles strictes :
  //   • JAMAIS de purge avant succès : aucun état (activeConfigId, config
  //     provisionnée, savedConfigs) n'est modifié tant que la cible n'est pas
  //     validée ET provisionnée avec une config complète ;
  //   • la connexion cible est résolue + dataToken vérifié AVANT toute action
  //     (sinon message clair, état inchangé) ;
  //   • stopVpn natif puis ATTENTE de l'état natif disconnected (≤ 3 s) ;
  //   • provisionAndStore(targetDataToken, deviceId) puis attente d'une config
  //     complète (isCompleteOfflineConfig) ;
  //   • SEULEMENT ALORS : setActiveConfigId + maj savedConfigs + connect() unique ;
  //   • en catch : rollback de activeConfigId + rechargement de l'ancienne
  //     config, log d'erreur, SANS toucher aux données.
  const switchConfig = useCallback(async (configId: string) => {
    if (configId === activeConfigId) return;
    const previousConfigId = activeConfigId;
    setIsSwitchingConfig(true);
    legacyDebugLog(`SWITCH_CONFIG_START targetId=${configId}`);
    addLog('🔄 Changement de configuration...');

    try {
      // 1. Résoudre la connexion cible + VÉRIFIER dataToken AVANT toute action
      const res = await apiClient.get('/mobile/connections');
      const connections: VpnConnection[] = res.data?.connections || [];
      const targetConn = connections.find(c => c.id === configId);
      if (!targetConn) {
        legacyDebugLog(`SWITCH_CONFIG — cible non trouvée id=${configId}`);
        addLog('⚠️ Configuration cible introuvable sur le serveur — état inchangé');
        return;
      }
      if (!targetConn.dataToken) {
        legacyDebugLog(`SWITCH_CONFIG — dataToken manquant id=${configId}`);
        addLog('⚠️ Configuration cible sans token de provisionnement — état inchangé');
        return;
      }
      const targetStatus = (targetConn.status || '').toLowerCase();
      if (targetStatus === 'revoked' || targetStatus === 'suspended' || targetStatus === 'disabled' || targetStatus === 'expired') {
        legacyDebugLog(`SWITCH_CONFIG — cible ${targetStatus} id=${configId}`);
        addLog(`⚠️ Configuration cible ${targetStatus === 'revoked' ? 'révoquée' : targetStatus === 'suspended' ? 'suspendue' : targetStatus === 'expired' ? 'expirée' : 'désactivée'} — changement impossible`);
        return;
      }
      legacyDebugLog(`SWITCH_CONFIG — cible validée id=${targetConn.id} proto=${targetConn.technicalProtocol}`);

      // 2. Si VPN actif → stopVpn natif puis ATTENDRE l'état natif disconnected
      if (isConnected || isConnecting) {
        legacyDebugLog('SWITCH_CONFIG — VPN actif, déconnexion préalable');
        if (IS_ANDROID && SxbVpnNative) {
          try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
        }
        // Polling de l'état natif (≤ 3 s) — on ne continue qu'une fois le
        // tunnel réellement arrêté (évite un conflit d'établissement TUN).
        if (IS_ANDROID && SxbVpnNative) {
          let waited = 0;
          while (waited < 3000) {
            try {
              const nativeState: string = await SxbVpnNative.getVpnState();
              if (nativeState === 'disconnected' || nativeState === 'error' || nativeState === '') break;
            } catch { break; }
            await new Promise(r => setTimeout(r, 250));
            waited += 250;
          }
          legacyDebugLog(`SWITCH_CONFIG — état natif après stop (waited=${waited}ms)`);
        }
        setIsConnected(false);
        setIsConnecting(false);
        setVpnState('disconnected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
      }

      // 3. Provisionner la cible AVANT toute modification d'état (jamais de
      //    purge avant succès : provisionAndStore écrase proprement la config
      //    provisionnée au succès seulement).
      const freshResult = await provisionAndStore(targetConn.dataToken, deviceId);
      const merged = mergeConnectionMetadata(
        mergeProvisionedConfig(null, freshResult.config),
        {
          displayProtocol: targetConn.displayProtocol,
          configId:        targetConn.id,
          subscriptionId:  targetConn.id,
          dataToken:       targetConn.dataToken,
          configVersion:   (targetConn as any).configVersion,
          configHash:      (targetConn as any).configHash,
        },
      );

      // 4. Attendre une config COMPLÈTE avant de basculer
      const completeness = isCompleteOfflineConfig(merged);
      if (!completeness.complete) {
        throw new Error(`config cible incomplète (manque : ${completeness.missing.join(', ')})`);
      }
      const engineProtocol = (merged.protocol || targetConn.technicalProtocol || 'vless').toLowerCase();
      const saved = await saveCompleteConfig(merged, engineProtocol, targetConn.id, freshResult.meta.configExpiresAt);
      if (!saved) throw new Error('sauvegarde de la config cible refusée');
      setVpnConfig(merged);

      // Synchroniser le quota local (gardes offline expiration/épuisement)
      if (freshResult.meta.quotaGB > 0) {
        await saveQuotaData({
          configId:    freshResult.meta.subscriptionId || targetConn.id,
          totalQuota:  Math.round(freshResult.meta.quotaGB * 1024 ** 3),
          usedQuota:   Math.round(freshResult.meta.quotaUsedGB * 1024 ** 3),
          expiryDate:  freshResult.meta.expireAt,
        }).catch(() => {});
      }

      // 5. SEULEMENT ALORS : basculer l'ID actif + savedConfigs + connect() unique
      setActiveConfigId(configId);
      await AsyncStorage.setItem('@sxb_active_config_id', configId);
      setSavedConfigs(prev => {
        const exists = prev.find(c => c.id === configId);
        let updated: typeof prev;
        if (exists) {
          updated = prev.map(c => c.id === configId
            ? { ...c, name: targetConn.name, protocol: targetConn.displayProtocol, isActive: true }
            : { ...c, isActive: false });
        } else {
          const newCfg = { id: configId, name: targetConn.name, protocol: targetConn.displayProtocol, isActive: true };
          updated = prev.length >= 2 ? [...prev.slice(1), newCfg] : [...prev, newCfg];
        }
        AsyncStorage.setItem('@sxb_saved_configs', JSON.stringify(updated)).catch(() => {});
        return updated;
      });
      setActiveConnection(targetConn);

      legacyDebugLog(`SWITCH_CONFIG — cible provisionnée et active id=${targetConn.id}, connexion`);
      addLog('✅ Configuration changée — connexion au nouveau serveur...');
      // connect() unique — via connectRef pour utiliser le connect() le plus
      // récent (le closure capturé ici verrait encore l'ancien isConnected).
      setTimeout(() => { connectRef.current?.(); }, 300);
    } catch (e: any) {
      // ROLLBACK : restaurer l'ID actif précédent + recharger l'ancienne
      // config, log d'erreur — sans toucher aux données.
      legacyDebugLog(`SWITCH_CONFIG_ERROR — ${e?.message || 'erreur'}`);
      addLog(`⚠️ Changement de configuration impossible : ${e?.message || 'erreur'}`);
      if (previousConfigId) {
        setActiveConfigId(previousConfigId);
        await AsyncStorage.setItem('@sxb_active_config_id', previousConfigId).catch(() => {});
      } else {
        setActiveConfigId(null);
        await AsyncStorage.removeItem('@sxb_active_config_id').catch(() => {});
      }
      const oldEntry = await loadVpnConfig().catch(() => null);
      if (oldEntry?.config) setVpnConfig(oldEntry.config);
    } finally {
      setIsSwitchingConfig(false);
    }
  }, [activeConfigId, isConnected, isConnecting, addLog, deviceId]);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
  }, []);

  const startWatchdog = useCallback((lastStep: string) => {
    clearWatchdog();
    lastStepRef.current = lastStep;
    watchdogRef.current = setTimeout(async () => {
      const step = lastStepRef.current;
      legacyDebugLog(`WATCHDOG_FIRED lastStep=${step}`);

      let errorCode = 'TIMEOUT_SERVER';
      let errorDetail = 'Aucune réponse du serveur après 45s';
      if (step.includes('ssh+payload')) {
        errorCode = 'TIMEOUT_SSH_PAYLOAD';
        errorDetail = 'Timeout SSH+Payload — vérifiez le payload et le serveur';
      } else if (step.includes('ssh')) {
        errorCode = 'SSH_TIMEOUT';
        errorDetail = 'Timeout SSH — serveur non joignable ou port fermé';
      } else if (step.includes('CONFIG')) {
        errorCode = 'INVALID_CONFIG';
        errorDetail = 'Configuration VPN invalide ou incomplète';
      }

      setVpnLogs(prev => [
        `[WATCHDOG] ❌ ${errorCode}`,
        `[WATCHDOG] Bloqué à : ${step}`,
        `[WATCHDOG] Cause probable : ${errorDetail}`,
        `[WATCHDOG] Arrêt du service après 45s sans réponse`,
        ...prev,
      ].slice(0, 200));

      if (IS_ANDROID && SxbVpnNative) {
        try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
      }
      setIsConnecting(false);
      setVpnState('error');
    }, 45_000);
  }, [clearWatchdog]);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setVpnLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 200));
  }, []);

  const setKillSwitch = useCallback((v: boolean) => {
    setKillSwitchState(v);
    if (IS_ANDROID && SxbVpnNative) {
      try { SxbVpnNative.setKillSwitch(v); } catch { /* ignore */ }
    }
    AsyncStorage.setItem('@sxb_kill_switch', v ? 'true' : 'false').catch(() => {});
  }, []);

  const setAutoReconnect = useCallback((v: boolean) => {
    setAutoReconnectState(v);
    if (IS_ANDROID && SxbVpnNative) {
      try { SxbVpnNative.setAutoReconnect(v); } catch { /* ignore */ }
    }
    AsyncStorage.setItem('@sxb_auto_reconnect', v ? 'true' : 'false').catch(() => {});
  }, []);

  // ── Synchronisation depuis une connexion active (/mobile/connections) ──────
  // Modèle « intermédiaire » (mission §6) :
  //   • /mobile/connections = MÉTADONNÉES UNIQUEMENT (allowlist §6.4) —
  //     ne fournit JAMAIS de champ technique au moteur ;
  //   • la SEULE source technique est la config provisionnée déchiffrée
  //     (/provision/activate, stockée dans SecureStore) ;
  //   • invalidation de cache : changement d'abonnement OU configHash
  //     différent → purge atomique + re-provisionnement ;
  //   • aucune config incomplète n'est jamais persistée.
  const syncFromConnection = useCallback((conn: VpnConnection) => {
    legacyDebugLog(`ACTIVE_CONNECTION_FOUND id=${conn.id} proto=${conn.technicalProtocol} display=${conn.displayProtocol}`);
    legacyDebugLog(`ACTIVE_CONNECTION_FOUND id=${conn.id}`);

    // Check revocation status
    const revocation = checkRevocation(conn);
    if (revocation !== 'none') {
      legacyDebugLog(`CONNECTION_REVOKED status=${revocation} — arrêt VPN`);
      addLog(`⚠️ Configuration ${revocation === 'revoked' ? 'révoquée' : revocation === 'suspended' ? 'suspendue' : revocation === 'expired' ? 'expirée' : 'désactivée'}`);
      // Stop VPN if connected
      if (isConnected || isConnecting) {
        if (IS_ANDROID && SxbVpnNative) {
          try { SxbVpnNative.stopVpn(); } catch { /* ignore */ }
        }
        setIsConnected(false);
        setIsConnecting(false);
        setVpnState('error');
      }
      return;
    }

    // Update saved configs (max 2)
    setSavedConfigs(prev => {
      const exists = prev.find(c => c.id === conn.id);
      let updated: typeof prev;
      if (exists) {
        updated = prev.map(c => c.id === conn.id ? { ...c, name: conn.name, protocol: conn.displayProtocol, isActive: true } : c);
      } else {
        const newConfig = { id: conn.id, name: conn.name, protocol: conn.displayProtocol, isActive: true };
        updated = prev.length >= 2 ? [...prev.slice(1), newConfig] : [...prev, newConfig];
      }
      AsyncStorage.setItem('@sxb_saved_configs', JSON.stringify(updated)).catch(() => {});
      setActiveConfigId(conn.id);
      AsyncStorage.setItem('@sxb_active_config_id', conn.id).catch(() => {});
      return updated;
    });

    // Étiquette technique informative (UI uniquement — jamais injectée dans
    // la config moteur ; la vérité technique vient du blob provisionné).
    const protocolLabel   = conn.technicalProtocol.toLowerCase();
    const displayProtocol = conn.displayProtocol;

    // Métadonnées de connexion autorisées à la fusion (allowlist §6.4)
    const connMeta: Record<string, any> = {
      displayProtocol,
      configId:        conn.id,
      subscriptionId:  conn.id,
      dataToken:       conn.dataToken,
      configVersion:   (conn as any).configVersion,
      configHash:      (conn as any).configHash,
    };

    // Métadonnées de connexion (non-sensibles, toujours disponibles)
    setActiveConnection(conn);
    setConnectedProtocol(displayProtocol);
    AsyncStorage.setItem('@sxb_connected_protocol', displayProtocol).catch(() => {});
    setSelectedProtocol(prev => {
      if (!prev) {
        AsyncStorage.setItem('@sxb_vpn_protocol', protocolLabel).catch(() => {});
        return protocolLabel;
      }
      return prev;
    });

    // ── Flux sécurisé : provisionner avant de sauvegarder ───────────────────
    // On ne sauvegarde JAMAIS une config incomplète. Le provisionnement
    // récupère les vraies données VPN (host, port, credentials, payload),
    // y ajoute les métadonnées de connexion (allowlist), valide la complétude,
    // puis enregistre uniquement le résultat complet dans SecureStore.
    const provisionFlow = async () => {
      // 1. Vérifier si une config provisionnée valide existe déjà —
      //    avec INVALIDATION §6.4 : autre abonnement OU hash différent.
      const existing = await loadProvisionedConfig().catch(() => null);
      if (existing) {
        const staleByProfile =
          !!existing.meta?.subscriptionId && existing.meta.subscriptionId !== conn.id;
        const staleByHash =
          !!existing.meta?.configHash && !!connMeta.configHash &&
          existing.meta.configHash !== connMeta.configHash;
        if (staleByProfile || staleByHash) {
          legacyDebugLog(`CONFIG_STALE ${staleByProfile ? 'subscription-changed' : 'config-hash-mismatch'} — PURGE atomique du cache provisionné`);
          await clearProvisionedConfig().catch(() => {});
        } else {
          // Cache valide et à jour — métadonnées seules ajoutées (technique intacte)
          const merged = mergeConnectionMetadata(existing.config, connMeta);
          const engineProtocol = (merged.protocol || protocolLabel).toLowerCase();
          const saved = await saveCompleteConfig(merged, engineProtocol, conn.id, existing.meta.configExpiresAt);
          if (saved) {
            setVpnConfig(merged);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto=${engineProtocol} display="${displayProtocol}" (depuis cache provisionné)`);
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto="${engineProtocol}" display="${displayProtocol}"`);
            return;
          }
        }
      }

      // 2. Pas de config provisionnée valide (ou périmée) — provisionnement
      if (conn.dataToken && deviceId) {
        legacyDebugLog('PROVISION_START — provisionnement sécurisé');
        try {
          const freshResult = await provisionAndStore(conn.dataToken!, deviceId);
          // Synchroniser le quota local (gardes offline : expiration + épuisement)
          if (freshResult.meta.quotaGB > 0) {
            await saveQuotaData({
              configId:    freshResult.meta.subscriptionId || conn.id,
              totalQuota:  Math.round(freshResult.meta.quotaGB * 1024 ** 3),
              usedQuota:   Math.round(freshResult.meta.quotaUsedGB * 1024 ** 3),
              expiryDate:  freshResult.meta.expireAt,
            }).catch(() => {});
          }
          // Provisionné = SEULE source technique (§6.1) ; connexion = allowlist (§6.4)
          const merged = mergeConnectionMetadata(
            mergeProvisionedConfig(null, freshResult.config),
            connMeta,
          );
          // La vérité technique du protocole vient du blob, pas de l'étiquette UI
          const engineProtocol = (merged.protocol || protocolLabel).toLowerCase();
          const saved = await saveCompleteConfig(merged, engineProtocol, conn.id, freshResult.meta.configExpiresAt);
          if (saved) {
            setVpnConfig(merged);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto=${engineProtocol} display="${displayProtocol}"`);
            legacyDebugLog('PROVISION_OK — config complète stockée dans SecureStore');
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto="${engineProtocol}" display="${displayProtocol}"`);
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto=${engineProtocol} display=${displayProtocol}`);
            return;
          } else {
            legacyDebugLog('PROVISION_WARN — config provisionnée incomplète, sauvegarde refusée');
          }
        } catch (e: any) {
          legacyDebugLog(`PROVISION_WARN — ${e?.message || 'erreur réseau'}`);
        }
      }

      // 3. Provisionnement échoué — conserver l'ancienne config si valide ET à jour
      const offlineEntry = await loadVpnConfig().catch(() => null);
      if (offlineEntry?.config) {
        const check = isCompleteOfflineConfig(offlineEntry.config);
        if (check.complete) {
          // §6.4 : si le serveur annonce un autre hash, la config offline est
          // périmée — on ne l'utilise plus (re-provisionnement requis).
          if (connMeta.configHash && (offlineEntry.config as any).configHash &&
              (offlineEntry.config as any).configHash !== connMeta.configHash) {
            legacyDebugLog('CONFIG_OFFLINE_STALE config-hash-mismatch — re-provisionnement requis (internet)');
          } else {
            // Métadonnées de connexion ajoutées (allowlist — technique intacte)
            const merged = mergeConnectionMetadata(offlineEntry.config, connMeta);
            setVpnConfig(merged);
            legacyDebugLog('CONFIG_RESTORED — config offline valide conservée');
            legacyDebugLog(`HOME_STATE_UPDATED hasValidConfig=true proto="${(merged.protocol || protocolLabel).toLowerCase()}" display="${displayProtocol}"`);
            return;
          }
        }
      }

      // 4. Aucune config valide — état dégradé, internet requis
      legacyDebugLog('CONFIG_INCOMPLETE — provisionnement requis, internet nécessaire pour la première activation');
      setVpnConfig({
        protocol:        protocolLabel,
        displayProtocol: displayProtocol,
        configId:        conn.id,
        dataToken:       conn.dataToken,
      });
    };

    provisionFlow().catch(e => legacyDebugLog(`SYNC_ERROR — ${e?.message || 'erreur'}`));
  }, [addLog, deviceId]);

  const checkPermission = useCallback(async () => {
    if (!IS_ANDROID || !SxbVpnNative) { setHasVpnPermission(true); return true; }
    try {
      const granted: boolean = SxbVpnNative.isVpnPermissionGranted();
      setHasVpnPermission(granted);
      return granted;
    } catch { return false; }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!IS_ANDROID || !SxbVpnNative) { setHasVpnPermission(true); return true; }
    try {
      const granted: boolean = await SxbVpnNative.requestVpnPermission();
      setHasVpnPermission(granted);
      return granted;
    } catch (e) {
      addLog('⚠️ Erreur permission VPN');
      return false;
    }
  }, [addLog]);

  useEffect(() => {
    checkPermission();

    const restore = async () => {
      const [connected, protocol, ks, ar] = await Promise.all([
        AsyncStorage.getItem('@sxb_vpn_connected'),
        AsyncStorage.getItem('@sxb_vpn_protocol'),
        AsyncStorage.getItem('@sxb_kill_switch'),
        AsyncStorage.getItem('@sxb_auto_reconnect'),
      ]);
      if (protocol) setSelectedProtocol(protocol);
      if (ks !== null)  setKillSwitchState(ks === 'true');
      if (ar !== null)  setAutoReconnectState(ar !== 'false');

      if (IS_ANDROID && SxbVpnNative) {
        try {
          const state: string = await SxbVpnNative.getVpnState();
          const reallyConnected = state === 'connected';
          setVpnState(state);
          setIsConnected(reallyConnected);
          await AsyncStorage.setItem('@sxb_vpn_connected', reallyConnected ? 'true' : 'false');
        } catch { /* ignore */ }
      }

      try {
        const offlineEntry = await loadVpnConfig();
        if (offlineEntry?.config) {
          setVpnConfig(offlineEntry.config);
          if (offlineEntry.config.displayProtocol) {
            setConnectedProtocol(offlineEntry.config.displayProtocol);
          }
        }
      } catch { /* ignore */ }

      if (!IS_ANDROID || !SxbVpnNative) {
        const wasConnected = connected === 'true' && !!isAuthenticated;
        setIsConnected(wasConnected);
        setVpnState(wasConnected ? 'connected' : 'disconnected');
      }
    };
    restore();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    if (!vpnEmitter) return;

    const stateSub = vpnEmitter.addListener('onVpnStateChange', (e: { status: string }) => {
      const s = e.status;
      legacyDebugLog(`BROADCAST_STATUS_RECEIVED status=${s}`);
      setVpnState(s);
      const connected = s === 'connected';
      setIsConnected(connected);
      if (s === 'connecting') {
        setIsConnecting(true);
        lastStepRef.current = 'CONNECTING';
      } else {
        setIsConnecting(false);
        clearWatchdog();
      }
      AsyncStorage.setItem('@sxb_vpn_connected', connected ? 'true' : 'false').catch(() => {});
      if (connected) {
        clearWatchdog();
        addStepLog('tunnel', 'step_tunnel_ready', 'done');
        addStepLog('connected', 'step_vpn_active', 'done');
        addLog('✅ VPN_CONNECTED — tunnel actif');
        legacyDebugLog('VPN_CONNECTED');
        legacyDebugLog('VPN_CONNECTED');
        sessionStartRef.current = Date.now();
        // F1 — nouveau cycle de session : compteurs delta repartent de zéro
        lastReportUpRef.current = 0;
        lastReportDownRef.current = 0;
        refreshAccountState().catch(() => {});
      } else if (s === 'disconnected') {
        addStepLog('disconnected', 'step_disconnected', 'done');
        legacyDebugLog('VPN_FAILED status=disconnected');
        addLog('🔴 VPN déconnecté');
        stopTrafficPolling();
        if (IS_ANDROID && SxbVpnNative?.getTrafficStats) {
          SxbVpnNative.getTrafficStats().then((stats: any) => {
            reportUsageToBackend(stats?.uploadBytes || 0, stats?.downloadBytes || 0).finally(() => {
              lastReportUpRef.current = 0;
              lastReportDownRef.current = 0;
            });
          }).catch(() => {
            lastReportUpRef.current = 0;
            lastReportDownRef.current = 0;
          });
        } else {
          lastReportUpRef.current = 0;
          lastReportDownRef.current = 0;
        }
      } else if (s === 'error') {
        addStepLog('error', 'step_error', 'error');
        legacyDebugLog('VPN_FAILED status=error');
        addLog('❌ Erreur VPN — connexion perdue');
        setIsConnecting(false);
      }
    });

    const logSub = vpnEmitter.addListener('onVpnLog', (e: { message: string }) => {
      addLog(e.message);
    });

    return () => { stateSub.remove(); logSub.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog, refreshAccountState]);

  const startTrafficPolling = useCallback(() => {
    if (!IS_ANDROID || !SxbVpnNative) return;
    if (trafficTimerRef.current) return;
    trafficTimerRef.current = setInterval(async () => {
      try {
        const stats = await SxbVpnNative.getTrafficStats();
        setTrafficStats({
          uploadBytes:   stats.uploadBytes   || 0,
          downloadBytes: stats.downloadBytes || 0,
          uploadSpeed:   stats.uploadSpeed   || 0,
          downloadSpeed: stats.downloadSpeed || 0,
        });
      } catch { /* ignore */ }
    }, 1500);
  }, []);

  const stopTrafficPolling = useCallback(() => {
    if (trafficTimerRef.current) { clearInterval(trafficTimerRef.current); trafficTimerRef.current = null; }
  }, []);

  useEffect(() => {
    if (isConnected) startTrafficPolling();
    else stopTrafficPolling();
    return stopTrafficPolling;
  }, [isConnected, startTrafficPolling, stopTrafficPolling]);

  // ── F5 — DATA PAR APPLICATION : agrégation par UID toutes les 30s ──────────
  useEffect(() => {
    if (!isConnected || !IS_ANDROID || !SxbVpnNative?.getPerAppStats) {
      setPerAppTraffic([]);
      return;
    }
    const fetchPerApp = async () => {
      try {
        const stats = await SxbVpnNative.getPerAppStats();
        if (Array.isArray(stats)) {
          setPerAppTraffic(stats);
        }
      } catch { /* ignore */ }
    };
    fetchPerApp();
    const timer = setInterval(fetchPerApp, 30_000);
    return () => clearInterval(timer);
  }, [isConnected]);

  // ── F6 — NOTIFICATION D'ÉTAT : statut réel via updateNotification ──────────
  useEffect(() => {
    if (!IS_ANDROID || !SxbVpnNative?.updateNotification) return;
    const updateNativeNotif = async () => {
      try {
        if (isConnecting) {
          await SxbVpnNative.updateNotification('SXB VPN — Connexion…');
        } else if (isConnected) {
          const planName = activeConnection?.name || 'SXB VPN';
          await SxbVpnNative.updateNotification(`SXB VPN — Connecté — ${planName}`);
        } else {
          await SxbVpnNative.updateNotification('SXB VPN — Déconnecté');
        }
      } catch { /* ignore */ }
    };
    updateNativeNotif();
  }, [isConnected, isConnecting, activeConnection?.name]);

  // ── F1 — QUOTA DELTA : envoi au backend en delta uniquement ────────────────
  // delta = max(0, courant - dernier) sur up et down ; on n'envoie QUE si
  // delta > 0 ; body avec reportMode:'delta' ; les refs ne sont mises à jour
  // QU'APRÈS un envoi réussi (en cas d'échec, le prochain report renverra
  // l'intégralité de l'écart — aucune perte, aucun sur-décompte).
  const reportUsageToBackend = useCallback(async (up: number, down: number) => {
    if (!isAuthenticated) return undefined;
    const deltaUp   = Math.max(0, up - lastReportUpRef.current);
    const deltaDown = Math.max(0, down - lastReportDownRef.current);
    if (deltaUp <= 0 && deltaDown <= 0) return undefined;
    try {
      const result = await apiClient.post('/mobile/vpn/traffic', {
        bytesUp:   deltaUp,
        bytesDown: deltaDown,
        reportMode:'delta',
      });
      // Mettre à jour les refs SEULEMENT après envoi réussi
      lastReportUpRef.current   = up;
      lastReportDownRef.current = down;
      return result;
    } catch {
      return undefined; /* ignore — report is best-effort */
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isConnected || !isAuthenticated) return;
    reportTimerRef.current = setInterval(async () => {
      if (IS_ANDROID && SxbVpnNative) {
        try {
          const stats = await SxbVpnNative.getTrafficStats();
          // F1 — le backend incrémente le quota de ce qu'on lui envoie :
          // 1 Mo consommé = 1 Mo décompté (jamais de total cumulé).
          const result = await reportUsageToBackend(stats.uploadBytes || 0, stats.downloadBytes || 0);
          // Update local quota from backend response
          if (result?.data?.quotaRemainingGb !== undefined) {
            const remainingBytes = Math.round(result.data.quotaRemainingGb * 1024 ** 3);
            const currentQuota = await loadQuotaData().catch(() => null);
            if (currentQuota) {
              const usedBytes = currentQuota.totalQuota - remainingBytes;
              setQuotaData(prev => prev ? { ...prev, usedQuota: usedBytes, remainingQuota: remainingBytes } : prev);
              await saveQuotaData({
                configId: currentQuota.configId,
                totalQuota: currentQuota.totalQuota,
                usedQuota: usedBytes,
                expiryDate: currentQuota.expiryDate,
              }).catch(() => {});
            }
          }
          // F2 a) Surveillance statut compte dans le report trafic (≤60 s) :
          // si state ∈ {suspended, revok*, expired, disabled} ou quotaExhausted → stopVpn natif,
          // clearProvisionedConfig, setIsConnected(false), bannière persistante, blocage connect
          const remoteState = result?.data?.state;
          const isRevokedState =
            remoteState === 'suspended' ||
            remoteState?.startsWith('revok') ||
            remoteState === 'expired' ||
            remoteState === 'disabled';
          if (isRevokedState || result?.data?.quotaExhausted) {
            const statusToSet = remoteState === 'suspended' ? 'suspended'
              : remoteState?.startsWith('revok') ? 'revoked'
              : remoteState === 'expired' ? 'expired'
              : remoteState === 'disabled' ? 'disabled'
              : 'expired';
            addLog(`❌ Compte ${statusToSet} ou quota épuisé — arrêt du VPN`);
            if (IS_ANDROID && SxbVpnNative) {
              try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
            }
            setIsConnected(false);
            setIsConnecting(false);
            setVpnState('disconnected');
            await AsyncStorage.setItem('@sxb_vpn_connected', 'false').catch(() => {});
            await clearProvisionedConfig().catch(() => {});
            setRevokedStatus(statusToSet);
          }
        } catch { /* ignore — report is best-effort */ }
      }
    }, 60_000);
    return () => { if (reportTimerRef.current) { clearInterval(reportTimerRef.current); reportTimerRef.current = null; } };
  }, [isConnected, isAuthenticated, addLog, reportUsageToBackend]);

  // ── Quota data polling (every 60s) ─────────────────────────────────────────
  const refreshQuotaData = useCallback(async () => {
    try {
      const loaded = await loadQuotaData();
      if (loaded) setQuotaData(loaded);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshQuotaData();
    quotaTimerRef.current = setInterval(refreshQuotaData, 60_000);
    return () => { if (quotaTimerRef.current) { clearInterval(quotaTimerRef.current); quotaTimerRef.current = null; } };
  }, [refreshQuotaData]);

  // ── Expiration polling (every 60s) ─────────────────────────────────────────
  useEffect(() => {
    const checkExpiration = async () => {
      const expired = await isConfigExpired();
      if (expired) {
        legacyDebugLog('EXPIRATION_CHECK — config expirée, arrêt VPN');
        // Disconnect VPN if active
        if (isConnected || isConnecting) {
          if (IS_ANDROID && SxbVpnNative) {
            try { await SxbVpnNative.stopVpn(); } catch { /* ignore */ }
          }
          setIsConnected(false);
          setVpnState('disconnected');
          setIsConnecting(false);
        }
        // Clear provisioned config
        await clearProvisionedConfig().catch(() => {});
        setVpnConfig(null);
        // Remove from savedConfigs
        const activeId = await AsyncStorage.getItem('@sxb_active_config_id');
        if (activeId) {
          setSavedConfigs(prev => {
            const updated = prev.filter(c => c.id !== activeId);
            AsyncStorage.setItem('@sxb_saved_configs', JSON.stringify(updated)).catch(() => {});
            return updated;
          });
        }
        setRevokedStatus('expired');
        addLog('⏰ Configuration expirée — renouvelez votre abonnement');
      }
    };
    checkExpiration();
    expiryTimerRef.current = setInterval(checkExpiration, 60_000);
    return () => { if (expiryTimerRef.current) { clearInterval(expiryTimerRef.current); expiryTimerRef.current = null; } };
  }, [isConnected, isConnecting, addLog]);

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      legacyDebugLog('CONFIG_SYNC_START — appel /mobile/vpn/config');
      const res = await apiClient.get('/mobile/vpn/config');
      const data = res.data;

      // ── Quota : persister localement pour le mode hors-ligne ──────────────
      // Le backend renvoie quota { totalQuota, usedQuota, expiryDate } (bytes).
      // C'est ce qui permet aux gardes isQuotaExhausted()/isConfigExpired()
      // de fonctionner sans réseau après redémarrage de l'app.
      if (data.quota && Number(data.quota.totalQuota) > 0) {
        await saveQuotaData({
          configId:    data.vpnConfig?.configId ?? data.profile?.id ?? 'vpn_config',
          totalQuota:  Number(data.quota.totalQuota) || 0,
          usedQuota:   Number(data.quota.usedQuota)   || 0,
          expiryDate:  data.quota.expiryDate ?? null,
        }).catch(() => {});
      }

      // ── Synchronisation intelligente — modèle « intermédiaire » (§6.4) ─────
      // /mobile/vpn/config ne fournit QUE des métadonnées : aucun champ
      // technique (protocol, host, port, tls, sni, payload…) n'est jamais lu
      // ici pour le moteur. La technique provient exclusivement de la config
      // provisionnée (SecureStore). configHash différent → config périmée.
      if (data.vpnConfig) {
        const dp = data.vpnConfig.displayProtocol || data.profile?.displayProtocol || null;
        // Étiquette technique informative (UI uniquement — jamais injectée
        // dans la config moteur persistée).
        const metaProtocolLabel = (data.vpnConfig.protocol || '').toLowerCase() || null;

        // Charger l'ancienne config (seule source technique locale autorisée)
        const offlineEntry = await loadVpnConfig().catch(() => null);
        const oldConfig = offlineEntry?.config || null;

        // Fusion ALLOWLIST : métadonnées uniquement — technique intacte
        const merged = mergeConnectionMetadata(oldConfig, {
          displayProtocol: dp ?? data.vpnConfig.displayProtocol,
          configId:        data.vpnConfig.configId ?? data.profile?.id,
          subscriptionId:  data.subscription?.id,
          dataToken:       data.subscription?.dataToken,
          configVersion:   data.vpnConfig.configVersion,
          configHash:      data.vpnConfig.configHash,
        });

        if (oldConfig) {
          // La vérité technique du protocole vient de la config persistée,
          // JAMAIS de data.vpnConfig.protocol (métadonnée informative).
          const engineProto = ((merged.protocol as string) || 'vless').toLowerCase();

          // §6.4 — invalidation de cache : hash serveur ≠ hash local
          if (data.vpnConfig.configHash && (oldConfig as any).configHash &&
              data.vpnConfig.configHash !== (oldConfig as any).configHash) {
            legacyDebugLog('CONFIG_STALE_HASH — configuration serveur modifiée, re-provisionnement au prochain démarrage');
            await clearProvisionedConfig().catch(() => {});
          }

          // Valider la complétude avant de sauvegarder (métadonnées enrichies)
          const saved = await saveCompleteConfig(merged, engineProto, data.vpnConfig.configId);
          if (saved) {
            setVpnConfig(merged);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto="${engineProto}" display="${dp ?? '—'}" (métadonnées seules)`);
            legacyDebugLog(`CONFIG_SYNC_SUCCESS proto=${engineProto}`);
          } else if (isCompleteOfflineConfig(oldConfig).complete) {
            legacyDebugLog('CONFIG_SYNC_PARTIAL — ancienne config complète conservée');
          } else {
            legacyDebugLog('CONFIG_SYNC_INCOMPLETE — métadonnées seules non persistées (provisionnement requis)');
          }
        } else {
          legacyDebugLog('CONFIG_SYNC_META — aucune config provisionnée : métadonnées reçues, moteur intact');
        }

        if (dp) {
          setConnectedProtocol(dp);
          await AsyncStorage.setItem('@sxb_connected_protocol', dp).catch(() => {});
        }

        setSelectedProtocol(prev => {
          if (!prev && metaProtocolLabel) {
            AsyncStorage.setItem('@sxb_vpn_protocol', metaProtocolLabel).catch(() => {});
            return metaProtocolLabel;
          }
          return prev;
        });
      }

      if (Array.isArray(data.protocols) && data.protocols.length > 0) {
        setAvailableProtocols(data.protocols);
        const saved = await AsyncStorage.getItem('@sxb_vpn_protocol');
        if (!saved && data.protocols[0]) {
          setSelectedProtocol(data.protocols[0].name);
          await AsyncStorage.setItem('@sxb_vpn_protocol', data.protocols[0].name);
        }
      } else {
        setAvailableProtocols(FALLBACK_PROTOCOLS);
      }
    } catch {
      legacyDebugLog('CONFIG_SYNC_FAILED — backend inaccessible, mode hors-ligne');
      setAvailableProtocols(FALLBACK_PROTOCOLS);
    }
  }, [isAuthenticated, addLog]);

  useEffect(() => { refreshVpnConfig(); }, [refreshVpnConfig]);

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;

    // Check revocation before attempting connection
    if (revokedStatus !== 'none') {
      addLog(`❌ Connexion impossible — compte ${revokedStatus === 'revoked' ? 'révoqué' : revokedStatus === 'suspended' ? 'suspendu' : revokedStatus === 'expired' ? 'expiré' : 'désactivé'}`);
      return;
    }

    // F2 b) Avant chaque connect() : GET état frais (/mobile/vpn/config) → refus explicite si suspendu/révoqué
    try {
      const freshRes = await apiClient.get('/mobile/vpn/config', { timeout: 4000 });
      const freshState = freshRes?.data?.state;
      if (
        freshState === 'suspended' ||
        freshState?.startsWith('revok') ||
        freshState === 'expired' ||
        freshState === 'disabled'
      ) {
        const statusToSet = freshState === 'suspended' ? 'suspended'
          : freshState?.startsWith('revok') ? 'revoked'
          : freshState === 'expired' ? 'expired'
          : freshState === 'disabled' ? 'disabled'
          : 'expired';
        setRevokedStatus(statusToSet);
        addLog(`❌ Connexion refusée par le serveur : compte ${statusToSet}`);
        return;
      }
    } catch {
      // Best-effort en cas de mode hors-ligne
    }

    // F6 — Demander POST_NOTIFICATIONS au premier connect (sans casser si refusé)
    if (IS_ANDROID && Platform.Version >= 33) {
      try {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      } catch { /* ignore */ }
    }

    setIsConnecting(true);
    resetStepLogs();
    addStepLog('preparing', 'step_preparing', 'active');
    legacyDebugLog('CONNECT_START');
    legacyDebugLog('CONNECT_START — bouton "Se connecter" appuyé');
    addLog('🔄 Initialisation du tunnel VPN...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        // Step: Security check
        updateStepStatus('preparing', 'done');
        addStepLog('security', 'step_checking_security', 'active');

        const hasPerm = SxbVpnNative.isVpnPermissionGranted();
        if (!hasPerm) {
          addStepLog('permission', 'step_permission_check', 'active');
          addLog('🔐 Demande de permission VPN...');
          const granted = await SxbVpnNative.requestVpnPermission();
          if (!granted) {
            addStepLog('permission', 'step_permission_denied', 'error');
            addLog('❌ Permission VPN refusée');
            setIsConnecting(false);
            return;
          }
          addStepLog('permission', 'step_permission_granted', 'done');
          addLog('✅ Permission VPN accordée');
        } else {
          addStepLog('permission', 'step_permission_granted', 'done');
        }

        addStepLog('security', 'step_security_ok', 'done');
        addStepLog('config', 'step_loading_config', 'active');
        addLog('🔐 Chargement configuration sécurisée...');
        let configToUse: any = null;

        // ── Source de vérité unique : offlineStorage (SecureStore) ────────────
        // La config Offline est la seule source de vérité locale. Elle contient
        // tout ce qui est nécessaire au moteur VPN (host, port, credentials,
        // payload, paramètres de protocole). Le moteur ne dépend plus d'un
        // nouvel appel API pour démarrer.
        legacyDebugLog('CONFIG_LOAD_START — lecture SecureStore');
        const offlineEntry = await loadVpnConfig().catch(() => null);

        if (offlineEntry?.config) {
          // FIX — Ne JAMAIS utiliser une config stockée incomplète :
          // une écriture partielle héritée d'une ancienne version (avant le
          // gardien saveCompleteConfig) bloquait définitivement la connexion
          // (CONFIG_INCOMPLETE_BLOCK) sans jamais re-tenter le provisionnement.
          // Règle : complète → utilisable hors-ligne ; incomplète → re-provision.
          const storedCheck = isCompleteOfflineConfig(offlineEntry.config);
          if (storedCheck.complete) {
            configToUse = { ...offlineEntry.config };
            // Enrichir avec les métadonnées de connexion courante
            if (vpnConfig?.displayProtocol) configToUse.displayProtocol = vpnConfig.displayProtocol;
            if (vpnConfig?.configId)        configToUse.configId        = vpnConfig.configId;
            legacyDebugLog(`CONFIG_LOADED proto=${offlineEntry.protocol} savedAt=${offlineEntry.savedAt}`);
            addLog('✅ Configuration sécurisée chargée');
          } else {
            legacyDebugLog(`CONFIG_STORED_INCOMPLETE missing=[${storedCheck.missing.join(',')}] — re-provisionnement requis`);
          }
        }

        // ── Si pas de config Offline complète, tenter le provisionnement ─────
        if (!configToUse) {
          // Chercher le dataToken dans toutes les sources disponibles
          const dataToken =
            ((vpnConfig as any)?.dataToken as string | undefined) ??
            ((offlineEntry?.config as any)?.dataToken as string | undefined) ??
            ((activeConnection as any)?.dataToken as string | undefined);
          legacyDebugLog(`PROVISION_CHECK dataToken=${dataToken ? 'OK' : 'MISSING'} deviceId=${deviceId ? 'OK' : 'MISSING'}`);
          if (dataToken && deviceId) {
            legacyDebugLog('PROVISION_REQUIRED — appel /provision/activate');
            addStepLog('provisioning', 'step_provisioning', 'active');
            addLog('🔒 Provisionnement sécurisé en cours...');
            try {
              const freshResult = await provisionAndStore(dataToken, deviceId);
              const freshConfig = freshResult.config;
              // §6.1 : provisionné = SEULE source technique ; §6.4 : la
              // connexion n'apporte que des métadonnées (allowlist).
              configToUse = mergeConnectionMetadata(
                mergeProvisionedConfig(null, freshConfig),
                {
                  displayProtocol: vpnConfig?.displayProtocol ?? activeConnection?.displayProtocol ?? freshResult.meta.displayProtocol,
                  configId:        vpnConfig?.configId ?? activeConnection?.id ?? freshResult.meta.subscriptionId,
                  subscriptionId:  freshResult.meta.subscriptionId,
                  dataToken:       dataToken,
                  configVersion:   freshResult.meta.configVersion,
                  configHash:      freshResult.meta.configHash,
                },
              );
              // Sauvegarder uniquement si complet
              await saveCompleteConfig(configToUse, (configToUse.protocol || 'vless').toLowerCase(), vpnConfig?.configId ?? activeConnection?.id, freshResult.meta.configExpiresAt);
              // Synchroniser le quota local (validation offline expiration/quota)
              if (freshResult.meta.quotaGB > 0) {
                await saveQuotaData({
                  configId:    freshResult.meta.subscriptionId || 'provision',
                  totalQuota:  Math.round(freshResult.meta.quotaGB * 1024 ** 3),
                  usedQuota:   Math.round(freshResult.meta.quotaUsedGB * 1024 ** 3),
                  expiryDate:  freshResult.meta.expireAt,
                }).catch(() => {});
              }
              legacyDebugLog('PROVISION_OK — config complète stockée dans SecureStore');
              addStepLog('provisioning', 'step_provisioned', 'done');
              addLog('✅ Configuration provisionnée avec succès');
            } catch (provErr: any) {
              const httpStatus = provErr?.response?.status ?? 'no-response';
              const httpMsg    = provErr?.response?.data?.error ?? provErr?.response?.data?.message ?? '';
              legacyDebugLog(`PROVISION_FAILED http=${httpStatus} msg="${httpMsg || provErr?.message || 'inconnu'}"`);
              addLog(`⚠️ Provisionnement échoué : ${httpMsg || provErr?.message || 'erreur réseau'}`);
              if (offlineEntry?.config) {
                // Gardien ultime : signaler précisément ce qui manque au lieu
                // d'un échec opaque. La config incomplète n'est PAS utilisée.
                const missing = isCompleteOfflineConfig(offlineEntry.config).missing;
                legacyDebugLog(`CONFIG_INCOMPLETE_BLOCK missing=${missing.join(',')}`);
                addLog(`❌ Configuration incomplète (manque : ${missing.join(', ')}) — internet requis pour la réparer`);
              } else {
                addLog('❌ Internet requis pour le premier provisionnement');
              }
              setVpnState('error');
              setIsConnecting(false);
              return;
            }
          } else {
            addLog('❌ Aucune configuration disponible — activez un forfait');
            setVpnState('error');
            setIsConnecting(false);
            return;
          }
        }

        // ── Vérification post-provisionnement : host et protocol ─────────────
        if (!configToUse.host && configToUse.protocol !== 'wireguard' && configToUse.protocol !== 'singbox') {
          legacyDebugLog('CONFIG_MISSING_HOST — host absent après provisionnement');
          addLog('❌ Configuration invalide — champ "host" manquant');
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        // Si protocol est vide, détecter depuis les champs présents
        if (!configToUse.protocol || String(configToUse.protocol).trim() === '') {
          const detected = detectProtocolFromFields(configToUse);
          if (detected) {
            configToUse.protocol = detected;
            legacyDebugLog(`CONFIG_PROTOCOL_DETECTED proto=${detected}`);
          }
        }

        // ── Debug: log field presence (jamais les valeurs) ───────────────────
        const presentFields = Object.entries(configToUse)
          .filter(([_, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, _]) => k);
        legacyDebugLog(`CONFIG_FIELDS_PRESENT fields=[${presentFields.join(',')}]`);

        // ── Validation de complétude avec le gardien unifié ───────────────────
        const completeness = isCompleteOfflineConfig(configToUse);
        legacyDebugLog(`CONFIG_READY hasHost=${completeness.hasHost} hasCreds=${completeness.hasCreds} missing=[${completeness.missing.join(',')}]`);

        if (!completeness.complete) {
          addLog(`❌ Configuration incomplète — champs manquants : ${completeness.missing.join(', ')}`);
          legacyDebugLog(`CONFIG_INCOMPLETE_BLOCK missing=${completeness.missing.join(',')}`);
          addLog('ℹ️  Re-provisionnement requis — vérifiez votre connexion internet');
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        // Step: Config loaded
        updateStepStatus('config', 'done');
        addStepLog('quota', 'step_quota_check', 'active');

        const exhausted = await isQuotaExhausted();
        if (exhausted) {
          addStepLog('quota', 'step_quota_exhausted', 'error');
          addLog('❌ Quota data épuisé — rechargez votre abonnement');
          setIsConnecting(false);
          return;
        }
        const expired = await isConfigExpired();
        if (expired) {
          addStepLog('quota', 'step_expired', 'error');
          addLog('❌ Abonnement expiré — renouvelez votre abonnement');
          setIsConnecting(false);
          return;
        }
        addStepLog('quota', 'step_quota_ok', 'done');

        const engineProtocol = (configToUse.protocol || selectedProtocol || 'vless').toLowerCase();

        const displayProto = configToUse.displayProtocol
          || (activeConnection?.displayProtocol ?? null)
          || null;
        if (displayProto) {
          setConnectedProtocol(displayProto);
          await AsyncStorage.setItem('@sxb_connected_protocol', displayProto).catch(() => {});
        }

        // §6.4 — Frontière native : AUCUN champ null/undefined ne doit
        // atteindre Android (AOSP JSONObject.optString lit NULL comme la
        // chaîne "null" — cause du payload_len=4 de l'incident APK #165).
        const optionsJson = JSON.stringify(sanitizeEngineConfig({
          ...configToUse,
          protocol:      engineProtocol,
          killSwitch,
          autoReconnect,
          // F5 — L'APP DANS LE TUNNEL : includeOwnApp=true demande au module
          // natif de NE PAS exclure l'app du TUN (voir SxbVpnService.kt) —
          // le trafic applicatif (API, quota, configs) passe par le VPN.
          includeOwnApp: true,
        }));

        legacyDebugLog(`CONFIG_SENT_NATIVE proto=${engineProtocol}`);
        legacyDebugLog(`CONFIG_SENT_NATIVE proto=${engineProtocol}`);
        addStepLog('connecting', 'step_connecting', 'active');
        addLog(`🚀 Démarrage tunnel ${engineProtocol.toUpperCase()}...`);

        legacyDebugLog('SERVICE_STARTED — appel startVpn()');
        legacyDebugLog('SERVICE_STARTED — startVpn() envoyé au module natif');

        lastStepRef.current = `STEP_3_NATIVE_CALLED proto=${engineProtocol}`;
        startWatchdog(`STEP_3_NATIVE_CALLED proto=${engineProtocol}`);

        const startResult = await SxbVpnNative.startVpn(optionsJson);
        legacyDebugLog(`SERVICE_STARTED result=${JSON.stringify(startResult)}`);
        legacyDebugLog(`SERVICE_STARTED serviceStarted=${startResult?.serviceStarted}`);
        addStepLog('handshake', 'step_handshake', 'active');
        addLog('⏳ Connexion en cours... (watchdog 45s actif)');

      } else if (IS_ANDROID) {
        addLog('❌ Module natif VPN non chargé');
        addLog('ℹ️  Réinstallez l\'APK ou signalez ce bug');
        setVpnState('error');
        setIsConnecting(false);
        return;
      } else {
        addLog('⚠️ Mode développement — VPN simulé (non-Android)');
        await apiClient.post('/mobile/vpn/session', {
          action: 'connect',
          protocol: selectedProtocol || 'VLESS',
        });
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setVpnState('connected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        // F1 — connexion réussie (simulation dev) : compteurs delta à zéro
        lastReportUpRef.current = 0;
        lastReportDownRef.current = 0;
        legacyDebugLog('VPN_CONNECTED mode=dev-simulation');
        addLog('✅ Connecté (mode web dev)');
        setIsConnecting(false);
      }

      try {
        await apiClient.post('/mobile/vpn/session', {
          action:   'connect',
          protocol: selectedProtocol || 'VLESS',
        });
      } catch { /* non-bloquant */ }

    } catch (err: any) {
      legacyDebugLog(`VPN_FAILED error=${err?.message || 'connexion_échouée'}`);
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isConnecting, isConnected, selectedProtocol, vpnConfig, activeConnection, killSwitch, autoReconnect, deviceId, addLog, startWatchdog]);

  // ── F3 — garde connectRef synchronisé avec le connect() courant ─────────────
  useEffect(() => { connectRef.current = connect; });

  const disconnect = useCallback(async () => {
    if (isConnecting && !isConnected) return;
    setIsConnecting(true);
    addStepLog('disconnecting', 'step_disconnecting', 'active');
    addLog('🔴 Déconnexion...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        await SxbVpnNative.stopVpn();
      } else {
        await apiClient.post('/mobile/vpn/session', { action: 'disconnect' });
        await new Promise(r => setTimeout(r, 600));
        setIsConnected(false);
        setVpnState('disconnected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
        setIsConnecting(false);
      }

      if (IS_ANDROID && SxbVpnNative) {
        try {
          const stats = await SxbVpnNative.getTrafficStats();
          await reportUsageToBackend(stats.uploadBytes || 0, stats.downloadBytes || 0);
        } catch { /* ignore */ }
      }
    } catch (err: any) {
      addLog(`⚠️ Erreur déconnexion : ${err?.message || ''}`);
      setIsConnected(false);
      setVpnState('disconnected');
      await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
    } finally {
      if (!IS_ANDROID || !SxbVpnNative) setIsConnecting(false);
      // F1 — déconnexion : remise à zéro des compteurs delta (après l'envoi
      // final du delta restant dans le try ci-dessus).
      lastReportUpRef.current = 0;
      lastReportDownRef.current = 0;
    }
  }, [isConnecting, isConnected, addLog, reportUsageToBackend]);

  useEffect(() => {
    AsyncStorage.getItem('@sxb_connected_protocol').then(p => {
      if (p) setConnectedProtocol(p);
    });
  }, []);

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem('@sxb_vpn_protocol', name);
    if (isConnected) {
      addLog(`🔄 Changement protocole → ${name}...`);
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect, addLog]);

  const hasValidConfig = vpnConfig !== null || activeConnection !== null;

  return (
    <VpnContext.Provider value={{
      isConnected, isConnecting, vpnState,
      selectedProtocol, connectedProtocol, availableProtocols,
      trafficStats, vpnLogs,
      hasVpnPermission,
      hasValidConfig,
      activeConnection,
      stepLogs,
      savedConfigs, activeConfigId, switchConfig, isSwitchingConfig,
      quotaData,
      revokedStatus,
      perAppTraffic,
      logs:          vpnLogs,
      traffic:       trafficStats,
      killSwitch,
      autoReconnect,
      setKillSwitch,
      setAutoReconnect,
      syncFromConnection,
      connect, disconnect, selectProtocol,
      refreshVpnConfig, requestPermission,
    }}>
      {children}
    </VpnContext.Provider>
  );
}

const FALLBACK_PROTOCOLS: VpnProtocol[] = [
  { name: 'VLESS',       port: 443,  transport: 'TCP',  security: 'Reality',     description: 'Recommandé' },
  { name: 'VMess',       port: 80,   transport: 'WS',   security: 'None',        description: 'Compatible' },
  { name: 'Trojan',      port: 443,  transport: 'TCP',  security: 'TLS',         description: 'Stable' },
  { name: 'Shadowsocks', port: 8388, transport: 'TCP',  security: 'ChaCha20',    description: 'Léger' },
  { name: 'Hysteria2',   port: 443,  transport: 'QUIC', security: 'TLS',         description: 'Rapide' },
  { name: 'SSH',         port: 22,   transport: 'TCP',  security: 'SSH',         description: 'Sécurisé' },
  { name: 'SSH+Payload', port: 80,   transport: 'TCP',  security: 'SSH+Payload', description: 'Bypass DPI' },
  { name: 'WireGuard',   port: 51820, transport: 'UDP', security: 'WireGuard',   description: 'Rapide & sécurisé' },
  { name: 'TUIC',        port: 443,  transport: 'QUIC', security: 'TLS',         description: 'QUIC optimisé' },
];

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function useVpnContext() {
  return useContext(VpnContext);
}

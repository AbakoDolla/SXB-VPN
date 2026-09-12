/**
 * VpnContext — Moteur VPN réel SXB v5.2 (v2 — Quota réel, dérivation locale, états honnêtes)
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
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { legacyDebugLog } from '@/services/secureLogger';
import { getPrivacyConsent, requireVpnConsent } from '@/services/privacyConsent';
import { isPlayDistribution } from '@/services/distribution';
import { useTranslation } from '@/localization';
import {
  AppState, NativeModules, NativeEventEmitter, Platform, PermissionsAndroid,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import {
  saveVpnConfig, saveQuotaData, loadQuotaData, clearQuotaData,
  isQuotaExhausted, isConfigExpired,
} from '@/services/offlineStorage';
import type { QuotaData } from '@/services/offlineStorage';
import { ProvisioningError, provisionAndStore } from '@/services/provisionClient';
import { accessIssueFromError, blocksDevice, deviceAccess as selectDeviceAccess, profileRestriction, type ProfileIdentity, type ProfileStatus } from '@/services/accessPolicy';
import { getAccessState, requireDeviceAccess, requireProfileAccess, syncNativeAccessState } from '@/services/accessState';
import { accessRequestStamp, currentAccessRequest, currentIdentityRequest } from '@/services/accessEvents';
import {
  getRemoteConnections, prepareNativeAccess, reconcileAccess, refreshAccessState, refreshMobileConfigs,
  registerAccessRuntime, reportAccessSyncError, storeValue, wakeAccessObservation,
} from '@/services/accessSync';
import * as configStore from '@/services/configStore';
import { choisirProfilActif } from '@/services/activeProfile';
import { estLeurre } from '@/services/decoy';
import {
  isCompleteOfflineConfig,
  mergeConnectionMetadata,
  mergeProvisionedConfig,
  sanitizeEngineConfig,
  detectProtocolFromFields,
} from '@/services/configValidator';
import { deriveQuota, formatBytes, type DerivedQuota, type SessionCounters } from '@/services/quotaState';
import {
  accumulate as accumulateUsage, anchorLedger, isFreshLedger, loadLedger, nextReport, pendingBytes,
  saveLedger, settle as settleUsage, type UsageLedger,
} from '@/services/usageLedger';
import { useAuthContext } from './AuthContext';
import type { VpnConnection } from '@/types/api';
import {
  noteMobileHealthAppState,
  noteMobileHealthReconnect,
  reportMobileHealth,
  sendMobileHealthHeartbeat,
  MOBILE_HEALTH_HEARTBEAT_INTERVAL_MS,
} from '@/services/mobileHealth';

export { formatBytes, deriveQuota, DerivedQuota };

// ── Helper : sauvegarde protégée (jamais de config incomplète) ──────────────────
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
  downloadSpeed:  number;   // bytes/sec
  tunAttached:   boolean;   // true uniquement si les compteurs TUN noyau sont disponibles
  /**
   * Compteur kilométrique du service natif : il ne repart JAMAIS de zéro et
   * survit à la reconnexion comme à la mort de l'application. C'est la seule
   * source de la facturation du quota ; `uploadBytes`/`downloadBytes`, eux,
   * ne comptent que la session en cours et servent l'affichage temps réel.
   */
  lifetimeUploadBytes?: number;
  lifetimeDownloadBytes?: number;
  /**
   * Durée de la session détenue par le service natif. Elle survit à la
   * fermeture de l'application : tant que le tunnel tourne, le décompte
   * continue. Un compteur JavaScript repartait de zéro à chaque relance.
   */
  connectedSeconds: number;
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
  savedConfigs:       Array<{ id: string; name: string; protocol: string; isActive: boolean; status?: ProfileStatus; isFreeTrial?: boolean }>;
  activeConfigId:     string | null;
  switchConfig:       (configId: string) => Promise<void>;
  isSwitchingConfig:  boolean;
  // Quota
  quotaData:          QuotaData | null;
  derivedQuota:       DerivedQuota;
  /**
   * Compteurs de session à opposer au consommé serveur. La ligne de base est
   * avancée à CHAQUE rapport accepté : le delta vivant ne représente donc que
   * les octets pas encore comptabilisés par le serveur, jamais toute la
   * session. Sans cela, l'écran additionnait deux fois le même trafic.
   */
  quotaSession:       SessionCounters;
  // Revocation
  revokedStatus:      'none' | 'revoked' | 'suspended' | 'expired' | 'disabled' | 'exhausted';
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
  /** Supprime un profil de cet appareil. Coupe le tunnel s'il est actif. */
  deleteConfig:       (configId: string) => Promise<boolean>;
}

const DEFAULT_STATS: TrafficStats = { uploadBytes: 0, downloadBytes: 0, uploadSpeed: 0, downloadSpeed: 0, tunAttached: false, connectedSeconds: 0 };
const DEFAULT_DERIVED_QUOTA = deriveQuota(null, null, false);

/**
 * Cadence de remontée de la consommation, tunnel monté.
 *
 * 20 s = trois remontées par minute : assez court pour que le tableau de bord
 * suive la consommation réelle et pour qu'un quota épuisé coupe l'accès en
 * quelques secondes, assez long pour rester négligeable devant le service de
 * premier plan et son thread de statistiques qui tournent déjà en permanence.
 */
const USAGE_REPORT_INTERVAL_MS = 20_000;

const VpnContext = createContext<VpnContextType>({
  isConnected: false, isConnecting: false, vpnState: 'disconnected',
  selectedProtocol: null, connectedProtocol: null, availableProtocols: [],
  trafficStats: DEFAULT_STATS, vpnLogs: [],
  hasVpnPermission: false, hasValidConfig: false, activeConnection: null,
  stepLogs: [],
  savedConfigs: [], activeConfigId: null, switchConfig: async () => {}, isSwitchingConfig: false,
  quotaData: null,
  derivedQuota: DEFAULT_DERIVED_QUOTA,
  quotaSession: { sessionUp: 0, sessionDown: 0, sessionBaselineUp: 0, sessionBaselineDown: 0 },
  revokedStatus: 'none',
  perAppTraffic: [],
  logs: [], traffic: DEFAULT_STATS,
  killSwitch: false, autoReconnect: true,
  setKillSwitch: () => {}, setAutoReconnect: () => {},
  syncFromConnection: () => {},
  connect: async () => {}, disconnect: async () => {},
  selectProtocol: () => {}, refreshVpnConfig: async () => {},
  requestPermission: async () => false,
  deleteConfig: async () => false,
});

// ── Provider ─────────────────────────────────────────────────────────────────

export function VpnProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const privacyEncryptionMessage = t('privacy_encryption_error');
  const { isAuthenticated, accountState, refreshAccountState, deviceId, deviceAccess, accessReady } = useAuthContext();

  const [isConnected,        setIsConnected]        = useState(false);
  const [isConnecting,       setIsConnecting]        = useState(false);
  const [vpnState, _setVpnState] = useState('disconnected');
  const vpnStateRef = useRef('disconnected');
  const setVpnState = useCallback((s: string) => {
    _setVpnState(s);
    vpnStateRef.current = s;
  }, []);
  const [selectedProtocol,   setSelectedProtocol]    = useState<string | null>(null);
  const [connectedProtocol,  setConnectedProtocol]   = useState<string | null>(null);
  const connectedProtocolRef = useRef<string | null>(null);
  const [availableProtocols, setAvailableProtocols]  = useState<VpnProtocol[]>([]);
  const [trafficStats,       setTrafficStats]        = useState<TrafficStats>(DEFAULT_STATS);
  const [vpnLogs,            setVpnLogs]             = useState<string[]>([]);
  const [hasVpnPermission,   setHasVpnPermission]    = useState(false);
  const [vpnConfig,          setVpnConfig]           = useState<any>(null);
  const [activeConnection,   setActiveConnection]    = useState<VpnConnection | null>(null);
  const [remoteConnections,  setRemoteConnections]   = useState<VpnConnection[]>([]);
  const [killSwitch,         setKillSwitchState]      = useState<boolean>(false);
  const [autoReconnect,      setAutoReconnectState]   = useState<boolean>(true);
  const [stepLogs,           setStepLogs]             = useState<StepLogItem[]>([]);
  const [savedConfigs,       _setSavedConfigs]        = useState<Array<{ id: string; name: string; protocol: string; isActive: boolean; isFreeTrial?: boolean }>>([]);
  // Miroir synchrone de la liste : deleteConfig doit pouvoir rétablir l'état
  // exact d'avant le retrait optimiste sans dépendre de `savedConfigs`, ce qui
  // changerait l'identité du callback et redessinerait tous les écrans.
  const savedConfigsRef = useRef<Array<{ id: string; name: string; protocol: string; isActive: boolean; isFreeTrial?: boolean }>>([]);
  const setSavedConfigs = useCallback<React.Dispatch<React.SetStateAction<Array<{ id: string; name: string; protocol: string; isActive: boolean; isFreeTrial?: boolean }>>>>((value) => {
    _setSavedConfigs(prev => {
      const next = typeof value === 'function' ? (value as (p: typeof prev) => typeof prev)(prev) : value;
      savedConfigsRef.current = next;
      return next;
    });
  }, []);
  const [activeConfigId,     _setActiveConfigId]       = useState<string | null>(null);
  const activeConfigIdRef = useRef<string | null>(null);
  const setActiveConfigId = useCallback((id: string | null) => {
    activeConfigIdRef.current = id;
    _setActiveConfigId(id);
  }, []);
  const [isSwitchingConfig,  setIsSwitchingConfig]     = useState<boolean>(false);
  const [quotaData,          setQuotaData]             = useState<QuotaData | null>(null);
  const [revokedStatus,      setRevokedStatus]        = useState<'none' | 'revoked' | 'suspended' | 'expired' | 'disabled' | 'exhausted'>('none');
  const [perAppTraffic,      setPerAppTraffic]        = useState<AppTrafficStat[]>([]);

  const trafficTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const reportTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const quotaTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartRef  = useRef<number>(0);
  const lastHealthStateRef = useRef<string>('disconnected');

  useEffect(() => {
    connectedProtocolRef.current = connectedProtocol;
  }, [connectedProtocol]);

  // B12 — Les sondes périodiques (garde distant, trafic, quota) tournaient à la
  // même cadence application au premier plan ou en arrière-plan, ce qui vidait la
  // batterie et générait des requêtes inutiles. On suit l'état applicatif pour
  // court-circuiter le travail pendant que l'app n'est pas visible ; le tunnel
  // reste géré par le service natif de premier plan, rien n'est interrompu.
  const appActiveRef     = useRef<boolean>(AppState.currentState !== 'background');
  const perAppTickRef    = useRef<number>(0);

  useEffect(() => {
    if (isAuthenticated && AppState.currentState === 'active') {
      void reportMobileHealth({
        tunnelState: (
          ['disconnected', 'connecting', 'connected', 'error'].includes(vpnStateRef.current)
            ? vpnStateRef.current
            : 'disconnected'
        ) as 'disconnected' | 'connecting' | 'connected' | 'error',
        protocol: connectedProtocolRef.current,
      });
    }
    const sub = AppState.addEventListener('change', (next) => {
      appActiveRef.current = next !== 'background' && next !== 'inactive';
      void noteMobileHealthAppState(next).then((becameActive) => {
        if (!becameActive || !isAuthenticated) return;
        void reportMobileHealth({
          tunnelState: (
            ['disconnected', 'connecting', 'connected', 'error'].includes(vpnStateRef.current)
              ? vpnStateRef.current
              : 'disconnected'
          ) as 'disconnected' | 'connecting' | 'connected' | 'error',
          protocol: connectedProtocolRef.current,
        });
      });
    });
    return () => sub.remove();
  }, [isAuthenticated]);

  useEffect(() => {
    const previous = lastHealthStateRef.current;
    lastHealthStateRef.current = vpnState;
    if (!isAuthenticated || previous === vpnState) return;

    if (vpnState === 'connected') {
      sessionStartRef.current = sessionStartRef.current || Date.now();
      void reportMobileHealth({
        tunnelState: 'connected',
        protocol: connectedProtocolRef.current,
        outcome: 'success',
      });
      return;
    }

    const sessionDurationSeconds = sessionStartRef.current > 0
      ? Math.max(0, Math.round((Date.now() - sessionStartRef.current) / 1000))
      : 0;
    if (vpnState === 'error') {
      void reportMobileHealth({
        tunnelState: 'error',
        protocol: connectedProtocolRef.current,
        outcome: 'failure',
        errorCode: previous === 'connected' ? 'TUNNEL_INTERRUPTED' : 'UNKNOWN',
        sessionDurationSeconds,
      });
      sessionStartRef.current = 0;
    } else if (vpnState === 'disconnected' && previous === 'connecting') {
      void reportMobileHealth({
        tunnelState: 'disconnected',
        protocol: connectedProtocolRef.current,
        outcome: 'failure',
        errorCode: 'UNKNOWN',
      });
      sessionStartRef.current = 0;
    } else if (vpnState === 'disconnected' && previous === 'connected') {
      void reportMobileHealth({
        tunnelState: 'disconnected',
        protocol: connectedProtocolRef.current,
        sessionDurationSeconds,
      });
      sessionStartRef.current = 0;
      connectedProtocolRef.current = null;
      setConnectedProtocol(null);
    }
  }, [isAuthenticated, vpnState]);

  // ── BATTEMENT DE PRÉSENCE ────────────────────────────────────────────────
  // Les rapports de santé ne partaient qu'aux CHANGEMENTS d'état. Un appareil
  // qui perd brutalement le réseau (tunnel, batterie, application tuée par le
  // système) n'émet donc jamais de « disconnected » : côté serveur, son dernier
  // état connu reste « connected » pour toujours, et le tableau de bord le
  // compte comme connecté des jours durant.
  //
  // Le battement contredit ce silence : tant que le tunnel est monté,
  // l'application redit périodiquement qu'elle est là. Le serveur cesse alors
  // de compter tout appareil qui s'est tu au-delà de sa fenêtre de présence.
  //
  // SOBRIÉTÉ : l'effet n'est armé QUE pour un tunnel monté et une session
  // authentifiée ; il est démonté dès que le tunnel s'arrête, ne s'arme jamais
  // sans tunnel, et n'existe donc pas en arrière-plan hors connexion. Il n'est
  // en revanche pas suspendu quand l'application passe en arrière-plan : le
  // tunnel, lui, continue de tourner dans le service natif de premier plan, et
  // une présence qui disparaîtrait dès l'écran éteint serait un mensonge.
  //
  // CONSENTEMENT : sendMobileHealthHeartbeat refuse d'émettre sans accord
  // « diagnostics » ET « vpn », comme tout le reste de la télémétrie.
  //
  // TOLÉRANCE AUX PANNES : l'envoi ne rejette jamais et n'est jamais attendu.
  // Un réseau coupé ne peut ni interrompre ni ralentir le tunnel.
  useEffect(() => {
    if (!isAuthenticated || vpnState !== 'connected') return;
    const beat = () => {
      void sendMobileHealthHeartbeat({
        tunnelState: 'connected',
        protocol: connectedProtocolRef.current,
      });
    };
    heartbeatTimerRef.current = setInterval(beat, MOBILE_HEALTH_HEARTBEAT_INTERVAL_MS);
    return () => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    };
  }, [isAuthenticated, vpnState]);

  // ── LIVRE DE COMPTES DE LA CONSOMMATION ──────────────────────────────────────
  //
  // Le calcul du delta ne vit plus en mémoire. Il est tenu par `usageLedger`,
  // persisté dans AsyncStorage, et il s'appuie sur le compteur KILOMÉTRIQUE du
  // service natif — celui qui ne repart jamais de zéro. Une reconnexion, un
  // redémarrage du moteur ou la mort de l'application ne peuvent donc plus
  // effacer du trafic déjà mesuré : au pire, il est remonté plus tard.
  const ledgerRef          = useRef<UsageLedger | null>(null);
  const ledgerBusyRef      = useRef(false);
  const sessionBaselineRef = useRef<{ up: number; down: number }>({ up: 0, down: 0 });
  const sessionIdRef       = useRef<string | null>(null);
  /** Consommé serveur déjà affiché, par forfait : il ne doit jamais reculer. */
  const shownUsageRef      = useRef<{ subscriptionId: string | null; total: number; used: number } | null>(null);

  const connectRef = useRef<(() => Promise<void>) | null>(null);
  const pendingAutoConnectRef = useRef<string | null>(null);
  // Chaque appui invalide la tentative précédente : Déconnecter reste instantané,
  // même si une vérification réseau ou un provisionnement est encore en attente.
  const connectionAttemptRef = useRef(0);
  const runningProfileRef = useRef<ProfileIdentity | null>(null);
  /** Empêche une lecture native tardive de ressusciter l'UI pendant stopVpn(). */
  const disconnectInFlightRef = useRef(false);
  // Un événement native connected peut arriver après l'expiration du watchdog
  // si JSch était encore bloqué dans session.connect(). Ce marqueur empêche
  // l'ancienne tentative de ressusciter l'UI après une annulation.
  const acceptNativeConnectedRef = useRef(false);
  const watchdogRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStepRef  = useRef<string>('INIT');

  // Sélecteur unique deriveQuota. La ligne de base avance à chaque rapport
  // accepté : le delta vivant ne couvre que les octets pas encore comptés par
  // le serveur, il ne peut donc plus s'additionner au consommé déjà facturé.
  const quotaSession: SessionCounters = {
    sessionUp: trafficStats.uploadBytes,
    sessionDown: trafficStats.downloadBytes,
    sessionBaselineUp: sessionBaselineRef.current.up,
    sessionBaselineDown: sessionBaselineRef.current.down,
  };
  const currentDerivedQuota = deriveQuota(quotaData || accountState, quotaSession, isConnected);

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

  /**
   * ⚡ Journalisation par lots.
   *
   * `addLog` déclenchait un `setState` à CHAQUE ligne émise par le moteur natif.
   * Or sing-box et le tunnel SSH en produisent des dizaines par seconde pendant
   * l'établissement : chaque ligne provoquait un rendu complet de tous les écrans
   * abonnés au contexte, saturant le thread JS. C'est ce qui figeait l'interface
   * et rendait la navigation impossible au moment précis de la connexion.
   *
   * Les lignes sont désormais accumulées dans une référence — qui ne déclenche
   * aucun rendu — puis publiées à cadence fixe. Aucune ligne n'est perdue, mais
   * l'interface ne se redessine qu'à intervalle maîtrisé.
   */
  const pendingLogsRef = useRef<string[]>([]);
  const logFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = useCallback((msg: string) => {
    pendingLogsRef.current.push(msg);
    // Plafond de sécurité : si l'interface est en arrière-plan, la file ne doit
    // pas croître indéfiniment entre deux publications.
    if (pendingLogsRef.current.length > 400) {
      pendingLogsRef.current = pendingLogsRef.current.slice(-200);
    }
  }, []);

  useEffect(() => {
    const flush = () => {
      if (pendingLogsRef.current.length === 0) return;
      const batch = pendingLogsRef.current;
      pendingLogsRef.current = [];
      // Un seul rendu pour tout le lot, quel que soit son volume.
      setVpnLogs(prev => [...batch.reverse(), ...prev].slice(0, 300));
    };
    const start = () => {
      if (!logFlushTimerRef.current) logFlushTimerRef.current = setInterval(flush, 350);
    };
    const stop = () => {
      if (logFlushTimerRef.current) clearInterval(logFlushTimerRef.current);
      logFlushTimerRef.current = null;
    };
    if (appActiveRef.current) start();
    const foregroundSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        flush();
        start();
      } else {
        stop();
      }
    });
    return () => {
      stop();
      foregroundSub.remove();
    };
  }, []);

  const startWatchdog = useCallback((stepName: string, attemptId: number) => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      // Une tentative plus récente ou une déconnexion explicite a déjà invalidé
      // ce timer : il ne doit plus arrêter le tunnel courant.
      if (attemptId !== connectionAttemptRef.current) return;
      connectionAttemptRef.current++;
      acceptNativeConnectedRef.current = false;
      legacyDebugLog(`WATCHDOG_TIMEOUT step=${stepName} — aucun événement natif depuis 90s`);
      addLog(`⚠️ Délai dépassé (90s) lors de : ${stepName}. Arrêt du service...`);
      if (IS_ANDROID && SxbVpnNative) {
        try { SxbVpnNative.stopVpn(); } catch { /* ignore */ }
      }
      setIsConnected(false);
      setIsConnecting(false);
      setVpnState('error');
      watchdogRef.current = null;
    }, 90_000);
    }, [addLog]);

  const stopWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    requireVpnConsent();
    if (!IS_ANDROID || !SxbVpnNative) return true;
    try {
      const granted = await SxbVpnNative.requestVpnPermission();
      setHasVpnPermission(granted);
      return granted;
    } catch {
      return false;
    }
  }, []);

  // ── Listener événements natifs VPN ──────────────────────────────────────────
  useEffect(() => {
    if (!vpnEmitter) return;

    const stateSub = vpnEmitter.addListener('onVpnStateChange', (e: any) => {
      const s = (e?.state || e?.status || 'disconnected').toLowerCase();
      const authority = getAccessState().authority;
      if (e?.accessSession && e.accessSession !== authority?.session) return;
      if (e?.configId && runningProfileRef.current && e.configId !== runningProfileRef.current.configId) return;
      if ((s === 'connected' || s === 'handshaking') &&
          (blocksDevice(selectDeviceAccess(authority)) ||
            (runningProfileRef.current && profileRestriction(authority, runningProfileRef.current)))) {
        void stopForAccess().catch(reportAccessSyncError);
        return;
      }

      if (s === 'handshaking') {
        setVpnState('handshaking');
        addLog('⏳ Tunnel établi — Négociation du flux...');
        addStepLog('handshaking', 'step_handshake', 'pending');
        startTrafficPolling();
      } else if (s === 'connected') {
        if (!acceptNativeConnectedRef.current && vpnState !== 'handshaking') {
          // Réponse tardive d'une tentative déjà annulée par le watchdog.
          setVpnState('error');
          addLog('ℹ️ Événement connecté tardif ignoré — tentative déjà annulée');
          try { SxbVpnNative?.stopVpn(); } catch { /* ignore */ }
          return;
        }
        setVpnState('connected');
        acceptNativeConnectedRef.current = false;
        stopWatchdog();
        addStepLog('connected', 'step_vpn_active', 'done');
        setIsConnected(true);
        setIsConnecting(false);
        AsyncStorage.setItem('@sxb_vpn_connected', 'true').catch(() => {});
        legacyDebugLog('VPN_CONNECTED');
        sessionStartRef.current = Date.now();
        
        // Nouvelle session de rapport : les entrées déjà au livre gardent la
        // leur, seules les futures porteront cet identifiant.
        sessionIdRef.current = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

        // FIX — Capturer la baseline immédiatement pour que les compteurs UI 
        // et le premier rapport delta soient précis dès la première seconde.
        if (IS_ANDROID && SxbVpnNative?.getTrafficStats) {
          SxbVpnNative.getTrafficStats().then((stats: any) => {
            const up = stats?.uploadBytes || 0;
            const down = stats?.downloadBytes || 0;
            sessionBaselineRef.current = { up, down };
            setTrafficStats({
              uploadBytes: up,
              downloadBytes: down,
              uploadSpeed: 0,
              downloadSpeed: 0,
              tunAttached: stats?.tunAttached === true || stats?.tunAttached === 1,
              connectedSeconds: stats?.connectedSeconds || 0,
            });
          }).catch(() => {});
        }
        
        refreshAccountState(activeConfigIdRef.current).catch(reportAccessSyncError);
        startTrafficPolling(); // S'assurer que le polling tourne
      } else if (s === 'disconnected') {
        stopWatchdog();
        setVpnState('disconnected');
        setIsConnected(false);
        setIsConnecting(false);
        acceptNativeConnectedRef.current = false;
        addStepLog('disconnected', 'step_disconnected', 'done');
        legacyDebugLog('VPN_FAILED status=disconnected');
        addLog('🔴 VPN déconnecté');
        stopTrafficPolling();
        // Une déconnexion subie — perte de réseau, arrêt du moteur — remonte
        // immédiatement ce que le compteur kilométrique a mesuré.
        void flushUsageRef.current({ final: true });
      } else if (s === 'error') {
        stopWatchdog();
        setVpnState('error');
        acceptNativeConnectedRef.current = false;
        addStepLog('error', e.errorCode === 'PLAY_ENCRYPTION_REQUIRED' ? 'privacy_encryption_error' : 'step_error', 'error');
        legacyDebugLog('VPN_FAILED status=error');
        addLog(e.errorCode === 'PLAY_ENCRYPTION_REQUIRED' ? privacyEncryptionMessage : '❌ Erreur VPN — connexion perdue');
        setIsConnecting(false);
      }
    });

    const logSub = vpnEmitter.addListener('onVpnLog', (e: { message: string }) => {
      if (e.message?.includes('AUTO_RECONNECT_TRIGGERED')) noteMobileHealthReconnect();
      addLog(e.message?.includes('PLAY_ENCRYPTION_REQUIRED') ? privacyEncryptionMessage : e.message);
    });

    return () => { stateSub.remove(); logSub.remove(); };
  }, [addLog, refreshAccountState, stopWatchdog, privacyEncryptionMessage]);

  const startTrafficPolling = useCallback(() => {
    if (!IS_ANDROID || !SxbVpnNative) return;
    if (trafficTimerRef.current) return;
    trafficTimerRef.current = setInterval(async () => {
      // B12 — Rien à rafraîchir tant que l'interface n'est pas visible, sauf
      // pendant la poignée de main où ce sondage sert de repli de détection.
      if (!appActiveRef.current && vpnStateRef.current !== 'handshaking') {
        // Si le handshake s'est terminé pendant que l'app était masquée, ce
        // même intervalle n'a plus aucune raison de continuer à se réveiller.
        if (trafficTimerRef.current) clearInterval(trafficTimerRef.current);
        trafficTimerRef.current = null;
        return;
      }
      try {
        const stats = await SxbVpnNative.getTrafficStats();
        setTrafficStats({
          uploadBytes:   stats.uploadBytes   || 0,
          downloadBytes: stats.downloadBytes || 0,
          uploadSpeed:   stats.uploadSpeed   || 0,
          downloadSpeed: stats.downloadSpeed || 0,
          tunAttached:   stats.tunAttached === true || stats.tunAttached === 1,
          connectedSeconds: stats.connectedSeconds || 0,
        });

        // FALLBACK HANDSHAKE — Si on est en "handshaking" et qu'on voit du trafic réel
        // (plus de 500 octets reçus), on force le passage à "connected".
        if (vpnStateRef.current === 'handshaking' && (stats.downloadBytes || 0) > 500) {
          setVpnState('connected');
          setIsConnected(true);
          setIsConnecting(false);
          stopWatchdog();
          addLog('✅ Connexion vérifiée par le flux de données');
        }

        // B6 — `perAppTraffic` était exposé par le contexte mais jamais alimenté :
        // l'écran par application restait vide en permanence. Le calcul parcourt
        // les applications installées, on l'espace donc à ~30 s (1 tick sur 20).
        perAppTickRef.current = (perAppTickRef.current + 1) % 20;
        if (perAppTickRef.current === 1 && appActiveRef.current) {
          try {
            const perApp = await SxbVpnNative.getPerAppStats?.();
            if (Array.isArray(perApp)) setPerAppTraffic(perApp as AppTrafficStat[]);
          } catch { /* fonctionnalité optionnelle : ignorer */ }
        }
      } catch { /* ignore */ }
    }, 2_000);
  }, []);

  const stopTrafficPolling = useCallback(() => {
    if (trafficTimerRef.current) { clearInterval(trafficTimerRef.current); trafficTimerRef.current = null; }
    perAppTickRef.current = 0;
    setPerAppTraffic([]);
  }, []);

  /**
   * Réconcilie React avec le service natif.
   *
   * Android peut garder le VpnService en vie alors que l'activité React est
   * détruite (écran éteint, pression mémoire, retour depuis le lanceur).
   * Sans cette lecture, l'accueil revenait « déconnecté » et son chrono à zéro
   * alors que la notification et le tunnel continuaient correctement.
   */
  const syncNativeRuntime = useCallback(async () => {
    if (!IS_ANDROID || !SxbVpnNative?.getVpnState) return;
    try {
      const attempt = connectionAttemptRef.current;
      const control = await syncNativeAccessState();
      if (control?.activeProfile) runningProfileRef.current = control.activeProfile;
      const state = String(await SxbVpnNative.getVpnState()).toLowerCase();
      if (attempt !== connectionAttemptRef.current || disconnectInFlightRef.current) return;
      const authority = getAccessState().authority;
      if (blocksDevice(selectDeviceAccess(authority)) ||
          (runningProfileRef.current && profileRestriction(authority, runningProfileRef.current))) {
        await stopForAccess();
        return;
      }
      // Le dialogue d'autorisation Android place brièvement l'activité en
      // arrière-plan avant que startVpn() ait eu le temps de changer l'état
      // natif. Ne jamais écraser une transition locale encore légitime avec ce
      // « disconnected » transitoire : le watchdog couvrira un vrai blocage.
      if (
        state === 'disconnected' &&
        (vpnStateRef.current === 'connecting' || vpnStateRef.current === 'handshaking' || vpnStateRef.current === 'retrying')
      ) return;
      const connected = state === 'connected';
      const connecting = state === 'connecting' || state === 'handshaking' || state === 'retrying';
      setVpnState(state);
      setIsConnected(connected);
      setIsConnecting(connecting);

      if (connected || connecting) {
        const stats = await SxbVpnNative.getTrafficStats();
        setTrafficStats({
          uploadBytes: stats.uploadBytes || 0,
          downloadBytes: stats.downloadBytes || 0,
          uploadSpeed: stats.uploadSpeed || 0,
          downloadSpeed: stats.downloadSpeed || 0,
          tunAttached: stats.tunAttached === true || stats.tunAttached === 1,
          connectedSeconds: stats.connectedSeconds || 0,
        });
        startTrafficPolling();
      } else {
        stopTrafficPolling();
        setTrafficStats(DEFAULT_STATS);
      }
    } catch {
      // Le pont peut être indisponible pendant la reconstruction de l'activité.
      // L'événement natif suivant réconciliera l'état ; ne jamais inventer une
      // déconnexion sur une simple erreur de lecture.
    }
  }, [startTrafficPolling, stopTrafficPolling]);

  useEffect(() => {
    void syncNativeRuntime();
    const foregroundSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void syncNativeRuntime();
      // Pendant le handshake, le polling est aussi le filet de détection qui
      // promeut le tunnel dès que les premiers octets passent. Le supprimer
      // ferait échouer une connexion lorsque l'utilisateur change d'app.
      else if (vpnStateRef.current !== 'handshaking') stopTrafficPolling();
    });
    return () => foregroundSub.remove();
  }, [stopTrafficPolling, syncNativeRuntime]);

  const stopForAccess = useCallback(async () => {
    ++connectionAttemptRef.current;
    pendingAutoConnectRef.current = null;
    acceptNativeConnectedRef.current = false;
    disconnectInFlightRef.current = true;
    stopWatchdog();
    stopTrafficPolling();
    if (reportTimerRef.current) { clearInterval(reportTimerRef.current); reportTimerRef.current = null; }
    try {
      if (IS_ANDROID && SxbVpnNative) await SxbVpnNative.stopVpn();
      setIsConnected(false);
      setIsConnecting(false);
      setVpnState('disconnected');
      runningProfileRef.current = null;
      await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
    } finally {
      disconnectInFlightRef.current = false;
    }
  }, [stopTrafficPolling, stopWatchdog, setVpnState]);

  const stopForAccessRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => { stopForAccessRef.current = stopForAccess; });

  useEffect(() => {
    if (isConnected) startTrafficPolling();
    else stopTrafficPolling();
    return stopTrafficPolling;
  }, [isConnected, startTrafficPolling, stopTrafficPolling]);

  // ── REMONTÉE DE LA CONSOMMATION ─────────────────────────────────────────────
  //
  // `flushUsage` est le SEUL chemin par lequel de la consommation part vers le
  // serveur. Il fait toujours la même chose, dans cet ordre :
  //   1. lire le compteur kilométrique du natif (jamais remis à zéro) ;
  //   2. inscrire au livre les octets neufs — une lecture INFÉRIEURE à la
  //      précédente signifie une remise à zéro, donc la valeur entière est du
  //      trafic neuf, jamais un delta nul ;
  //   3. ÉCRIRE le livre sur disque AVANT tout appel réseau ;
  //   4. envoyer les entrées en attente, la plus ancienne d'abord ;
  //   5. n'effacer une entrée qu'une fois le serveur formel — accepté, ou
  //      reconnu comme déjà compté.
  //
  // Une entrée part avec les mêmes `sessionId`/`seq` et les mêmes octets à
  // chaque tentative : un rejeu ne peut donc jamais être facturé deux fois.
  const applyServerQuota = useCallback(async (data: any) => {
    if (!data || data.quotaUsedBytes === undefined || data.quotaTotalBytes === undefined) return;
    const subscriptionId: string | null = typeof data.subscriptionId === 'string' ? data.subscriptionId : null;
    const totalBytes = Math.max(0, Number(data.quotaTotalBytes) || 0);
    let usedBytes = Math.max(0, Number(data.quotaUsedBytes) || 0);

    // Le consommé ne recule JAMAIS pour un même forfait de même volume. Une
    // valeur plus basse venue d'un autre forfait — c'est le défaut qui faisait
    // retomber l'écran de 26,2 Mo à 4,2 Mo — est ignorée plutôt qu'affichée.
    const shown = shownUsageRef.current;
    if (shown && shown.subscriptionId === subscriptionId && shown.total === totalBytes && usedBytes < shown.used) {
      usedBytes = shown.used;
    }
    shownUsageRef.current = { subscriptionId, total: totalBytes, used: usedBytes };

    const currentQuota = await loadQuotaData(activeConfigIdRef.current || undefined).catch(() => null);
    const quotaConfigId = activeConfigIdRef.current || currentQuota?.configId || (activeConnection as any)?.id || 'vpn_config';
    if (totalBytes <= 0 && !currentQuota) return;
    const synced = await saveQuotaData({
      configId: quotaConfigId,
      totalQuota: totalBytes,
      usedQuota: usedBytes,
      expiryDate: data.expiresAt ?? currentQuota?.expiryDate ?? null,
    }).catch(() => null);
    if (synced) setQuotaData(synced);
    else setQuotaData(prev => prev ? { ...prev, usedQuota: usedBytes, remainingQuota: Math.max(0, totalBytes - usedBytes) } : prev);
  }, [activeConnection]);

  const flushUsage = useCallback(async (options?: { final?: boolean }) => {
    if (!isAuthenticated) return;
    if (ledgerBusyRef.current) return;
    ledgerBusyRef.current = true;
    try {
      let ledger = ledgerRef.current ?? await loadLedger();
      const stats = IS_ANDROID && SxbVpnNative
        ? await SxbVpnNative.getTrafficStats().catch(() => null)
        : null;

      if (stats && typeof stats.lifetimeUploadBytes === 'number' && typeof stats.lifetimeDownloadBytes === 'number') {
        const counters = { up: stats.lifetimeUploadBytes, down: stats.lifetimeDownloadBytes };
        // Un livre qui vient de naître s'ANCRE sur le compteur au lieu de le
        // facturer : le service peut déjà avoir des gigaoctets au compteur
        // (stockage applicatif effacé, préférences conservées) et personne ne
        // doit payer un passé que ce livre n'a jamais mesuré.
        if (isFreshLedger(ledger)) {
          ledger = anchorLedger(ledger, counters);
        } else {
          // SEUL un identifiant de forfait est envoyé. Envoyer un identifiant de
          // configuration locale — ce que faisait la version précédente en repli —
          // vaut « forfait inconnu » côté serveur, donc un refus, donc des octets
          // perdus. Sans forfait connu, le serveur crédite le forfait actif et le
          // NOMME dans sa réponse : rien ne se perd et rien n'est deviné ici.
          const reportingId = runningProfileRef.current?.subscriptionId ?? null;
          if (!sessionIdRef.current) {
            sessionIdRef.current = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
          }
          ledger = accumulateUsage(ledger, counters, { subscriptionId: reportingId, sessionId: sessionIdRef.current });
        }
      }
      ledgerRef.current = ledger;
      await saveLedger(ledger);
      if (!pendingBytes(ledger)) return;

      const stamp = accessRequestStamp();
      let exhaustedHandled = false;
      // Quelques rapports par passage suffisent : le reste attend le prochain
      // réveil plutôt que de marteler le réseau après une longue panne.
      for (let attempt = 0; attempt < (options?.final ? 6 : 3); attempt++) {
        const prepared = nextReport(ledgerRef.current ?? ledger);
        if (!prepared) break;
        ledgerRef.current = prepared.ledger;
        // Le rapport est sur disque AVANT de partir : une application tuée
        // pendant l'appel le rejouera à l'identique au démarrage suivant.
        await saveLedger(prepared.ledger);

        const result = await apiClient.post('/mobile/vpn/traffic', {
          bytesUp:   prepared.report.bytesUp,
          bytesDown: prepared.report.bytesDown,
          sessionId: prepared.report.sessionId,
          seq:       prepared.report.seq,
          reportMode: 'delta',
          subscriptionId: prepared.report.subscriptionId || undefined,
          deviceId: deviceId || undefined,
        }).catch((error: any) => {
          // 403 « forfait non possédé » : l'entrée ne sera jamais acceptée,
          // la garder bloquerait toutes les suivantes derrière elle.
          if (error?.response?.status === 403) return { data: { ok: false, rejected: true } } as any;
          return null;
        });
        if (!result) break; // Réseau indisponible : on rejouera à l'identique.

        const settled = settleUsage(ledgerRef.current, prepared.report);
        ledgerRef.current = settled;
        await saveLedger(settled);
        if (result.data?.rejected) continue;

        // Le serveur a pris ces octets en compte : la ligne de base de
        // l'affichage avance d'autant, sinon ils seraient comptés deux fois.
        if (stats) sessionBaselineRef.current = { up: stats.uploadBytes || 0, down: stats.downloadBytes || 0 };
        legacyDebugLog(`TRAFFIC_REPORT_SUCCESS up=${prepared.report.bytesUp} down=${prepared.report.bytesDown}`);

        if (!currentAccessRequest(stamp)) break;
        await applyServerQuota(result.data);

        // Quota épuisé : le serveur fait autorité, le tunnel s'arrête tout de
        // suite. Un simple affichage laisserait le client consommer au-delà de
        // ce qu'il a acheté — c'est précisément la crainte commerciale.
        if (result.data?.quotaExhausted === true && !exhaustedHandled) {
          const running = runningProfileRef.current;
          const credited = typeof result.data.subscriptionId === 'string'
            ? result.data.subscriptionId
            : prepared.report.subscriptionId;
          const concerned = !running || !credited ||
            running.subscriptionId === credited || running.configId === credited;
          if (concerned) {
            exhaustedHandled = true;
            setRevokedStatus('exhausted');
            addLog('⛔ Quota épuisé — arrêt du tunnel');
            await stopForAccessRef.current?.();
          }
          wakeAccessObservation();
          // On ne s'arrête PAS là : les entrées restantes doivent quand même
          // partir, sinon elles attendraient la prochaine connexion.
          continue;
        }
        // Legacy traffic.state combines two scopes. Re-read the control snapshot
        // instead of treating a selected plan's state as an identity revocation.
        if (result.data?.state && result.data.state !== 'ready') wakeAccessObservation();
      }
    } catch {
      // Un échec de remontée ne doit ni interrompre le tunnel ni perdre le
      // livre : ce qui n'est pas parti reste sur disque et sera rejoué.
    } finally {
      ledgerBusyRef.current = false;
    }
  }, [isAuthenticated, deviceId, applyServerQuota, addLog]);

  const flushUsageRef = useRef(flushUsage);
  useEffect(() => { flushUsageRef.current = flushUsage; });

  // ── CADENCE DE REMONTÉE ─────────────────────────────────────────────────────
  //
  // Le minuteur tournait UNIQUEMENT au premier plan : un VPN sert précisément
  // quand l'application n'est pas à l'écran, donc plus rien ne remontait
  // pendant toute la consommation réelle. Il suit désormais le TUNNEL, pas
  // l'écran : armé tant que le tunnel est monté, démonté dès qu'il s'arrête.
  //
  // Coût : un réveil toutes les 20 s (3 par minute) et une requête HTTPS de
  // quelques centaines d'octets, uniquement quand le tunnel tourne — le
  // service de premier plan et son thread de statistiques à 1 Hz sont déjà là,
  // de très loin la dépense dominante. Tunnel arrêté, zéro réveil.
  useEffect(() => {
    if (!isConnected || !isAuthenticated) return;
    const report = () => { void flushUsageRef.current(); };
    reportTimerRef.current = setInterval(report, USAGE_REPORT_INTERVAL_MS);
    const foregroundSub = AppState.addEventListener('change', (next) => {
      // Le retour à l'écran ne change pas la cadence ; il ne fait qu'avancer la
      // remontée suivante pour que l'utilisateur voie un chiffre à jour.
      if (next === 'active') report();
    });
    return () => {
      if (reportTimerRef.current) clearInterval(reportTimerRef.current);
      reportTimerRef.current = null;
      foregroundSub.remove();
    };
  }, [isConnected, isAuthenticated]);

  // ── REJEU AU DÉMARRAGE ──────────────────────────────────────────────────────
  //
  // Le delta non remonté ne vivait qu'en mémoire : le système tue régulièrement
  // une application dont le service VPN tourne depuis des heures, et il
  // mourait avec elle. Il est désormais sur disque, et cette passe le rejoue
  // dès que la session est authentifiée — tunnel monté ou non, puisque les
  // octets ont bien été consommés.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void (async () => {
      ledgerRef.current = await loadLedger();
      // Laisse `syncNativeRuntime` rétablir le profil en cours avant d'imputer
      // à un forfait les octets mesurés pendant que l'application était morte.
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (cancelled) return;
      await flushUsageRef.current();
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  // B6 — LISTENER NETINFO : re-synchro automatique dès le retour du réseau
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      const NetInfo = require('@react-native-community/netinfo');
      unsubscribe = NetInfo.addEventListener((netState: any) => {
        if (netState.isConnected && netState.isInternetReachable) {
          // refreshVpnConfig is declared below; defer lookup until this listener fires.
          wakeAccessObservation();
        }
      });
    } catch { /* ignore */ }
    return () => { if (unsubscribe) unsubscribe(); };
  }, [refreshAccountState]);

  // Les métadonnées de quota locales servent uniquement à l'affichage. Elles ne
  // constituent pas une preuve de révocation et ne doivent donc pas effacer ou
  // arrêter un profil provisionné. Les révocations sont traitées après une réponse
  // API explicite dans le rapport d'usage ou lors d'une synchronisation réussie.

  // Quota polling
  const refreshQuotaData = useCallback(async () => {
    try {
      const loaded = await loadQuotaData(activeConfigId || undefined);
      if (loaded) setQuotaData(loaded);
    } catch { /* ignore */ }
  }, [activeConfigId]);

  useEffect(() => {
    refreshQuotaData();
    const start = () => {
      if (!quotaTimerRef.current) {
        quotaTimerRef.current = setInterval(() => { void refreshQuotaData(); }, 60_000);
      }
    };
    const stop = () => {
      if (quotaTimerRef.current) clearInterval(quotaTimerRef.current);
      quotaTimerRef.current = null;
    };
    if (appActiveRef.current) start();
    const foregroundSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void refreshQuotaData();
        start();
      } else {
        stop();
      }
    });
    return () => {
      stop();
      foregroundSub.remove();
    };
  }, [refreshQuotaData]);

  const localLoadRef = useRef(0);
  const reloadLocalConfigs = useCallback(async () => {
    const request = ++localLoadRef.current;
    const authority = getAccessState().authority;
    const entries = storeValue(await configStore.list()) ?? [];
    const persistedId = await AsyncStorage.getItem('@sxb_active_config_id');
    const requested = activeConfigIdRef.current || persistedId;
    // Un profil qui ne peut plus servir — essai gratuit arrivé à échéance,
    // forfait épuisé — cède la place dès qu'une configuration utilisable
    // existe. Il reste stocké : c'est un déclassement, jamais une suppression.
    //
    // SAUF s'il est celui du tunnel EN COURS : l'écran doit dire ce qui se
    // passe réellement. Présenter un autre profil comme actif pendant qu'un
    // tunnel tourne sur celui-ci ferait mentir l'interface ; le remplacement se
    // fera au prochain passage, une fois la connexion arrêtée.
    const running = runningProfileRef.current?.configId ?? null;
    const enCours = running ? entries.find(entry => entry.configId === running) : undefined;
    const selected = enCours ?? choisirProfilActif(entries, {
      demande: requested,
      restreint: entry => !!profileRestriction(authority, entry),
    });
    const id = selected?.configId ?? null;
    const stored = id ? storeValue(await configStore.get(id)) : undefined;
    const quota = id ? await loadQuotaData(id) : null;
    if (request !== localLoadRef.current || authority !== getAccessState().authority) return;
    const remote = getRemoteConnections();
    setRemoteConnections(remote);
    setActiveConnection(remote.find(entry => entry.id === (selected?.subscriptionId || id)) ?? null);
    setActiveConfigId(id);
    setVpnConfig(stored ? { ...stored.config, configId: id } : null);
    setQuotaData(quota);
    const restriction = selected ? profileRestriction(authority, selected) : null;
    setRevokedStatus(restriction?.status === 'deleted' ? 'revoked' : restriction?.status ?? 'none');
    setSavedConfigs(entries.map(entry => ({
      id: entry.configId, name: entry.name || 'VPN', protocol: entry.displayProtocol || entry.protocol || 'VPN',
      isActive: entry.configId === id, status: profileRestriction(authority, entry)?.status ?? entry.accessStatus,
      // Marqueur d'essai tel que le serveur l'a établi, conservé au registre :
      // l'accueil s'y fie hors ligne, sans jamais relire le nom du forfait.
      isFreeTrial: entry.isFreeTrial === true,
    })));
    if (id && !selected?.isActive) storeValue(await configStore.setActive(id));
  }, [setSavedConfigs, setActiveConfigId]);

  const refreshVpnConfig = useCallback(async () => {
    if (!isAuthenticated || !accessReady) return;
    await reloadLocalConfigs();
    try { await refreshMobileConfigs(); }
    catch (error) { reportAccessSyncError(error); }
    await reloadLocalConfigs();
  }, [isAuthenticated, accessReady, reloadLocalConfigs]);

  useEffect(() => registerAccessRuntime({
    activeProfile: () => runningProfileRef.current,
    stop: stopForAccess,
    changed: reloadLocalConfigs,
  }), [stopForAccess, reloadLocalConfigs]);

  useEffect(() => {
    if (!isAuthenticated || !accessReady) return;
    void refreshVpnConfig().catch(reportAccessSyncError);
  }, [isAuthenticated, accessReady, refreshVpnConfig]);

  const syncFromConnection = useCallback((conn: VpnConnection) => {
    if (conn.id === activeConfigIdRef.current) setActiveConnection(conn);
  }, []);

  // ── CONNECT ──────────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!getPrivacyConsent().vpn) {
      addLog(t('privacy_refused'));
      return;
    }
    if (!isAuthenticated || !accessReady) {
      addLog(t('access_identity_required'));
      return;
    }
    const identityStamp = accessRequestStamp();
    const selectedId = activeConfigIdRef.current;
    if (!selectedId) {
      addLog(t('no_vpn_connections'));
      return;
    }
    try {
      requireDeviceAccess();
      const selected = storeValue(await configStore.get(selectedId));
      requireProfileAccess(selected?.meta ?? { configId: selectedId });
      runningProfileRef.current = selected?.meta ?? { configId: selectedId };
    } catch (error) {
      reportAccessSyncError(error);
      addLog(t('access_profile_blocked'));
      return;
    }
    // ⚡ Réactivité immédiate.
    //
    // Le garde refusait tout appel dès que `isConnecting` était vrai, si bien
    // qu'un appui pendant l'établissement ne produisait rien : l'utilisateur
    // devait attendre la fin d'une tentative parfois longue. Un nouvel appui
    // annule désormais la tentative en cours et en relance une immédiatement.
    if (isConnected) return;
    if (isConnecting) {
      // Invalide la tentative précédente : ses résultats tardifs seront ignorés
      // grâce au contrôle d'`attemptId` présent à chaque étape.
      ++connectionAttemptRef.current;
      acceptNativeConnectedRef.current = false;
      stopWatchdog();
      if (IS_ANDROID && SxbVpnNative) {
        // Arrêt sans attente : l'interface ne doit jamais dépendre du natif.
        void SxbVpnNative.stopVpn().catch(() => {});
      }
    }
    const attemptId = ++connectionAttemptRef.current;
    // Retour UI immédiat : le bouton et l’animation changent avant toute E/S réseau.
    setIsConnecting(true);
    setVpnState('connecting');

    // Offline/429/legacy route absence never invalidates the last known rights.
    try {
      await refreshAccessState(false, undefined, 4000);
      await reconcileAccess();
    } catch (error) {
      reportAccessSyncError(error);
      addLog('ℹ️ Vérification réseau impossible — connexion hors-ligne sur dernier état connu');
    }

    if (attemptId !== connectionAttemptRef.current || !currentIdentityRequest(identityStamp)) return;
    resetStepLogs();
    addStepLog('preparing', 'step_preparing', 'active');
    addLog('🔄 Initialisation du tunnel VPN...');

    try {
      requireDeviceAccess();
      requireProfileAccess(runningProfileRef.current ?? { configId: selectedId });
      if (IS_ANDROID && SxbVpnNative) {
        updateStepStatus('preparing', 'done');
        addStepLog('security', 'step_checking_security', 'active');

        const hasPerm = SxbVpnNative.isVpnPermissionGranted();
        if (!hasPerm) {
          requireVpnConsent();
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

        const localResult = await configStore.get(selectedId);
        if (localResult.status === 'error') {
          addLog('⚠️ Stockage temporairement illisible — nouvelle tentative…');
          setIsConnecting(false);
          return;
        }
        const offlineEntry = localResult.status === 'ok' && localResult.value
          ? { config: localResult.value.config, configId: localResult.value.meta.configId, protocol: localResult.value.meta.protocol || '' }
          : null;

        const hasCompleteOfflineConfig = Boolean(
          offlineEntry?.config && isCompleteOfflineConfig(offlineEntry.config).complete,
        );
        if (hasCompleteOfflineConfig && offlineEntry?.config) {
          if (isCompleteOfflineConfig(offlineEntry.config).complete) {
            configToUse = { ...offlineEntry.config };
            if (vpnConfig?.displayProtocol) configToUse.displayProtocol = vpnConfig.displayProtocol;
            if (vpnConfig?.configId)        configToUse.configId        = vpnConfig.configId;
            addLog('✅ Configuration sécurisée chargée — mode hors-ligne, aucun provisionnement requis');
          }
        }

        // Une configuration complète en cache est autonome : ne jamais appeler
        // provisionAndStore() dans connect(). Le provisionnement initial s'effectue
        // uniquement lors de l'activation/import ou lorsqu'aucun profil complet n'existe.
        if (!configToUse) {
          const dataToken =
            ((vpnConfig as any)?.dataToken as string | undefined) ??
            ((offlineEntry?.config as any)?.dataToken as string | undefined) ??
            ((activeConnection as any)?.dataToken as string | undefined);

          if (dataToken && deviceId) {
            addStepLog('provisioning', 'step_provisioning', 'active');
            addLog('🔒 Provisionnement sécurisé en cours...');
            try {
              const freshResult = await provisionAndStore(dataToken, deviceId);
              const freshConfig = freshResult.config;

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

              await saveCompleteConfig(configToUse, (configToUse.protocol || 'vless').toLowerCase(), selectedId, freshResult.meta.expireAt);

              if (freshResult.meta.quotaGB > 0) {
                const totalB = Math.round(freshResult.meta.quotaGB * 1024 ** 3);
                const usedB = Math.round(freshResult.meta.quotaUsedGB * 1024 ** 3);
                await saveQuotaData({
                  configId:    freshResult.meta.subscriptionId || 'provision',
                  totalQuota:  totalB,
                  usedQuota:   usedB,
                  expiryDate:  freshResult.meta.expireAt,
                }).catch(() => {});
              }

              addStepLog('provisioning', 'step_provisioned', 'done');
              addLog('✅ Configuration provisionnée avec succès');
            } catch (provErr: unknown) {
              if (accessIssueFromError(provErr)) throw provErr;
              const diagnostic = provErr instanceof ProvisioningError ? provErr.diagnostic : undefined;
              if (diagnostic?.code === 'PVN_NETWORK' || diagnostic?.code === 'PVN_TIMEOUT' || !diagnostic?.httpStatus) {
                const fallbackLocal = await configStore.get(selectedId);
                if (fallbackLocal.status === 'ok' && fallbackLocal.value?.config) {
                  configToUse = fallbackLocal.value.config;
                  addLog('ℹ️ Réseau restreint / hors-ligne détecté — utilisation du profil local sécurisé');
                } else if (activeConnection) {
                  configToUse = { ...activeConnection };
                  addLog('ℹ️ Réseau restreint / hors-ligne détecté — utilisation de la connexion active en cache');
                }
              }

              if (!configToUse) {
                const details = diagnostic
                  ? ` [${diagnostic.code}; étape=${diagnostic.stage}; essais=${diagnostic.attempts}${diagnostic.httpStatus ? `; HTTP=${diagnostic.httpStatus}` : ''}${diagnostic.requestId ? `; req=${diagnostic.requestId}` : ''}]`
                  : '';
                const message = provErr instanceof Error ? provErr.message : 'erreur inconnue';
                addStepLog('provisioning', 'step_error', 'error', diagnostic?.code || 'PVN_UNKNOWN');
                addLog(`⚠️ Provisionnement échoué : ${message}${details}`);
                setVpnState('error');
                setIsConnecting(false);
                return;
              }
              addStepLog('provisioning', 'step_provisioned', 'done');
              addLog('✅ Configuration locale chargée en mode hors-ligne');
            }
          } else {
            addLog('❌ Aucune configuration disponible — activez un forfait');
            setVpnState('error');
            setIsConnecting(false);
            return;
          }
        }

        // Un leurre n'ouvre jamais de tunnel. Il n'apparaît que si le stockage
        // a été altéré ou déchiffré avec une clé étrangère : se connecter avec
        // enverrait l'utilisateur vers un serveur inventé.
        if (estLeurre(configToUse)) {
          addLog('❌ Configuration locale altérée — réactivez votre jeton');
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        if (!configToUse.host && configToUse.protocol !== 'wireguard' && configToUse.protocol !== 'singbox') {
          addLog('❌ Configuration invalide — champ "host" manquant');
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        const completeness = isCompleteOfflineConfig(configToUse);
        if (!completeness.complete) {
          addLog(`❌ Configuration incomplète — champs manquants : ${completeness.missing.join(', ')}`);
          setVpnState('error');
          setIsConnecting(false);
          return;
        }

        updateStepStatus('config', 'done');
        addStepLog('quota', 'step_quota_check', 'active');

        // En mode hors-ligne / zero-rated, si une configuration locale complète existe,
        // on autorise la tentative de connexion même si le quota enregistré localement semble épuisé,
        // car l'opérateur mobile zero-rated permet d'atteindre le serveur VPN sans data classique.
        const exhausted = await isQuotaExhausted();
        if (exhausted) {
          addLog('ℹ️ Quota local estimé épuisé — tentative de connexion quand même (zéro-rated / hors-ligne)');
        }
        const expired = await isConfigExpired();
        if (expired) {
          addLog('ℹ️ Date d’expiration locale atteinte — tentative de connexion quand même en mode de secours');
        }
        addStepLog('quota', 'step_quota_ok', 'done');

        // Une déconnexion demandée pendant le provisionnement annule le départ
        // avant tout appel natif long ou ouverture de tunnel.
        if (attemptId !== connectionAttemptRef.current || !currentIdentityRequest(identityStamp)) return;
        // Le protocole technique vient EXCLUSIVEMENT de la configuration
        // provisionnée. À défaut d'un champ explicite, il est DÉDUIT de la forme
        // de la config (marqueurs Xray, uuid+flow, username+password…) au lieu
        // d'être supposé « vless » : ce repli en dur envoyait une configuration
        // SSH au constructeur sing-box, qui échouait sans diagnostic utile.
        // `selectedProtocol` reste en dernier recours : c'est un choix d'IHM,
        // pas une donnée technique de la configuration.
        const engineProtocol = (
          configToUse.protocol
          || detectProtocolFromFields(configToUse)
          || selectedProtocol
          || 'vless'
        ).toLowerCase();
        connectedProtocolRef.current = engineProtocol;
        setConnectedProtocol(engineProtocol);

        // Capturer le baseline initial natif
        try {
          const stats = await SxbVpnNative.getTrafficStats();
          sessionBaselineRef.current = { up: stats?.uploadBytes || 0, down: stats?.downloadBytes || 0 };
        } catch {
          sessionBaselineRef.current = { up: 0, down: 0 };
        }

        await prepareNativeAccess();
        requireDeviceAccess();
        const currentProfile = storeValue(await configStore.get(selectedId));
        if (!currentProfile) throw new Error('ACCESS_PROFILE_MISSING');
        requireProfileAccess(currentProfile.meta);
        runningProfileRef.current = currentProfile.meta;
        const optionsJson = JSON.stringify(sanitizeEngineConfig({
          ...configToUse,
          configId: selectedId,
          subscriptionId: currentProfile.meta.subscriptionId,
          configHash: currentProfile.meta.configHash,
          managedConfig: currentProfile.meta.source === 'backend' || !!currentProfile.meta.subscriptionId,
          accessSession: getAccessState().authority?.session,
          protocol:      engineProtocol,
          killSwitch,
          autoReconnect,
          includeOwnApp: true,
        }));
        requireVpnConsent();
        if (attemptId !== connectionAttemptRef.current || !currentIdentityRequest(identityStamp)) return;

        addStepLog('connecting', 'step_connecting', 'active');
        addLog(`🚀 Démarrage tunnel ${engineProtocol.toUpperCase()}...`);

        acceptNativeConnectedRef.current = true;
        startWatchdog(`STEP_3_NATIVE_CALLED proto=${engineProtocol}`, attemptId);
        await SxbVpnNative.startVpn(optionsJson);
        if (attemptId !== connectionAttemptRef.current) return;
        addStepLog('handshake', 'step_handshake', 'active');
        addLog('⏳ Connexion en cours...');
      } else {
        if (isPlayDistribution) throw new Error('VPN_ANDROID_NATIVE_REQUIRED');
        connectedProtocolRef.current = (selectedProtocol || 'vless').toLowerCase();
        setConnectedProtocol(connectedProtocolRef.current);
        await apiClient.post('/mobile/vpn/session', { action: 'connect', protocol: selectedProtocol || 'VLESS' });
        await new Promise(r => setTimeout(r, 1200));
        setIsConnected(true);
        setVpnState('connected');
        await AsyncStorage.setItem('@sxb_vpn_connected', 'true');
        addLog('✅ Connecté (mode web dev)');
        setIsConnecting(false);
      }
    } catch (err: any) {
      if (attemptId !== connectionAttemptRef.current) return;
      addLog(`❌ Erreur : ${err?.message || 'Connexion échouée'}`);
      setVpnState('error');
      setIsConnecting(false);
    }
  }, [isAuthenticated, accessReady, isConnecting, isConnected, vpnConfig, activeConnection, killSwitch, autoReconnect, deviceId, addLog, startWatchdog, resetStepLogs, addStepLog, updateStepStatus, t]);

  useEffect(() => { connectRef.current = connect; });

  // La reconnexion est différée au rendu suivant : connect() lit ainsi le profil B
  // et non la fermeture React capturée avant setActiveConfigId.
  useEffect(() => {
    if (!pendingAutoConnectRef.current || pendingAutoConnectRef.current !== activeConfigId) return;
    if (isConnecting || isConnected) return;
    pendingAutoConnectRef.current = null;
    void connectRef.current?.();
  }, [activeConfigId, isConnecting, isConnected]);

  // ── B2 — PERSISTANCE À LA DÉCONNEXION ────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (!isConnecting && !isConnected) return;
    // L’interface revient immédiatement à « Se connecter » ; l’arrêt natif et
    // l’envoi du quota se poursuivent ensuite sans bloquer l’utilisateur.
    ++connectionAttemptRef.current;
    pendingAutoConnectRef.current = null;
    disconnectInFlightRef.current = true;
    acceptNativeConnectedRef.current = false;
    stopWatchdog();
    setIsConnecting(false);
    setIsConnected(false);
    setVpnState('disconnected');
    addStepLog('disconnecting', 'step_disconnecting', 'active');
    addLog('🔴 Déconnexion...');

    try {
      if (IS_ANDROID && SxbVpnNative) {
        // ⚡ L'arrêt du tunnel part AVANT toute autre opération. Il était
        // auparavant précédé d'une lecture des compteurs : le tunnel restait
        // donc actif le temps de cet aller-retour, donnant l'impression que le
        // bouton ne répondait pas.
        await SxbVpnNative.stopVpn().catch(() => {});
      } else {
        await apiClient.post('/mobile/vpn/session', { action: 'disconnect' });
        await new Promise(r => setTimeout(r, 600));
      }

      // B2 — La consommation de fin de session n'est plus recalculée ici : le
      // livre de comptes a déjà tout inscrit, et cette passe finale l'écrit sur
      // disque puis le remonte. Ce qui ne part pas reste au livre et sera
      // rejoué, y compris après un redémarrage de l'application.
      await flushUsageRef.current({ final: true });
    } catch (err: any) {
      addLog(`⚠️ Erreur déconnexion : ${err?.message || ''}`);
    } finally {
      setIsConnected(false);
      setVpnState('disconnected');
      await AsyncStorage.setItem('@sxb_vpn_connected', 'false');
      setIsConnecting(false);

      // Remise à zéro des références de session
      sessionBaselineRef.current = { up: 0, down: 0 };
      sessionIdRef.current = null;
      disconnectInFlightRef.current = false;
      runningProfileRef.current = null;
    }
  }, [isConnecting, isConnected, addLog, addStepLog]);

  /**
   * Suppression d'un profil local.
   *
   * Le stockage savait déjà supprimer une entrée mais rien ne l'exposait à
   * l'interface : un profil révoqué ou obsolète restait indéfiniment dans la
   * liste. La suppression coupe d'abord le tunnel si le profil concerné est
   * celui en cours, puis bascule proprement sur un profil restant.
   */
  const deleteConfig = useCallback(async (configId: string) => {
    const wasActive = configId === activeConfigId;

    // Retrait IMMÉDIAT de l'affichage : l'entrée disparaît au doigt levé, sans
    // attendre la coupure du tunnel ni les écritures chiffrées du coffre, qui
    // prenaient jusqu'à plusieurs secondes et donnaient un bouton sans effet.
    const previousSaved = savedConfigsRef.current;
    setSavedConfigs(prev => prev.filter(c => c.id !== configId));
    setRemoteConnections(prev => prev.filter(c => c.id !== configId));

    if (wasActive && (isConnected || isConnecting)) {
      // L'attente est conservée : disconnect() reporte le quota de CE profil.
      // Lancé en tâche de fond, il réécrivait les compteurs après leur purge et
      // pouvait afficher le quota du profil supprimé sur le profil suivant.
      // L'entrée a déjà disparu de l'écran, donc l'attente reste invisible.
      await disconnect();
    }

    const result = await configStore.remove(configId);
    if (result.status !== 'ok') {
      setSavedConfigs(previousSaved);   // rétablir : rien n'a été supprimé
      addLog('⚠️ Suppression impossible — stockage indisponible');
      return false;
    }

    // Trace persistante : l'abonnement existe toujours côté dashboard, donc
    // sans elle le prochain /mobile/connections reprovisionnerait le profil.
    await configStore.dismiss(configId);
    await clearQuotaData(configId).catch(() => {});

    const remaining = await configStore.list();
    const entries = remaining.status === 'ok' && remaining.value ? remaining.value : [];
    setSavedConfigs(entries.map(entry => ({
      id: entry.configId,
      name: entry.name || entry.configId,
      protocol: entry.displayProtocol || entry.protocol || '',
      isActive: entry.isActive === true,
      isFreeTrial: entry.isFreeTrial === true,
    })));

    if (wasActive) {
      const next = entries[0]?.configId || null;
      if (next) {
        await configStore.setActive(next);
        setActiveConfigId(next);
        const target = await configStore.get(next);
        setVpnConfig(target.status === 'ok' && target.value ? { ...target.value.config, configId: next } : null);
        setQuotaData(await loadQuotaData(next));
      } else {
        setActiveConfigId(null);
        setVpnConfig(null);
        setQuotaData(null);
      }
    }

    addLog('🗑️ Profil supprimé de cet appareil');
    return true;
  }, [activeConfigId, isConnected, isConnecting, disconnect, addLog]);

  const switchConfig = useCallback(async (configId: string) => {
    if (isSwitchingConfig || configId === activeConfigId) return;
    const remoteTarget = remoteConnections.find(c => c.id === configId) || null;
    try {
      requireDeviceAccess();
      const target = storeValue(await configStore.get(configId));
      requireProfileAccess(target?.meta ?? { configId, configHash: remoteTarget?.configHash });
    } catch (error) {
      reportAccessSyncError(error);
      addLog(t('access_profile_blocked'));
      return;
    }

    setIsSwitchingConfig(true);
    const previousId = activeConfigId;
    const wasConnected = isConnected;
    try {
      let target = await configStore.get(configId);
      if ((target.status !== 'ok' || !target.value) && remoteTarget) {
        if (!deviceId) throw new Error('Identifiant appareil indisponible — reconnectez-vous puis réessayez');
        addLog(`🔒 Provisionnement de « ${remoteTarget.name} »...`);
        const fresh = await provisionAndStore(remoteTarget.dataToken, deviceId);
        const provisioned = mergeConnectionMetadata(mergeProvisionedConfig(null, fresh.config), {
          configId,
          subscriptionId: fresh.meta.subscriptionId,
          displayProtocol: remoteTarget.displayProtocol || fresh.meta.displayProtocol,
          dataToken: remoteTarget.dataToken,
          configVersion: fresh.meta.configVersion,
          configHash: fresh.meta.configHash,
        });
        const stored = await saveCompleteConfig(provisioned, (provisioned.protocol || remoteTarget.technicalProtocol || 'vless').toLowerCase(), configId, fresh.meta.expireAt);
        if (!stored) throw new Error('La configuration reçue est incomplète');
        target = await configStore.get(configId);
      }
      if (target.status !== 'ok' || !target.value) {
        throw new Error(target.status === 'error' ? 'Stockage temporairement illisible — nouvelle tentative…' : 'Configuration absente');
      }

      if (wasConnected || isConnecting) { addLog(`🔄 Basculement de configuration → ${configId}...`); await disconnect(); }
      requireDeviceAccess();
      requireProfileAccess(target.value.meta);
      await configStore.setActive(configId);
      setActiveConfigId(configId);
      setActiveConnection(remoteTarget);
      setRevokedStatus('none');
      setQuotaData(await loadQuotaData(configId));
      setVpnConfig({ ...target.value.config, configId, displayProtocol: target.value.meta.displayProtocol || remoteTarget?.displayProtocol, dataToken: (target.value.config as any).dataToken || remoteTarget?.dataToken });
      if (wasConnected) pendingAutoConnectRef.current = configId;
      await reloadLocalConfigs();
    } catch (err: any) {
      pendingAutoConnectRef.current = null;
      if (previousId) {
        await configStore.setActive(previousId);
        setActiveConfigId(previousId);
        const previous = await configStore.get(previousId);
        const previousRemote = remoteConnections.find(c => c.id === previousId) || null;
        if (previous.status === 'ok' && previous.value) {
          setVpnConfig({ ...previous.value.config, configId: previousId, dataToken: (previous.value.config as any).dataToken || previousRemote?.dataToken });
        }
        setActiveConnection(previousRemote);
        setQuotaData(await loadQuotaData(previousId));
        // A failed switch, including a concurrent revocation, never reconnects by itself.
      }
      addLog(`⚠️ Basculement annulé : ${err?.message || 'erreur réseau'}`);
    } finally { setIsSwitchingConfig(false); }
  }, [isSwitchingConfig, isConnected, isConnecting, activeConfigId, activeConnection, remoteConnections, deviceId, disconnect, addLog, reloadLocalConfigs, t]);

  const selectProtocol = useCallback(async (name: string) => {
    setSelectedProtocol(name);
    await AsyncStorage.setItem('@sxb_vpn_protocol', name);
    if (isConnected) {
      addLog(`🔄 Changement protocole → ${name}...`);
      await disconnect();
      setTimeout(() => connect(), 800);
    }
  }, [isConnected, connect, disconnect, addLog]);

  // B5 — `vpnConfig !== null` suffisait à activer le bouton alors qu'un profil
  // partiel (champs manquants) fait échouer le démarrage du tunnel côté natif.
  // On exige désormais un profil réellement complet, tout en conservant le repli
  // sur une connexion serveur active pour ne bloquer personne.
  const hasValidConfig = useMemo(
    () => isAuthenticated && accessReady && !blocksDevice(deviceAccess) && revokedStatus === 'none' &&
      ((vpnConfig !== null && isCompleteOfflineConfig(vpnConfig).complete) || activeConnection !== null),
    [isAuthenticated, accessReady, deviceAccess, revokedStatus, vpnConfig, activeConnection],
  );

  /**
   * ⚡ Valeur du contexte mémorisée.
   *
   * Cet objet était reconstruit littéralement à chaque rendu : sa référence
   * changeait donc systématiquement, et TOUS les écrans abonnés se redessinaient
   * même lorsque aucune donnée qui les concerne n'avait bougé. Combiné au flux de
   * logs, c'est ce qui rendait l'application inutilisable pendant la connexion.
   */
  const contextValue = useMemo(() => ({
    isConnected, isConnecting, vpnState,
    selectedProtocol, connectedProtocol, availableProtocols,
    trafficStats, vpnLogs,
    hasVpnPermission,
    hasValidConfig,
    activeConnection,
    stepLogs,
    savedConfigs, activeConfigId, switchConfig, isSwitchingConfig,
    quotaData,
    derivedQuota: currentDerivedQuota,
    quotaSession,
    revokedStatus,
    perAppTraffic,
    logs:          vpnLogs,
    traffic:       trafficStats,
    killSwitch,
    autoReconnect,
    setKillSwitch: setKillSwitchState,
    setAutoReconnect: setAutoReconnectState,
    syncFromConnection,
    connect, disconnect, selectProtocol,
    refreshVpnConfig, requestPermission,
    deleteConfig,
  }), [
    isConnected, isConnecting, vpnState,
    selectedProtocol, connectedProtocol, availableProtocols,
    trafficStats, vpnLogs, hasVpnPermission, hasValidConfig,
    activeConnection, stepLogs, savedConfigs, activeConfigId,
    switchConfig, isSwitchingConfig, quotaData, currentDerivedQuota, quotaSession,
    revokedStatus, perAppTraffic, killSwitch, autoReconnect,
    syncFromConnection, connect, disconnect, selectProtocol,
    refreshVpnConfig, requestPermission, deleteConfig,
  ]);

  return (
    <VpnContext.Provider value={contextValue}>
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

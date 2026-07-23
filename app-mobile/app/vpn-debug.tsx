/**
 * VpnDebugScreen — Écran de diagnostic VPN SXB
 * Accessible depuis Settings → Diagnostic VPN
 *
 * Affiche l'état de chaque étape du tunnel et les dernières erreurs.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ScrollView, StyleSheet, Text, TouchableOpacity, View, Clipboard, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const IS_ANDROID = Platform.OS === 'android';
const SxbVpnNative = IS_ANDROID ? (NativeModules.SxbVpnNative as any) : null;
const vpnEmitter   = SxbVpnNative ? new NativeEventEmitter(SxbVpnNative) : null;

interface StepState {
  reached: boolean;
  error:   boolean;
  detail:  string;
}

const INITIAL_STEPS: Record<string, StepState> = {
  'Permission Android':   { reached: false, error: false, detail: '' },
  'Service VPN':          { reached: false, error: false, detail: '' },
  'Config chargée':       { reached: false, error: false, detail: '' },
  'TUN créé':             { reached: false, error: false, detail: '' },
  'Sing-box lancé':       { reached: false, error: false, detail: '' },
  'SSH connecté':         { reached: false, error: false, detail: '' },
  'VPN connecté':         { reached: false, error: false, detail: '' },
};

export default function VpnDebugScreen() {
  const insets = useSafeAreaInsets();
  const [steps, setSteps]         = useState<Record<string, StepState>>(INITIAL_STEPS);
  const [logs, setLogs]           = useState<string[]>([]);
  const [lastError, setLastError] = useState<string>('—');
  const [lastStep, setLastStep]   = useState<string>('Attente...');
  const [vpnState, setVpnState]   = useState<string>('—');
  const scrollRef = useRef<ScrollView>(null);

  const addLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 300));
  };

  const updateStep = (name: string, reached: boolean, error = false, detail = '') => {
    setSteps(prev => ({ ...prev, [name]: { reached, error, detail } }));
  };

  // Parse les logs natifs pour détecter les étapes
  const parseLogForStep = (log: string) => {
    if (log.includes('STEP_4_SERVICE_STARTED') || log.includes('SERVICE_INTENT_SENT')) {
      updateStep('Service VPN', true, false, 'Service Android démarré');
      setLastStep('Service VPN démarré');
    }
    if (log.includes('STEP_5_CONFIG_LOADED') || log.includes('CONFIG_LOADED')) {
      updateStep('Config chargée', true, false, 'Config reçue et parsée');
      setLastStep('Config chargée');
    }
    if (log.includes('CONFIG_MISSING')) {
      updateStep('Config chargée', true, true, 'Configuration manquante');
      setLastError('Configuration manquante — importez un profil VPN');
    }
    if (log.includes('STEP_6_TUN_CREATING')) {
      setLastStep('TUN en création...');
    }
    if (log.includes('STEP_7_TUN_CREATED')) {
      updateStep('TUN créé', true, false, 'Interface TUN établie');
      setLastStep('TUN créé');
    }
    if (log.includes('TUN_FAILED') || log.includes('TUN_EXCEPTION') || log.includes('establish() null')) {
      updateStep('TUN créé', true, true, 'establish() null');
      setLastError('TUN échoué — vérifiez permission VPN');
    }
    if (log.includes('STEP_8_SINGBOX_START') || log.includes('SINGBOX_LAUNCH')) {
      updateStep('Sing-box lancé', false, false, 'Démarrage en cours...');
      setLastStep('Sing-box en démarrage...');
    }
    if (log.includes('SINGBOX_CRASHED') || log.includes('SINGBOX_EXCEPTION')) {
      updateStep('Sing-box lancé', true, true, 'Crash immédiat');
      setLastError('Sing-box crashé — config invalide ou binaire manquant');
    }
    if (log.includes('SINGBOX_BINARY_MISSING')) {
      updateStep('Sing-box lancé', true, true, 'Binaire introuvable');
      setLastError('Binaire sing-box introuvable dans APK');
    }
    if (log.includes('STEP_9_SSH_CONNECTING')) {
      updateStep('SSH connecté', false, false, 'Connexion en cours...');
      setLastStep('SSH en connexion...');
    }
    if (log.includes('STEP_10_SSH_AUTH_SUCCESS')) {
      updateStep('SSH connecté', true, false, 'Auth SSH OK');
      setLastStep('SSH authentifié');
    }
    if (log.includes('SSH_EXCEPTION') || log.includes('Auth fail') || log.includes('Connection refused')) {
      updateStep('SSH connecté', true, true, log.substring(0, 60));
      setLastError(log.substring(0, 120));
    }
    if (log.includes('STEP_13_VPN_CONNECTED')) {
      updateStep('VPN connecté', true, false, 'Tunnel actif');
      setLastStep('✅ VPN connecté');
    }
    if (log.includes('WATCHDOG')) {
      setLastError(log);
    }
    if (log.includes('SINGBOX_LOG')) {
      // Logs sing-box : signifie que le binaire tourne
      updateStep('Sing-box lancé', true, false, 'Binaire actif');
    }
  };

  useEffect(() => {
    if (!SxbVpnNative) return;

    // Vérifier permission initiale
    try {
      const hasPerm: boolean = SxbVpnNative.isVpnPermissionGranted();
      updateStep('Permission Android', hasPerm, !hasPerm,
        hasPerm ? 'Accordée ✅' : 'Non accordée — cliquez Connecter');
    } catch { /* ignore */ }

    // Vérifier état actuel du service
    SxbVpnNative.getVpnState().then((state: string) => {
      setVpnState(state);
      if (state === 'connected') {
        updateStep('Service VPN', true);
        updateStep('Config chargée', true);
        updateStep('TUN créé', true);
        updateStep('VPN connecté', true, false, 'Connecté');
      }
    }).catch(() => {});

    if (!vpnEmitter) return;

    const stateSub = vpnEmitter.addListener('onVpnStateChange', (e: { status: string }) => {
      setVpnState(e.status);
      if (e.status === 'connected') {
        updateStep('VPN connecté', true, false, 'Tunnel actif');
        setLastStep('✅ VPN connecté');
      } else if (e.status === 'error') {
        setLastStep('❌ Erreur VPN');
      }
      addLog(`[STATUS] ${e.status}`);
    });

    const logSub = vpnEmitter.addListener('onVpnLog', (e: { message: string }) => {
      addLog(e.message);
      parseLogForStep(e.message);
      if (e.message.includes('EXCEPTION') || e.message.includes('❌')) {
        setLastError(e.message.substring(0, 160));
      }
    });

    return () => { stateSub.remove(); logSub.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyLogs = () => {
    const text = logs.join('\n');
    Clipboard.setString(text);
    Alert.alert('Copié', `${logs.length} lignes copiées dans le presse-papier`);
  };

  const resetSteps = () => {
    setSteps(INITIAL_STEPS);
    setLogs([]);
    setLastError('—');
    setLastStep('Attente...');
  };

  const stepIcon = (s: StepState) => {
    if (s.error)   return '❌';
    if (s.reached) return '✅';
    return '⬜';
  };

  const stepColor = (s: StepState) => {
    if (s.error)   return '#FF4444';
    if (s.reached) return '#00CC88';
    return '#666';
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="bug" size={20} color="#7C5FFF" />
        <Text style={styles.headerTitle}>VPN DEBUG</Text>
        <TouchableOpacity onPress={resetSteps} style={styles.resetBtn}>
          <Ionicons name="refresh" size={16} color="#888" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* État général */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>État actuel</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Service VPN Android</Text>
            <Text style={styles.value}>{vpnState.toUpperCase()}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Dernière étape</Text>
            <Text style={[styles.value, { color: '#7C5FFF' }]}>{lastStep}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Dernière erreur</Text>
            <Text style={[styles.value, { color: '#FF4444', flexShrink: 1 }]} numberOfLines={3}>{lastError}</Text>
          </View>
        </View>

        {/* Étapes */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Flux de connexion</Text>
          {Object.entries(steps).map(([name, state]) => (
            <View key={name} style={styles.stepRow}>
              <Text style={styles.stepIcon}>{stepIcon(state)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.stepName, { color: stepColor(state) }]}>{name}</Text>
                {state.detail ? (
                  <Text style={styles.stepDetail}>{state.detail}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>

        {/* Commande logcat */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Commande logcat</Text>
          <Text style={styles.code}>
            {'adb logcat | grep -E "SXB_DEBUG|SxbVpn|ReactNativeJS"'}
          </Text>
        </View>

        {/* Logs en temps réel */}
        <View style={styles.card}>
          <View style={styles.logHeader}>
            <Text style={styles.cardTitle}>Logs ({logs.length})</Text>
            <TouchableOpacity onPress={copyLogs} style={styles.copyBtn}>
              <Ionicons name="copy-outline" size={16} color="#7C5FFF" />
              <Text style={styles.copyText}>Copier</Text>
            </TouchableOpacity>
          </View>
          {logs.length === 0 ? (
            <Text style={styles.noLogs}>En attente de logs... Lancez une connexion.</Text>
          ) : (
            logs.map((log, i) => (
              <Text
                key={i}
                style={[
                  styles.logLine,
                  log.includes('❌') || log.includes('EXCEPTION') || log.includes('ERROR')
                    ? styles.logError
                    : log.includes('✅') || log.includes('CONNECTED')
                    ? styles.logSuccess
                    : log.includes('SXB_DEBUG')
                    ? styles.logDebug
                    : {},
                ]}
              >
                {log}
              </Text>
            ))
          )}
        </View>

        <View style={{ height: insets.bottom + 32 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#060914' },
  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1A1E2E' },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: '#FFF', marginLeft: 8, letterSpacing: 1 },
  resetBtn:    { padding: 4 },
  card:        { margin: 12, marginBottom: 0, backgroundColor: '#0D1120', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#1A1E2E' },
  cardTitle:   { fontSize: 11, fontWeight: '600', color: '#7C5FFF', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 12 },
  row:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  label:       { fontSize: 13, color: '#888', flex: 1 },
  value:       { fontSize: 13, color: '#FFF', fontWeight: '600', textAlign: 'right', flex: 1 },
  stepRow:     { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#1A1E2E' },
  stepIcon:    { fontSize: 16, marginRight: 10, marginTop: 1 },
  stepName:    { fontSize: 14, fontWeight: '600' },
  stepDetail:  { fontSize: 11, color: '#666', marginTop: 2 },
  code:        { fontFamily: 'monospace', fontSize: 11, color: '#00CC88', backgroundColor: '#0A0F1E', padding: 10, borderRadius: 6 },
  logHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  copyBtn:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  copyText:    { fontSize: 12, color: '#7C5FFF' },
  noLogs:      { color: '#555', fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  logLine:     { fontSize: 10, color: '#555', fontFamily: 'monospace', paddingVertical: 1 },
  logError:    { color: '#FF6666' },
  logSuccess:  { color: '#00CC88' },
  logDebug:    { color: '#7C5FFF' },
});

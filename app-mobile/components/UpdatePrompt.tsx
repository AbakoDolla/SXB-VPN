/**
 * UpdatePrompt — Mise à jour in-app (E3)
 *
 * Fonctionnement :
 *   1. À l'ouverture (+ toutes les 24 h) → GET /api/mobile/notifications
 *   2. Compare le `versionCode` distant avec `Constants.expoConfig.android.versionCode`
 *   3. Si versionCode distant > installé → affiche une modale non bloquante
 *      « Nouvelle version disponible » avec :
 *        - bouton « Télécharger » : Download resumable vers le cache
 *          (expo-file-system), progression affichée
 *        - bouton « Plus tard » : referme la modale (rappel dans 24 h)
 *   4. À la fin du download : ouverture du .apk via IntentLauncher +
 *      FileProvider (Android). Les données sont CONSERVÉES car la signature
 *      est identique (keystore stable géré par la CI).
 *
 * Sécurité :
 *   - URL de téléchargement fournie par le serveur (source contrôlée).
 *   - Le fichier est stocké dans le cache privé de l'app (`cacheDirectory`).
 *   - Le partage FileProvider est déjà déclaré (androidx.core.content.FileProvider,
 *     autorité `<package>.provider`, chemins définis dans file_paths.xml).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
// L'API legacy est stable en SDK 54 (createDownloadResumable, getContentUriAsync).
// Utiliser l'API par défaut casserait l'appel getContentUriAsync requis pour
// ouvrir l'APK via un content:// URI compatible FileProvider.
import Colors from '@/constants/colors';
import { downloadAndInstallAppUpdate, fetchLatestAppUpdate, type AppUpdateInfo } from '@/services/appUpdate';
import { useTranslation } from '@/localization';

// Intervalle de re-vérification : 24 h (mission).
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_KEY = '@sxb_last_update_check_v1';
// Version « dismiss » : ne pas re-proposer immédiatement une version rejetée.
const DISMISS_KEY = '@sxb_dismissed_version_v1';

function currentVersionCode(): number {
  const raw = (Constants.expoConfig as any)?.android?.versionCode;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function currentVersionName(): string {
  return (Constants.expoConfig?.version as string) || '0.0.0';
}

async function fetchLatest(): Promise<AppUpdateInfo | null> {
  return fetchLatestAppUpdate();
}

// ── Composant ────────────────────────────────────────────────────────────────
export default function UpdatePrompt() {
  const { t } = useTranslation();
  const [remote, setRemote] = useState<AppUpdateInfo | null>(null);
  const [visible, setVisible] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const installedVc = useMemo(() => currentVersionCode(), []);
  const installedVn = useMemo(() => currentVersionName(), []);

  // Vérification à l'ouverture + toutes les 24 h.
  const checkForUpdate = useCallback(async (force = false) => {
    try {
      if (!force) {
        const last = Number((await AsyncStorage.getItem(CHECK_KEY)) || 0);
        if (Date.now() - last < CHECK_INTERVAL_MS) return;
      }
      await AsyncStorage.setItem(CHECK_KEY, String(Date.now()));

      const latest = await fetchLatest();
      if (!latest) return;
      if (latest.versionCode <= installedVc) return;

      // Respecter un « Plus tard » récent : ne pas re-proposer la même version
      // avant le prochain cycle de 24 h.
      const dismissed = Number((await AsyncStorage.getItem(DISMISS_KEY)) || 0);
      if (dismissed === latest.versionCode && !force) return;

      setRemote(latest);
      setVisible(true);
    } catch {
      /* silencieux — la vérif reprendra dans 24 h */
    }
  }, [installedVc]);

  useEffect(() => {
    // Ne pas lancer sur web (pas d'installateur APK).
    if (Platform.OS !== 'android') return;
    // Léger différé pour laisser l'UI s'installer.
    const timer = setTimeout(() => { checkForUpdate(false); }, 1500);
    // Re-check périodique tant que l'app tourne (toutes les 24 h).
    const interval = setInterval(() => { checkForUpdate(false); }, CHECK_INTERVAL_MS);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [checkForUpdate]);

  const onDismiss = useCallback(async () => {
    if (remote) {
      try { await AsyncStorage.setItem(DISMISS_KEY, String(remote.versionCode)); } catch {}
    }
    setVisible(false);
  }, [remote]);

  const onDownload = useCallback(async () => {
    if (!remote || downloading) return;
    setDownloading(true);
    setErrorMsg(null);
    setProgress(0);
    let installStarted = false;
    try {
      await downloadAndInstallAppUpdate(remote, setProgress, () => {
        installStarted = true;
        setInstalling(true);
      });
      // La modale peut rester ouverte — l'utilisateur revient dans l'app une
      // fois l'installation terminée.
    } catch (e) {
      // Distinguer l'échec du téléchargement de celui de l'ouverture d'intent
      // pour aider l'utilisateur.
      setErrorMsg(installStarted ? t('update_install_error') : t('update_download_error'));
    } finally {
      setDownloading(false);
      // installing reste true jusqu'à ce que la modale soit fermée
    }
  }, [remote, downloading, installing, t]);

  if (!remote) return null;

  const pct = Math.round(progress * 100);
  const label = downloading
    ? (installing ? t('update_install_prompt') : t('update_downloading_pct').replace('{pct}', String(pct)))
    : t('update_download');

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => { if (!downloading) onDismiss(); }}
    >
      <View style={styles.overlay}>
        <View style={styles.card} accessibilityLabel={t('update_available_title')}>
          <View style={styles.iconWrap}>
            <Ionicons name="cloud-download-outline" size={28} color={Colors.primary} />
          </View>
          <Text style={styles.title}>{t('update_available_title')}</Text>
          <Text style={styles.body}>{remote.notes || t('update_available_body')}</Text>

          <View style={styles.metaRow}>
            <View style={styles.metaCol}>
              <Text style={styles.metaLbl}>{t('update_current_label')}</Text>
              <Text style={styles.metaVal}>{installedVn} ({installedVc})</Text>
            </View>
            <View style={styles.metaCol}>
              <Text style={styles.metaLbl}>{t('update_new_label')}</Text>
              <Text style={[styles.metaVal, { color: Colors.primary }]}>
                {remote.versionName} ({remote.versionCode})
              </Text>
            </View>
          </View>

          {downloading && (
            <View style={styles.progressBg}>
              <View style={[styles.progressFill, { width: `${pct}%` as any }]} />
            </View>
          )}

          {errorMsg && <Text style={styles.error}>{errorMsg}</Text>}

          <View style={styles.actions}>
            <Pressable
              onPress={onDismiss}
              disabled={downloading}
              style={[styles.btn, styles.btnSecondary, downloading && styles.btnDisabled]}
            >
              <Text style={styles.btnSecondaryText}>{t('update_later')}</Text>
            </Pressable>
            <Pressable
              onPress={onDownload}
              disabled={downloading}
              style={[styles.btn, styles.btnPrimary, downloading && styles.btnDisabled]}
            >
              {downloading ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Ionicons name="download-outline" size={16} color="#000" />
              )}
              <Text style={styles.btnPrimaryText} numberOfLines={1}>{label}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(6,9,20,0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#0A0F1C',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  iconWrap: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primaryDim,
    marginBottom: 12,
  },
  title: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: '#FFF', marginBottom: 6,
  },
  body: {
    fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.textSecondary, lineHeight: 18,
  },
  metaRow: {
    flexDirection: 'row', gap: 12, marginTop: 14,
  },
  metaCol: {
    flex: 1, paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: 10, backgroundColor: Colors.bgCard,
    borderWidth: 1, borderColor: Colors.border,
  },
  metaLbl: {
    fontSize: 10, letterSpacing: 1, color: Colors.textMuted,
    fontFamily: 'Inter_500Medium', marginBottom: 2, textTransform: 'uppercase',
  },
  metaVal: {
    fontSize: 13, color: '#FFF', fontFamily: 'Inter_600SemiBold',
  },
  progressBg: {
    height: 6, borderRadius: 3, backgroundColor: Colors.border,
    marginTop: 14, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', backgroundColor: Colors.primary,
  },
  error: {
    marginTop: 10, fontSize: 12, color: Colors.disconnected, fontFamily: 'Inter_500Medium',
  },
  actions: {
    flexDirection: 'row', gap: 10, marginTop: 18,
  },
  btn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 12, borderRadius: 12,
  },
  btnPrimary: { backgroundColor: Colors.primary },
  btnPrimaryText: { color: '#000', fontFamily: 'Inter_700Bold', fontSize: 14 },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: Colors.border },
  btnSecondaryText: { color: Colors.textSecondary, fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
});

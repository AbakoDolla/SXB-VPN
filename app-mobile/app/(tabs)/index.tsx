import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState, Image, Modal, Pressable,
  ScrollView, Share, StyleSheet, Text, View, ActivityIndicator,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import apiClient from "@/services/apiClient";
import { useAuthContext } from "@/contexts/AuthContext";
import { useVpnContext, formatBytes, formatSpeed } from "@/contexts/VpnContext";
import { useColors } from "@/hooks/useColors";
import { useResponsive } from "@/hooks/useResponsive";
import UpdatePrompt from "@/components/UpdatePrompt";
import AnnouncementModal from "@/components/AnnouncementModal";
import { useTranslation } from "@/localization";
import type { VpnConnection } from "@/types/api";
import { alpha, elevation, layout, radius, spacing, type } from "@/constants/theme";
import PowerButton from "@/components/ui/PowerButton";
import QuotaRing from "@/components/ui/QuotaRing";
import VipBadge from "@/components/ui/VipBadge";
import ConfigPicker from "@/components/ui/ConfigPicker";
import AmbientGlow from "@/components/ui/AmbientGlow";
import {
  EmptyState,
  IconButton,
  Pill,
  ProgressBar,
  SectionHeader,
  StatRow,
  StatTile,
  Surface,
} from "@/components/ui/Primitives";
import { useConnectionDuration } from "@/hooks/useConnectionDuration";
import ConnectionCard from "@/components/ui/ConnectionCard";
import {
  SUIVI_INITIAL as SUIVI_RELAIS_INITIAL,
  echec as echecRelais,
  etatRelais,
  peutMontrerDebit,
  succes as succesRelais,
} from "@/services/relayProbe";
import AccessNotices from "@/components/AccessNotices";
import FreeTrialCard from "@/components/FreeTrialCard";
import { blocksDevice } from "@/services/accessPolicy";
import { connexionsNouvelles, memoriser, oublier } from "@/services/newConnectionWatch";
import { avecDelai, estLenteur } from "@/services/attenteBornee";

/**
 * Cadence de relecture des connexions pendant que l'écran est ouvert.
 *
 * Une minute : assez court pour qu'un déploiement fait depuis le tableau de
 * bord se remarque pendant que l'utilisateur est encore là, assez long pour
 * rester négligeable — c'est une requête authentifiée, pas un battement.
 */
const NOUVELLES_CONNEXIONS_INTERVALLE_MS = 60_000;

const LOGO = require("../../assets/images/icon.png");

/**
 * Emoji du salut — la SEULE exception à la règle « pas d'emoji dans l'app ».
 *
 * Demandé explicitement par le propriétaire pour cette ligne précise. Il est
 * isolé dans une constante nommée pour deux raisons : le garde-fou qui interdit
 * les emoji ailleurs peut viser cette exception sans la confondre avec un
 * retour en arrière, et un futur lecteur comprend qu'elle est délibérée plutôt
 * que d'y voir un oubli de nettoyage.
 *
 * Il est purement décoratif : le salut est déjà écrit à côté, et l'emoji est
 * masqué aux lecteurs d'écran — l'entendre annoncer « main qui salue » après le
 * mot « Bonjour » n'ajoute rien.
 */
const GREETING_EMOJI = "👋";

/**
 * États qui rendent une configuration inutilisable.
 *
 * Servent à ne proposer un changement que s'il MÈNE quelque part : suggérer
 * une configuration elle aussi retirée ferait recommencer l'utilisateur pour
 * rien. `deleted` est le cas le plus courant — le forfait a disparu de
 * l'inventaire du serveur alors que l'appareil en garde la trace.
 */
const ETATS_BLOQUANTS = new Set(['deleted', 'revoked', 'suspended', 'expired', 'exhausted']);

/**
 * Au-delà, le rafraîchissement cesse d'être ANNONCÉ — jamais interrompu.
 *
 * Vingt secondes : au-delà, l'utilisateur ne croit plus que quelque chose
 * avance. En deçà, couper l'annonce priverait d'un retour légitime une
 * liaison simplement lente.
 */
const DELAI_RAFRAICHISSEMENT_MS = 20_000;

/**
 * Issue d'un rafraîchissement demandé par l'utilisateur.
 *
 * « lent » n'est PAS un échec : le travail se poursuit, seule son annonce
 * s'arrête. Les confondre ferait ressusciter une annonce déjà traitée au
 * seul motif que le réseau a pris son temps — exactement la boucle dont
 * l'exploitant se plaint.
 */
type IssueRafraichissement = 'ok' | 'lent' | 'echec';

// ── VPN Button States ─────────────────────────────────────────────────────────
type BtnState = "no_account" | "no_package" | "connect" | "connecting" | "connected" | "exhausted" | "expired" | "blocked";

function getButtonState(
  authenticated: boolean,
  isConnected: boolean,
  isConnecting: boolean,
  hasValidConfig: boolean,
  activeConnection: import("@/types/api").VpnConnection | null,
  quotaExhausted: boolean = false,
): BtnState {
  if (!authenticated) return "no_account";
  if (isConnecting) return "connecting";
  if (isConnected) return "connected";

  // Quota/expiry are displayed separately; a valid offline profile remains usable.
  if (hasValidConfig) return "connect";
  if (activeConnection?.status === "suspended" || activeConnection?.status === 'revoked') return 'blocked';
  return "no_package";
}

// ── Main Home Screen ──────────────────────────────────────────────────────────
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const responsive = useResponsive();
  const { user, accountState, refreshAccountState, deviceId, isAuthenticated, deviceAccess } = useAuthContext();
  const {
    isConnected, isConnecting, selectedProtocol, connectedProtocol,
    hasValidConfig, activeConnection,
    connect, disconnect, trafficStats: traffic,
    refreshVpnConfig, syncFromConnection,
    savedConfigs, activeConfigId, switchConfig, isSwitchingConfig, switchingToId, revokedStatus, perAppTraffic,
    deleteConfig, derivedQuota,
  } = useVpnContext();
  const { t } = useTranslation();
  const connectedSeconds = useConnectionDuration(isConnected, traffic.connectedSeconds);

  const [configPickerVisible, setConfigPickerVisible] = useState(false);
  const [screenFocused, setScreenFocused] = useState(true);
  useFocusEffect(useCallback(() => {
    setScreenFocused(true);
    return () => setScreenFocused(false);
  }, []));
  const [isRefreshing, setIsRefreshing] = useState(false);
  /**
   * Un rafraîchissement est-il en cours ?
   *
   * Tenu par RÉFÉRENCE et non par état : deux appuis rapprochés lisent la même
   * valeur d'état et passeraient tous les deux la garde.
   */
  const rafraichissementRef = useRef(false);
  const [ping, setPing] = useState<number | null>(null);
  const [suiviRelais, setSuiviRelais] = useState(SUIVI_RELAIS_INITIAL);
  const [connections, setConnections] = useState<VpnConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  /** Connexions déployées depuis le tableau de bord et jamais encore montrées. */
  const [nouvellesConnexions, setNouvellesConnexions] = useState<string[]>([]);
  const [activeAnnouncement, setActiveAnnouncement] = useState<any>(null);

  const checkAnnouncements = React.useCallback(async () => {
    try {
      const res = await apiClient.get('/mobile/notifications');
      const data = Array.isArray(res.data) ? res.data : [];
      const ann = data.find((n: any) => n.isAnnouncement && n.type === 'critical');
      if (ann) {
        const seenStr = await AsyncStorage.getItem('@sxb_seen_announcements');
        const seenIds = JSON.parse(seenStr || '[]');
        if (!seenIds.includes(ann.id)) {
          setActiveAnnouncement(ann);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval>;
    if (isConnected) {
      const measurePing = async () => {
        const start = Date.now();
        try {
          await apiClient.get("/health", { timeout: 4000 });
          const latence = Date.now() - start;
          setPing(latence);
          // La requête a TRAVERSÉ le tunnel : c'est la seule preuve qu'il
          // transporte réellement. Voir `relayProbe.ts`.
          setSuiviRelais(prev => succesRelais(prev, latence));
        } catch {
          // On ne remet PAS le ping à null ici : un creux réseau effacerait la
          // latence de l'écran alors que le tunnel va très bien. C'est le
          // compteur d'échecs qui tranche, après trois de suite.
          setSuiviRelais(prev => echecRelais(prev));
        }
      };
      measurePing();
      // B12 — La latence n'a de sens que si l'écran est visible : le tick est
      // ignoré en arrière-plan et une mesure est relancée au retour.
      timerId = setInterval(() => {
        if (AppState.currentState !== "active") return;
        void measurePing();
      }, 10_000);
    } else {
      setPing(null);
      setSuiviRelais(SUIVI_RELAIS_INITIAL);
    }
    return () => clearInterval(timerId);
  }, [isConnected]);

  const fetchConnections = React.useCallback(async () => {
    try {
      setConnectionsLoading(true);
      const res = await apiClient.get("/mobile/connections");
      const conns: VpnConnection[] = res.data?.connections || [];
      setConnections(conns);

      // ── Nouveauté déployée depuis le tableau de bord ────────────────────
      // Sans cette comparaison, une connexion tout juste ajoutée n'était
      // signalée par rien : l'utilisateur devait deviner qu'il fallait
      // rafraîchir. On compare les IDENTIFIANTS, pas le nombre — une connexion
      // retirée et une autre ajoutée laissent le compte inchangé alors qu'il y
      // a bien du neuf.
      try {
        const nouvelles = await connexionsNouvelles(conns.map(c => c.id));
        if (nouvelles.length > 0) setNouvellesConnexions(nouvelles);
      } catch { /* la détection est un confort : elle ne doit rien casser */ }

      // Le statut `active` est celui du serveur et peut concerner plusieurs
      // abonnements. La sélection locale (`activeConfigId`) est l’autorité UI.
      const activeConn = conns.find(c => c.id === activeConfigId) || null;
      if (activeConn) syncFromConnection(activeConn);
    } catch {
      // ignore
    } finally {
      setConnectionsLoading(false);
    }
  }, [syncFromConnection, activeConfigId]);

  useEffect(() => {
    fetchConnections();
    checkAnnouncements();
  }, [fetchConnections, checkAnnouncements]);

  // Nouvelle connexion déployée pendant que l'application est ouverte.
  //
  // Une relecture périodique, et non un intervalle serré : `/mobile/connections`
  // est une requête authentifiée, et la découverte n'a pas besoin d'être
  // instantanée — elle doit seulement arriver SANS que l'utilisateur ait à s'en
  // douter. Le minuteur est démonté avec l'écran.
  useEffect(() => {
    const timer = setInterval(() => { void fetchConnections(); }, NOUVELLES_CONNEXIONS_INTERVALLE_MS);
    return () => clearInterval(timer);
  }, [fetchConnections]);

  /**
   * Recharge tout ce que l'accueil affiche, en bornant l'ATTENTE VISIBLE.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * POURQUOI UNE BORNE
   * ═══════════════════════════════════════════════════════════════════════
   * Cette chaîne n'était bornée par rien. En mesurant les délais qu'elle
   * traverse : l'état d'accès tolère 35 s, la liste des connexions 15 s, et
   * chaque configuration à provisionner rejoue trois tentatives de 15 s
   * séparées de pauses — près de 46 s par configuration. Avec deux
   * configurations neuves, le bouton restait désactivé et le tournis tournait
   * plus de deux minutes, sans un mot.
   *
   * Un tournis sans fin est pire qu'une réponse tardive : il ne dit rien et
   * n'offre aucune issue. Passé le délai, on cesse donc de l'ANNONCER — sans
   * jamais interrompre le travail, qui se poursuit et dont les résultats
   * arriveront d'eux-mêmes.
   */
  const handleRefresh = useCallback(async (): Promise<IssueRafraichissement> => {
    // Garde par RÉFÉRENCE, et non par état : deux appuis rapprochés lisent la
    // même valeur d'état, passeraient tous les deux, et le premier à finir
    // éteindrait le tournis du second.
    if (rafraichissementRef.current) return 'lent';
    rafraichissementRef.current = true;
    setIsRefreshing(true);

    const travail = (async () => {
      await refreshVpnConfig();
      await Promise.all([refreshAccountState(activeConfigId), fetchConnections()]);
    })();
    // Le travail survit au délai : sans ce récepteur, un échec tardif
    // remonterait comme rejet non traité.
    void travail.catch(() => {});

    try {
      await avecDelai(travail, DELAI_RAFRAICHISSEMENT_MS);
      return 'ok';
    } catch (erreur) {
      return estLenteur(erreur) ? 'lent' : 'echec';
    } finally {
      rafraichissementRef.current = false;
      setIsRefreshing(false);
    }
  }, [refreshVpnConfig, refreshAccountState, activeConfigId, fetchConnections]);

  /**
   * L'utilisateur charge la nouveauté : on MÉMORISE, puis on recharge.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * L'ORDRE EST LE CORRECTIF
   * ═══════════════════════════════════════════════════════════════════════
   * La mémorisation venait APRÈS le rafraîchissement. Or c'est ce même
   * rafraîchissement qui relance la détection : elle relisait une mémoire ne
   * contenant pas encore ces identifiants, les redonnait, et l'annonce que
   * l'utilisateur venait de traiter réapparaissait — à tous les coups, jamais
   * par intermittence. D'où « j'appuie sur Charger, ça charge, et ça
   * s'affiche une deuxième fois ».
   *
   * Le risque symétrique — oublier une nouveauté que le chargement n'a pas su
   * récupérer — se traite sur le chemin d'échec, avec `oublier()`.
   */
  const chargerNouvellesConnexions = useCallback(async () => {
    const aTraiter = nouvellesConnexions;
    if (aTraiter.length === 0) return;
    setNouvellesConnexions([]);
    await memoriser(aTraiter).catch(() => {});

    const issue = await handleRefresh();
    if (issue === 'echec') {
      // Une nouveauté qu'on n'a pas su charger doit RESTER annoncée : sinon
      // elle disparaîtrait sans avoir jamais servi, et plus rien ne la
      // signalerait.
      await oublier(aTraiter).catch(() => {});
      setNouvellesConnexions(aTraiter);
    }
    // Sur « lent », l'annonce reste éteinte à dessein : le travail se poursuit
    // et les connexions arriveront. La rallumer renverrait l'utilisateur dans
    // la boucle qu'il décrit — appuyer, attendre, revoir le bandeau.
  }, [nouvellesConnexions, handleRefresh]);

  /**
   * Une autre configuration, réellement utilisable, vers laquelle basculer.
   *
   * Ne proposer un changement que s'il MÈNE quelque part : suggérer une
   * configuration elle aussi retirée ou suspendue ferait recommencer
   * l'utilisateur pour rien, et lui donnerait le sentiment que l'application
   * le promène. `undefined` quand aucune ne convient — le bandeau disparaît
   * alors, plutôt que de mentir.
   */
  const configDeSecours = useMemo(
    () => savedConfigs.find((c) => !c.isActive && !ETATS_BLOQUANTS.has(String(c.status ?? 'active'))),
    [savedConfigs],
  );

  // Les animations du bouton (anneaux, respiration, appui) sont désormais
  // encapsulées dans `PowerButton`. L'écran ne conserve que l'état métier.
  const btnState = blocksDevice(deviceAccess) || revokedStatus !== 'none' ? 'blocked' :
    getButtonState(isAuthenticated, isConnected, isConnecting, hasValidConfig, activeConnection, derivedQuota.isExhausted);

  const formatTimer = (s: number) => {
    const h = Math.floor(s / 3600).toString().padStart(2, "0");
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const sec = (s % 60).toString().padStart(2, "0");
    return `${h}:${m}:${sec}`;
  };

  const handleVpnButton = async () => {
    if (blocksDevice(deviceAccess)) { router.push('/access-blocked'); return; }
    if (btnState === 'blocked') { setConfigPickerVisible(true); return; }
    if (btnState === "no_account") { router.push("/activate"); return; }
    if (btnState === "no_package" || btnState === "expired" || btnState === "exhausted") { router.push("/plan"); return; }
    if (btnState === "connect") {
      // Ne pas attendre la résolution réseau : connect() met l’interface en état
      // « connexion » immédiatement, puis poursuit le tunnel en arrière-plan.
      void connect();
    } else if (btnState === "connecting" || btnState === "connected") {
      // Le même bouton devient immédiatement une annulation/déconnexion.
      void disconnect();
    }
  };

  const btnColor = {
    no_account:  colors.primary,
    no_package:  colors.purple,
    connect:     colors.primary,
    connecting:  colors.warning,
    connected:   colors.connected,
    exhausted:   colors.disconnected,
    expired:     colors.disconnected,
    blocked:     colors.warning,
  }[btnState];

  const btnLabel = {
    no_account:  t('activate_account'),
    no_package:  t('activate_plan'),
    connect:     t('connect'),
    connecting:  t('cancel'),
    connected:   t('disconnect'),
    exhausted:   t('quota_exhausted'),
    expired:     t('expired_plan'),
    blocked:     t('access_choose_config'),
  }[btnState];

  const btnIcon = {
    no_account:  "key",
    no_package:  "gift",
    connect:     "shield-checkmark",
    connecting:  "shield",
    connected:   "power",
    exhausted:   "warning",
    expired:     "warning",
    blocked:     "pause",
  }[btnState] as keyof typeof Ionicons.glyphMap;

  // Message sous le bouton : il doit répondre à « que se passe-t-il ? » sans
  // que l'utilisateur ait à interpréter une couleur.
  const heroCaption = isConnected
    ? t('protection_active')
    : isConnecting
    ? t('connecting_status')
    : btnState === 'connect'
    ? t('tap_to_connect')
    : btnLabel;

  const activeConfig = savedConfigs.find((cfg) => cfg.id === activeConfigId) || savedConfigs[0] || null;
  // Profil visé pendant un basculement : il s'affiche dès l'appui, pour que
  // l'utilisateur voie que son choix a été pris avant même que la
  // configuration soit prête.
  const pendingConfig = switchingToId ? savedConfigs.find((cfg) => cfg.id === switchingToId) || null : null;

  // Le tunnel transporte-t-il vraiment ? Voir `relayProbe.ts` : la seule preuve
  // possible est une requête qui a réellement traversé.
  const relais = etatRelais(suiviRelais, isConnected);
  const debitFiable = peutMontrerDebit(relais);

  // Teinte d'ambiance. `null` au repos : un fond qui change en permanence
  // n'informe plus de rien, il doit rester silencieux tant qu'il n'a rien à
  // dire.
  const ambianceTeinte = relais === 'prouve'
    ? colors.accents.emeraude
    : relais === 'rompu'
    ? colors.accents.corail
    : isConnecting || relais === 'incertain'
    ? colors.accents.ambre
    : null;

  // ── L'accès actif provient-il d'un ESSAI GRATUIT ? ────────────────────────
  //
  // La réponse vient du SERVEUR et de lui seul : `/mobile/connections` marque
  // le forfait né d'une demande d'essai DÉPLOYÉE. On ne lit jamais le nom du
  // forfait (« Essai gratuit — … » est un libellé modifiable, et un forfait
  // ordinaire peut le porter) — c'est précisément le défaut corrigé côté
  // tableau de bord.
  //
  // Deux lectures du MÊME marqueur, jamais deux mécanismes : la connexion
  // distante quand l'application vient de se synchroniser, le registre local
  // — qui recopie cette même réponse — pour rester juste hors ligne.
  const isTrialAccess = activeConnection?.isFreeTrial === true || activeConfig?.isFreeTrial === true;

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      {/* Halo d'ambiance piloté par l'ÉTAT RÉEL de la liaison.
          
          La couleur répond ici à « est-ce que ça marche » plutôt que de
          décorer : émeraude quand le tunnel a prouvé qu'il relaie, corail
          quand il est monté sans rien transporter, ambre pendant
          l'établissement, rien au repos.
          
          Il est posé DERRIÈRE le contenu et n'intercepte aucun geste. Il
          n'anime que son opacité, donc sur le GPU. */}
      <AmbientGlow tone={ambianceTeinte} visible={ambianceTeinte !== null} />
      <AnnouncementModal
        announcement={activeAnnouncement}
        onClose={async () => {
          if (activeAnnouncement) {
            const seenStr = await AsyncStorage.getItem('@sxb_seen_announcements');
            const seenIds = JSON.parse(seenStr || '[]');
            seenIds.push(activeAnnouncement.id);
            await AsyncStorage.setItem('@sxb_seen_announcements', JSON.stringify(seenIds));
          }
          setActiveAnnouncement(null);
        }}
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: responsive.screenPadding,
            paddingTop: insets.top + spacing.sm,
            // La barre d'onglets flotte au-dessus du contenu : cette marge
            // garantit que la dernière carte reste entièrement atteignable.
            paddingBottom: insets.bottom + layout.tabBarClearance,
            maxWidth: responsive.contentMaxWidth,
            width: "100%",
            alignSelf: "center",
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Ligne de marque. Le logo était importé mais jamais rendu : l'écran
            principal ne portait aucune identité visuelle, alors que le splash,
        {/* En-tête : le salut porte l'identité, les actions restent à droite.
            La ligne « logo + SXB VPN » qui précédait a été retirée : le nom du
            produit est déjà partout — écran de démarrage, notification,
            libellé sous l'icône — et le répéter ici volait la première ligne à
            la seule information qui change, celle de la personne. */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <View style={styles.greetingRow}>
              <Text style={[type.caption, { color: colors.textMuted }]}>{t('greeting_default')}</Text>
              <Text style={styles.greetingEmoji} accessibilityElementsHidden importantForAccessibility="no">
                {GREETING_EMOJI}
              </Text>
            </View>
            <Text
              style={[type.h1, { color: colors.textPrimary }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
              {user?.name || t('user_default')}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <IconButton
              icon="refresh"
              onPress={() => { void handleRefresh(); }}
              disabled={isRefreshing}
              accessibilityLabel={t('refresh_config')}
            >
              {isRefreshing ? <ActivityIndicator size="small" color={colors.primary} /> : undefined}
            </IconButton>
            <IconButton
              icon="settings-outline"
              onPress={() => router.push("/settings")}
              accessibilityLabel={t('settings')}
            />
          </View>
        </View>

        <AccessNotices />
        {/* ── NOUVELLE CONNEXION DÉPLOYÉE ─────────────────────────────────
            Jusqu'ici, une connexion ajoutée depuis le tableau de bord
            n'apparaissait qu'au prochain démarrage, ou si l'utilisateur pensait
            de lui-même à rafraîchir : rien ne le lui disait, il devait le
            deviner. Placée juste sous les avis d'accès, l'annonce est vue sans
            faire défiler, et le bouton fait le geste à sa place. */}
        {nouvellesConnexions.length > 0 && (
          <Surface tone={colors.primary}>
            <View style={styles.bannerRow}>
              <Ionicons name="notifications" size={22} color={colors.primary} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.h3, { color: colors.primary }]}>{t('new_connection_title')}</Text>
                <Text style={[type.caption, { color: colors.textSecondary }]}>
                  {t('new_connection_body')}
                </Text>
              </View>
              <Pressable
                onPress={() => { void chargerNouvellesConnexions(); }}
                disabled={isRefreshing}
                accessibilityRole="button"
                accessibilityLabel={t('new_connection_action')}
                  style={{
                    minHeight: responsive.touchTarget,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                    borderRadius: radius.md,
                    backgroundColor: colors.primary + alpha.f16,
                    opacity: isRefreshing ? 0.5 : 1,
                    justifyContent: "center",
                  }}
                >
                <Text style={[type.caption, { color: colors.primary, fontWeight: '700' }]}>
                  {t('new_connection_action')}
                </Text>
              </Pressable>
            </View>
          </Surface>
        )}
        {/* Only the selected configuration is blocked here, never the identity. */}
        {revokedStatus !== 'none' && (
          <Surface tone={colors.disconnected}>
            <View style={styles.bannerRow}>
              <Ionicons name="warning" size={22} color={colors.disconnected} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.h3, { color: colors.disconnected }]}>
                  {revokedStatus === 'exhausted' ? t('quota_exhausted') : revokedStatus === 'revoked' ? t('connection_revoked') : revokedStatus === 'suspended' ? t('connection_suspended') : revokedStatus === 'expired' ? t('connection_expired') : t('connection_disabled')}
                </Text>
                <Text style={[type.caption, { color: colors.textSecondary }]}>
                  {revokedStatus === 'exhausted' ? t('friendly_quota_exhausted') : revokedStatus === 'revoked' ? t('revocation_msg_revoked') : revokedStatus === 'suspended' ? t('revocation_msg_suspended') : revokedStatus === 'expired' ? t('revocation_msg_expired') : t('revocation_msg_disabled')}
                </Text>
              </View>
            </View>
          </Surface>
        )}

        {/* ── PÉRIODE D'ESSAI ─────────────────────────────────────────────
            Carte réservée aux accès issus d'un essai gratuit. Elle est placée
            avant tout le reste : c'est l'information qui change le sens de
            l'écran. Un appareil à ACCÈS COMPLET ne la monte jamais — son écran
            reste rigoureusement celui d'avant.

            La consommation vient de `derivedQuota`, exactement la même source
            que la carte « Quota du forfait » plus bas : aucune requête
            supplémentaire, aucun risque de deux chiffres divergents. */}
        {isTrialAccess && (
          <FreeTrialCard
            usedBytes={derivedQuota.usedBytes}
            remainingBytes={derivedQuota.remainingBytes}
            totalBytes={derivedQuota.totalBytes}
            usedRatio={derivedQuota.usedRatio}
            endsAt={derivedQuota.expiryDate ?? activeConnection?.expiresAt ?? null}
          />
        )}

        {/* Sélecteur de profils. Les pastilles sur une ligne devenaient
            illisibles au-delà de deux profils et ne permettaient aucune
            suppression : l'accueil n'affiche plus que le profil courant et
            ouvre une feuille dédiée pour gérer l'ensemble. */}
        {savedConfigs.length > 0 && (
          <Surface>
            <SectionHeader
              title={t('config_switch')}
              icon="swap-horizontal-outline"
              trailing={isSwitchingConfig ? <ActivityIndicator size="small" color={colors.primary} /> : undefined}
            />
            <Pressable
              onPress={() => setConfigPickerVisible(true)}
              accessibilityRole="button"
              accessibilityLabel={t('config_manage')}
              style={({ pressed }) => [
                styles.configCurrent,
                { borderColor: colors.border, backgroundColor: colors.bgCard2 },
                pressed && { opacity: 0.75 },
              ]}
            >
              <View style={[styles.configIcon, { backgroundColor: colors.primaryDim }]}>
                <Ionicons name="shield-checkmark" size={19} color={colors.primary} />
              </View>
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text style={[type.h3, { color: colors.textPrimary }]} numberOfLines={2}>
                  {pendingConfig?.name || activeConfig?.name || t('config_switch')}
                </Text>
                <Text style={[type.caption, { color: pendingConfig ? colors.primary : colors.textSecondary }]}>
                  {pendingConfig
                    ? t('config_switching')
                    : `${savedConfigs.length} ${t(savedConfigs.length > 1 ? 'config_plural' : 'config_singular')}`}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>

            {/* ── Sortie de secours ────────────────────────────────────────
                Quand la configuration en cours ne vaut plus — retirée,
                suspendue, expirée — l'application se contentait de couper le
                tunnel. L'utilisateur appuyait, voyait la connexion retomber,
                et n'avait pour tout recours qu'une liste de profils sans
                indication de celui qui marche.

                Ce bandeau ne s'affiche que s'il existe VRAIMENT une autre
                configuration utilisable, et bascule dessus en un geste. */}
            {revokedStatus !== 'none' && configDeSecours && (
              <Pressable
                onPress={() => void switchConfig(configDeSecours.id)}
                disabled={isSwitchingConfig}
                accessibilityRole="button"
                accessibilityLabel={t('switch_action')}
                style={({ pressed }) => [
                  styles.configCurrent,
                  {
                    marginTop: spacing.sm,
                    borderColor: colors.primary + alpha.f24,
                    backgroundColor: colors.primaryDim,
                  },
                  pressed && { opacity: 0.75 },
                ]}
              >
                <View style={[styles.configIcon, { backgroundColor: colors.primaryDim }]}>
                  <Ionicons name="swap-horizontal" size={19} color={colors.primary} />
                </View>
                <View style={{ flex: 1, gap: spacing.xs }}>
                  <Text style={[type.captionMedium, { color: colors.primary }]}>{t('switch_suggestion')}</Text>
                  <Text style={[type.h3, { color: colors.textPrimary }]} numberOfLines={1}>
                    {configDeSecours.name}
                  </Text>
                </View>
                {isSwitchingConfig
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="arrow-forward" size={18} color={colors.primary} />}
              </Pressable>
            )}
          </Surface>
        )}

        {/* ── ZONE HÉROS ──────────────────────────────────────────────────
            Statut, bouton et informations vives forment un bloc unique : c'est
            la seule partie de l'écran qui doit être lisible à bout de bras. */}
        <View style={styles.hero}>
          {/* Conservée : c'est le seul endroit qui dit « Protection inactive ».
              La légende du bouton, elle, donne l'instruction (« Appuyez pour
              vous connecter »), pas l'état. */}
          <Pill
            label={isConnected ? t('protection_active') : isConnecting ? t('connecting_status') : t('protection_inactive')}
            tone={btnColor}
            dot
          />

          <PowerButton
            tone={btnColor}
            icon={btnIcon}
            caption={heroCaption}
            // Le service natif possède l'horloge autoritaire. Cette durée
            // continue pendant que l'app est en arrière-plan ou que React est
            // recréé ; l'ancien compteur JS repartait alors de 00:00:00.
            timer={isConnected ? formatTimer(connectedSeconds) : null}
            active={isConnected}
            busy={isConnecting}
            visible={screenFocused}
            onPress={handleVpnButton}
            accessibilityLabel={btnLabel}
          />

          <Pressable
            onPress={handleVpnButton}
            accessibilityRole="button"
            accessibilityLabel={btnLabel}
            style={({ pressed }) => [
              styles.cta,
              { maxWidth: Math.min(320, Math.max(220, responsive.width - responsive.screenPadding * 2)) },
              { backgroundColor: btnColor },
              pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] },
            ]}
          >
            <Ionicons name={btnIcon} size={18} color={colors.primaryForeground} />
            <Text style={[type.h3, { color: colors.primaryForeground }]}>{btnLabel}</Text>
          </Pressable>

          {/* Journal d'activité — sous le bouton, là où on le cherche quand une
              connexion ne part pas. Il ne montre que des ÉTAPES en clair :
              aucune adresse de serveur, aucune configuration, aucun identifiant
              ne peut y figurer, même en cas de débogage. */}
          <Pressable
            onPress={() => router.push('/journal' as any)}
            accessibilityRole="button"
            accessibilityLabel={t('journal_open')}
            style={({ pressed }) => [
              styles.logsButton,
              { borderColor: colors.border, backgroundColor: colors.bgCard },
              pressed && { opacity: 0.75, transform: [{ scale: 0.985 }] },
            ]}
          >
            <Ionicons name="list-outline" size={16} color={colors.textSecondary} />
            <Text style={[type.captionMedium, { color: colors.textSecondary }]}>{t('journal_open')}</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </Pressable>

          {/* Bandeau vif : le PING, et lui seul.

              Le protocole a été retiré — il désigne la technique de transport,
              et l'exposer sur l'écran principal revenait à décrire la
              configuration que l'exploitant vend : une capture d'écran
              suffisait à la deviner.

              L'adresse de sortie n'y figure pas davantage, pour la même raison.
              La durée de session est déjà lisible au centre du bouton. Reste
              donc la seule mesure qui renseigne l'utilisateur sur la QUALITÉ de
              sa liaison, sans rien dire de sa nature. */}
          <Surface style={styles.liveStrip} padded={false}>
            <StatRow>
              <StatTile
                label={t('info_ping')}
                value={ping ? `${ping} ms` : "—"}
                icon="pulse-outline"
                tone={colors.accents.emeraude}
                monospace
              />
            </StatRow>
          </Surface>
        </View>

        {/* ── QUOTA — Consomme deriveQuota (B1/B4) ──────────────────────────
            Masqué pendant un ESSAI : la carte d'essai, juste au-dessus, porte
            déjà le consommé, le restant, la barre de progression et
            l'échéance — et elle les tient de la MÊME source. Les deux ensemble
            faisaient lire les mêmes nombres deux fois en descendant un seul
            écran. */}
        {derivedQuota.totalBytes > 0 && !isTrialAccess && (
          <Surface>
            <SectionHeader
              title={t('card_quota_plan')}
              icon="cellular-outline"
              // LA DISTINCTION DEMANDÉE : un accès d'essai monte la carte
              // violette au-dessus ; un accès PAYANT porte cette plaque dorée.
              // Le marqueur est STRUCTUREL — il dépend de `isTrialAccess`, donc
              // du marqueur d'essai établi par le serveur, jamais du NOM du
              // forfait. Déduire un rang d'un nom fut précisément le défaut
              // corrigé côté serveur, et le test l'interdit depuis.
              trailing={<VipBadge label={t('badge_vip')} compact />}
            />
            {derivedQuota.isExhausted ? (
              <EmptyState icon="warning-outline" title={t('quota_exhausted')} description={t('quota_reload')} />
            ) : (
              <>
                {/* Le RESTANT devient le chiffre principal : c'est la seule
                    question que l'utilisateur se pose devant cette carte. Total
                    et consommé restent lisibles juste en dessous, mais cessent
                    de lui disputer le regard. */}
                <View style={styles.quotaHero}>
                  <View style={styles.quotaHeroText}>
                    <Text
                      style={[
                        // Un chiffre en très grand corps, agrandi encore par le
                        // réglage système, déborde sur un écran de 320 dp.
                        // `adjustsFontSizeToFit` ne rattrape que sur l'appareil.
                        responsive.isCompact || responsive.fontScale >= 1.25 ? type.h1 : type.display,
                        { color: colors.connected, fontVariant: ['tabular-nums'] },
                      ]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.6}
                    >
                      {derivedQuota.formattedRemaining}
                    </Text>
                    <Text style={[type.captionMedium, { color: colors.textSecondary }]}>
                      {t('quota_remaining')}
                    </Text>
                  </View>
                  <QuotaRing
                    progress={derivedQuota.usedRatio}
                    tone={colors.primary}
                    warnTone={colors.disconnected}
                    label={t('quota_used')}
                  />
                </View>

                <ProgressBar
                  progress={derivedQuota.usedRatio}
                  tone={colors.primary}
                  warnTone={colors.disconnected}
                />

                <StatRow>
                  <StatTile label={t('quota_used')} value={derivedQuota.formattedUsed} monospace />
                  <StatTile label={t('quota_total')} value={derivedQuota.formattedTotal} monospace />
                </StatRow>

                {derivedQuota.expiryDate && (
                  <View style={styles.metaRow}>
                    <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
                      {t('config_expires_at')} {new Date(derivedQuota.expiryDate).toLocaleDateString("fr-FR", { dateStyle: "medium" })}
                    </Text>
                  </View>
                )}
              </>
            )}
          </Surface>
        )}

        {/* Trafic temps réel — conditionné à la PREUVE que le tunnel relaie.

            LE DÉFAUT CORRIGÉ : cette carte affichait un débit tiré des
            compteurs de l'interface TUN, qui mesurent ce que le système ÉCRIT
            DANS le tunnel — retransmissions comprises. Quand le relais était
            cassé, les applications réessayaient et le compteur grimpait
            d'autant plus vite que rien ne passait. L'indicateur le plus
            rassurant de l'écran était alimenté par l'échec lui-même.

            Le débit n'apparaît donc plus que si une requête a RÉELLEMENT
            traversé le tunnel (voir `relayProbe.ts`). */}
        {isConnected && relais === 'rompu' && (
          <Surface tone={colors.accents.corail}>
            <View style={styles.relaisRow}>
              <View style={[styles.relaisIcon, { backgroundColor: colors.accents.corail + alpha.f16, borderColor: colors.accents.corail + alpha.f40 }]}>
                <Ionicons name="warning-outline" size={19} color={colors.accents.corail} />
              </View>
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text style={[type.h3, { color: colors.accents.corail }]}>{t('relay_broken_title')}</Text>
                <Text style={[type.caption, { color: colors.textSecondary }]}>{t('relay_broken_hint')}</Text>
              </View>
            </View>
          </Surface>
        )}

        {isConnected && relais !== 'rompu' && (
          <Surface>
            <SectionHeader
              title={t('card_traffic_realtime')}
              icon="swap-vertical-outline"
              trailing={
                debitFiable
                  ? <Pill label={t('protection_active')} tone={colors.accents.emeraude} dot />
                  : <Pill label={t('relay_checking')} tone={colors.accents.ambre} />
              }
            />
            {!debitFiable ? (
              // Tant que rien n'a traversé, on ne montre AUCUN chiffre : mieux
              // vaut dire qu'on vérifie que d'annoncer une vitesse à quelqu'un
              // dont la connexion ne fonctionne peut-être pas.
              <Text style={[type.caption, { color: colors.textMuted }]}>
                {t('relay_checking_hint')}
              </Text>
            ) : (
              <>
                <StatRow>
                  <StatTile
                    label={t('traffic_sent')}
                    value={formatBytes(traffic.uploadBytes)}
                    icon="arrow-up-outline"
                    tone={colors.accents.cyan}
                    monospace
                  />
                  <StatTile
                    label={t('traffic_received')}
                    value={formatBytes(traffic.downloadBytes)}
                    icon="arrow-down-outline"
                    tone={colors.accents.emeraude}
                    monospace
                  />
                </StatRow>
                {/* Les débits instantanés sont séparés des volumes cumulés : ce
                    sont deux natures de mesure, les mêler nuisait à la lecture. */}
                <View style={[styles.speedRow, { borderTopColor: colors.border }]}>
                  <View style={styles.speedItem}>
                    <Ionicons name="arrow-up" size={13} color={colors.accents.cyan} />
                    <Text style={[type.captionMedium, { color: colors.textSecondary, fontVariant: ['tabular-nums' as const] }]}>
                      {formatSpeed(traffic.uploadSpeed)}
                    </Text>
                  </View>
                  <View style={styles.speedItem}>
                    <Ionicons name="arrow-down" size={13} color={colors.accents.emeraude} />
                    <Text style={[type.captionMedium, { color: colors.textSecondary, fontVariant: ['tabular-nums' as const] }]}>
                      {formatSpeed(traffic.downloadSpeed)}
                    </Text>
                  </View>
                  <Text style={[type.micro, { color: colors.textMuted }]}>{t('traffic_speed')}</Text>
                </View>
              </>
            )}
          </Surface>
        )}

        {/* La carte « Consommation par application » a été retirée sur demande
            du propriétaire. Elle listait des noms de paquets bruts avec deux
            volumes chacun — une sortie de débogage, pas une information : rien
            n'y était actionnable, et elle allongeait l'accueil entre le trafic
            temps réel et la liste des connexions, qui sont les deux blocs
            réellement consultés.

            La MESURE n'est pas supprimée : `perAppTraffic` reste exposé par
            `VpnContext` et alimenté par le moteur. Seul son affichage disparaît,
            de sorte qu'un futur écran dédié puisse la reprendre sans rien
            recâbler. */}

        {/* ── Connexions VPN ──────────────────────────────────────────────── */}
        <Surface>
          <SectionHeader
            title={t('vpn_connections')}
            icon="server-outline"
            trailing={
              <Pressable onPress={fetchConnections} disabled={connectionsLoading} hitSlop={10}>
                {connectionsLoading
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="refresh" size={16} color={colors.primary} />}
              </Pressable>
            }
          />
          {connections.length === 0 ? (
            <EmptyState
              icon="shield-outline"
              title={connectionsLoading ? t('loading') : t('no_vpn_connections')}
              description={t('ask_admin_for_plan')}
            />
          ) : (
            connections.map((conn) => (
              <ConnectionCard
                key={conn.id}
                conn={conn}
                isActive={conn.id === activeConfigId}
                activeQuota={derivedQuota}
              />
            ))
          )}
        </Surface>

        {/* Accès rapides. « Historique » n'y figure plus : c'est un onglet
            permanent de la barre du bas, donc déjà à une seule touche depuis
            n'importe quel écran. Ne restent ici que les destinations qui n'ont
            pas d'onglet. */}
        <View style={[styles.quickRow, { gap: responsive.gap }]}>
          {[
            { icon: "gift-outline", label: t('activate_plan'), action: () => router.push("/plan"), color: colors.accents.violet },
            { icon: "headset-outline", label: t('support'), action: () => router.push("/support"), color: colors.accents.turquoise },
          ].map((item) => (
            <Pressable
              key={item.label}
              onPress={item.action}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              style={({ pressed }) => [
                styles.quickItem,
                {
                  minHeight: responsive.touchTarget + spacing['2xl'],
                  flexBasis: responsive.isLarge ? "23%" : "46%",
                },
                { borderColor: item.color + alpha.f24, backgroundColor: item.color + alpha.f08 },
                pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
              ]}
            >
              <View style={[styles.quickIcon, { backgroundColor: item.color + alpha.f16, borderColor: item.color + alpha.f24 }]}>
                <Ionicons name={item.icon as any} size={19} color={item.color} />
              </View>
              <Text style={[type.micro, { color: colors.textSecondary }]} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Mention développeur. Elle vivait au bas de la carte « Informations de
            connexion », retirée : elle reste donc ici, au pied de l'accueil, et
            reprend la forme employée partout ailleurs dans l'application
            (« Powered by AbakoDollar$ », traduite comme le reste). */}
        <Text style={[styles.signature, { color: colors.textMuted }]} accessibilityRole="text">
          {t('created_by')}
        </Text>
      </ScrollView>

      <UpdatePrompt />

      <ConfigPicker
        visible={configPickerVisible}
        onClose={() => setConfigPickerVisible(false)}
        configs={savedConfigs}
        activeConfigId={activeConfigId}
        activeQuota={derivedQuota}
        connections={connections}
        switching={isSwitchingConfig}
        onSelect={(id) => { setConfigPickerVisible(false); void switchConfig(id); }}
        onDelete={deleteConfig}
      />

    </LinearGradient>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: layout.screenPadding, gap: spacing.lg },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerActions: { flexDirection: "row", gap: spacing.sm },

  // ── Salut ──────────────────────────────────────────────────────────────────
  // Les styles `brandRow`/`brandMark`/`brandLogo` ont disparu avec la ligne
  // « logo + SXB VPN » qu'ils habillaient.
  greetingRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  // L'emoji suit la taille du salut plutôt que la sienne : posé à sa taille
  // naturelle, il dépassait la ligne et décalait le nom d'un pixel.
  greetingEmoji: { fontSize: 13, lineHeight: 17 },

  // ── Alerte de relais rompu ─────────────────────────────────────────────────
  relaisRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  relaisIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Quota ──────────────────────────────────────────────────────────────────
  // `flexWrap` plutôt qu'une largeur figée : sur un écran de 360 px avec une
  // police agrandie, la valeur et l'anneau passent l'un sous l'autre au lieu
  // de se chevaucher.
  quotaHero: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  quotaHeroText: { flex: 1, minWidth: 140, gap: spacing.xs },

  bannerRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.md },

  // ── Zone héros ─────────────────────────────────────────────────────────────
  // Le rythme vertical y est plus généreux qu'ailleurs : cet espace vide est ce
  // qui distingue une interface premium d'un empilement de composants.
  hero: {
    alignItems: "center",
    gap: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing['3xl'],
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    minWidth: 220,
    ...elevation.sm,
  },
  liveStrip: { width: "100%", paddingVertical: spacing.lg, paddingHorizontal: spacing.md },
  logsLink: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  logsButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    minHeight: 44,
  },

  // ── Profils ────────────────────────────────────────────────────────────────
  configCurrent: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  configIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },

  // ── Cartes de données ──────────────────────────────────────────────────────
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  speedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  speedItem: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  appRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
  },

  // Signature discrète de l'auteur, volontairement très effacée : présente
  // sans jamais concurrencer l'information utile de l'écran. La couleur est
  // appliquée à l'usage, comme partout ailleurs dans ce fichier (la feuille de
  // styles est définie hors du composant, où le thème n'est pas accessible).
  signature: {
    marginTop: spacing.md,
    textAlign: "center",
    fontSize: 9,
    letterSpacing: 1.2,
    opacity: 0.35,
  },

  // ── Accès rapides ──────────────────────────────────────────────────────────
  quickRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  quickItem: {
    flex: 1,
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  quickIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});

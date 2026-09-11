import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Localization from "expo-localization";
import { useAuthContext } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";
import {
  countryFlag, countryName, isCountryCode, normalizeCountryCode, sortedCountries, type Country,
} from "@/services/countries";
import { lireEmpreinteAppareil } from "@/services/deviceFingerprint";
import {
  cleErreurEssai, effacerDemandeLocale, ecrireDemandeLocale, INTERVALLE_VERIFICATION_MS,
  inscrireEssaiGratuit, intervalleVerificationMs, lireDemandeLocale, normaliserJetonEssai,
  verifierStatutEssai, type DemandeEssaiLocale, type FreeTrialStatus,
} from "@/services/freeTrial";

/**
 * Écran « ESSAI GRATUIT ».
 *
 * Trois états, et trois seulement :
 *  1. saisie   — jeton + nom + pays, tous les trois obligatoires ;
 *  2. attente  — « En attente de vérification », bouton « ↻ Vérifier le statut »
 *                et vérification automatique périodique ;
 *  3. approuvé — invitation à recharger l'application ; la configuration
 *                apparaît ensuite dans la section VPN normale.
 *
 * À aucun moment cet écran n'affiche de serveur, de quota, de dates ou de
 * configuration : ces informations n'existent pas dans les réponses tant que
 * l'administration n'a pas déployé l'accès, et une fois déployées elles sont
 * consommées par le flux d'activation habituel, pas par cet écran.
 *
 * LE PAYS EST SAISI, JAMAIS MESURÉ. L'écran ne demande aucune permission de
 * localisation et n'interroge aucun service d'adresses IP. La seule aide
 * apportée est le pays déjà déclaré dans les réglages du système, présélectionné
 * et modifiable d'un geste.
 */
export default function FreeTrialScreen() {
  const { t, language } = useTranslation();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { activateAccount, deviceId, hasSeenOnboarding } = useAuthContext();

  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [listePaysOuverte, setListePaysOuverte] = useState(false);
  const [recherchePays, setRecherchePays] = useState("");
  const [demande, setDemande] = useState<DemandeEssaiLocale | null>(null);
  const [statut, setStatut] = useState<FreeTrialStatus>("pending");
  const [messageServeur, setMessageServeur] = useState("");
  const [intervalleMs, setIntervalleMs] = useState(INTERVALLE_VERIFICATION_MS);
  const [chargement, setChargement] = useState(false);
  const [verification, setVerification] = useState(false);
  const [reprise, setReprise] = useState(true);
  const [erreur, setErreur] = useState("");
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const basculeEnCours = useRef(false);

  const pays = useMemo(() => sortedCountries(language), [language]);
  const paysFiltres = useMemo(() => {
    const requete = recherchePays.trim().toLocaleLowerCase(language);
    if (!requete) return pays;
    return pays.filter((entree) =>
      entree[language].toLocaleLowerCase(language).includes(requete) ||
      entree.code.toLowerCase().includes(requete));
  }, [pays, recherchePays, language]);
  const nomPaysChoisi = countryName(country, language);

  const shake = () => Animated.sequence([
    Animated.timing(shakeAnim, { toValue: 10, duration: 55, useNativeDriver: true }),
    Animated.timing(shakeAnim, { toValue: -10, duration: 55, useNativeDriver: true }),
    Animated.timing(shakeAnim, { toValue: 5, duration: 55, useNativeDriver: true }),
    Animated.timing(shakeAnim, { toValue: 0, duration: 55, useNativeDriver: true }),
  ]).start();

  // Reprise : si une demande existe déjà sur cet appareil, l'utilisateur ne doit
  // PAS ressaisir son jeton. On repart directement de l'écran d'attente.
  useEffect(() => {
    let actif = true;
    void lireDemandeLocale().then((locale) => {
      if (!actif) return;
      if (locale) {
        setDemande(locale);
        setStatut(locale.status);
      }
      setReprise(false);
    });
    return () => { actif = false; };
  }, []);

  // Présélection du pays à partir de la RÉGION DÉCLARÉE dans les réglages du
  // système. C'est une lecture locale, sans permission et sans réseau : rien
  // n'est mesuré, rien n'est envoyé, et l'utilisateur peut changer le choix.
  useEffect(() => {
    if (country) return;
    try {
      const region = normalizeCountryCode(Localization.getLocales()[0]?.regionCode);
      if (isCountryCode(region)) setCountry(region);
    } catch {
      // Réglages illisibles : l'utilisateur choisira lui-même, ce qui reste la
      // source de vérité de toute façon.
    }
  }, [country]);

  /**
   * Bascule vers l'accès réel.
   *
   * Le jeton d'essai ne sert à rien ici : c'est le jeton de compte émis lors du
   * déploiement, renvoyé au seul appareil autorisé, qui ouvre la session.
   */
  const basculerVersAcces = useCallback(async (accountToken: string) => {
    if (basculeEnCours.current) return;
    basculeEnCours.current = true;
    try {
      await activateAccount(accountToken);
      await effacerDemandeLocale();
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace((hasSeenOnboarding ? "/(tabs)/" : "/onboarding") as any);
    } catch {
      // L'accès existe mais la session n'a pas pu s'ouvrir (réseau, par
      // exemple). On reste sur l'écran « approuvé » : l'utilisateur peut
      // relancer la vérification, rien n'est perdu.
      basculeEnCours.current = false;
    }
  }, [activateAccount, hasSeenOnboarding]);

  const verifierStatut = useCallback(async (courante: DemandeEssaiLocale, silencieux: boolean) => {
    if (!silencieux) setVerification(true);
    try {
      const reponse = await verifierStatutEssai({
        requestId: courante.requestId,
        claimSecret: courante.claimSecret,
        deviceId,
      });
      setStatut(reponse.status);
      setMessageServeur(reponse.message ?? "");
      setIntervalleMs(intervalleVerificationMs(reponse.pollIntervalSeconds));
      if (reponse.status === "deployed" && reponse.accountToken) {
        await basculerVersAcces(reponse.accountToken);
      }
      if (!silencieux) setErreur("");
    } catch (err) {
      // Une vérification silencieuse qui échoue reste invisible : c'est le cas
      // normal hors connexion, ce n'est pas une erreur utilisateur.
      if (!silencieux) setErreur(t(cleErreurEssai(err)));
    } finally {
      if (!silencieux) setVerification(false);
    }
  }, [basculerVersAcces, deviceId, t]);

  // Vérification automatique périodique, uniquement tant que la demande est en
  // attente. Une demande déployée ou refusée n'a plus rien à interroger.
  useEffect(() => {
    if (!demande || statut !== "pending") return;
    const minuterie = setInterval(() => { void verifierStatut(demande, true); }, intervalleMs);
    return () => clearInterval(minuterie);
  }, [demande, statut, intervalleMs, verifierStatut]);

  const soumettre = async () => {
    const jeton = normaliserJetonEssai(token);
    const nom = name.trim();
    const codePays = normalizeCountryCode(country);
    if (!jeton) {
      setErreur(t("free_trial_error_token"));
      shake();
      return;
    }
    if (nom.length < 2) {
      setErreur(t("free_trial_error_name"));
      shake();
      return;
    }
    // Le pays est obligatoire au même titre que le nom : sans lui, impossible
    // de savoir d'où viennent les inscrits, ce qui est justement la raison
    // d'être du champ.
    if (!isCountryCode(codePays)) {
      setErreur(t("free_trial_error_country"));
      shake();
      return;
    }
    setErreur("");
    setChargement(true);
    try {
      // L'empreinte est lue AU MOMENT de l'envoi, jamais conservée : elle
      // traverse cette fonction et la requête, rien de plus.
      const deviceFingerprint = await lireEmpreinteAppareil();
      const reponse = await inscrireEssaiGratuit({
        token: jeton, name: nom, country: codePays, deviceId, deviceFingerprint,
      });
      const locale: DemandeEssaiLocale = {
        requestId: reponse.requestId,
        claimSecret: reponse.claimSecret,
        name: reponse.name,
        country: reponse.country ?? codePays,
        submittedAt: reponse.submittedAt,
        status: reponse.status,
      };
      await ecrireDemandeLocale(locale);
      setDemande(locale);
      setStatut(reponse.status);
      setMessageServeur(reponse.message ?? "");
      setIntervalleMs(intervalleVerificationMs(reponse.pollIntervalSeconds));
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      if (Platform.OS !== "web") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      shake();
      setErreur(t(cleErreurEssai(err)));
    } finally {
      setChargement(false);
    }
  };

  const choisirPays = (code: string) => {
    setCountry(code);
    setListePaysOuverte(false);
    setRecherchePays("");
    setErreur("");
  };

  const recommencer = async () => {
    await effacerDemandeLocale();
    setDemande(null);
    setStatut("pending");
    setMessageServeur("");
    setToken("");
    setErreur("");
  };

  const barreHaute = (
    <View style={styles.topBar}>
      <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]} accessibilityLabel={t("back")}>
        <Ionicons name="arrow-back" size={20} color={colors.textSecondary} />
      </Pressable>
      <Text style={styles.topBarLabel}>{t("free_trial_badge")}</Text>
      <View style={styles.iconButtonPlaceholder} />
    </View>
  );

  if (reprise) {
    return (
      <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </LinearGradient>
    );
  }

  // ── État 2 et 3 : la demande existe, on n'affiche plus jamais le formulaire ──
  if (demande) {
    const approuve = statut === "deployed";
    const refuse = statut === "rejected";
    return (
      <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 28 }]}
          showsVerticalScrollIndicator={false}
        >
          {barreHaute}

          <View style={styles.statusCard}>
            <View style={[styles.statusOrb, approuve && { backgroundColor: colors.primaryDim }]}>
              <Ionicons
                name={approuve ? "shield-checkmark" : refuse ? "close-circle-outline" : "time-outline"}
                size={44}
                color={approuve ? colors.connected : refuse ? colors.disconnected : colors.primary}
              />
            </View>
            <Text style={styles.statusTitle}>
              {approuve ? t("free_trial_approved_title") : refuse ? t("free_trial_rejected_title") : t("free_trial_pending_title")}
            </Text>
            <Text style={styles.statusSub}>
              {approuve ? t("free_trial_approved_desc") : refuse ? t("free_trial_rejected_desc") : t("free_trial_pending_desc")}
            </Text>
            {messageServeur ? <Text style={styles.statusServer}>{messageServeur}</Text> : null}

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{t("free_trial_name_label")}</Text>
              <Text style={styles.summaryValue} numberOfLines={1}>{demande.name}</Text>
            </View>
            {countryName(demande.country, language) ? (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t("free_trial_country_label")}</Text>
                <Text style={styles.summaryValue} numberOfLines={1}>
                  {`${countryFlag(demande.country)}  ${countryName(demande.country, language)}`}
                </Text>
              </View>
            ) : null}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{t("device_id")}</Text>
              <Text style={styles.summaryValue} numberOfLines={1} ellipsizeMode="middle">{deviceId}</Text>
            </View>

            {erreur ? (
              <View style={styles.errorWrap}>
                <Ionicons name="alert-circle" size={16} color={colors.disconnected} />
                <Text style={styles.errorText}>{erreur}</Text>
              </View>
            ) : null}

            {!refuse ? (
              <Pressable
                onPress={() => { void verifierStatut(demande, false); }}
                disabled={verification}
                style={({ pressed }) => [styles.primaryButton, verification && styles.disabled, pressed && !verification && styles.pressedLarge]}
              >
                <LinearGradient colors={colors.gradients.primary as [string, string]} style={styles.primaryButtonInner}>
                  <Ionicons name="refresh" size={19} color={colors.primaryForeground} />
                  <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                    {verification ? t("free_trial_checking") : t("free_trial_check_status")}
                  </Text>
                </LinearGradient>
              </Pressable>
            ) : null}

            <Pressable onPress={() => { void recommencer(); }} style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}>
              <Text style={styles.ghostButtonText}>{t("free_trial_restart")}</Text>
            </Pressable>

            {!approuve && !refuse ? (
              <Text style={styles.secureHint}>{t("free_trial_auto_check")}</Text>
            ) : null}
          </View>

          <Text style={styles.footer}>{t("free_trial_no_config_notice")}</Text>
        </ScrollView>
      </LinearGradient>
    );
  }

  // ── État 1 : saisie du jeton et du nom ──────────────────────────────────────
  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.container}>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 28 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {barreHaute}

          <View style={styles.brandBlock}>
            <View style={styles.logoHalo}>
              <Ionicons name="gift-outline" size={38} color={colors.primary} />
            </View>
            <Text style={styles.eyebrow}>{t("free_trial_badge")}</Text>
            <Text style={styles.title}>{t("free_trial_title")}</Text>
            <Text style={styles.subtitle}>{t("free_trial_subtitle")}</Text>
          </View>

          <View style={styles.formCard}>
            <View style={styles.formHeader}>
              <View style={styles.formIcon}><Ionicons name="ticket-outline" size={19} color={colors.primary} /></View>
              <View style={styles.formHeaderCopy}>
                <Text style={styles.formTitle}>{t("free_trial_form_title")}</Text>
                <Text style={styles.formHint}>{t("free_trial_form_hint")}</Text>
              </View>
            </View>

            <Animated.View style={{ transform: [{ translateX: shakeAnim }] }}>
              <Text style={styles.fieldLabel}>{t("free_trial_token_label")}</Text>
              <View style={[styles.inputRow, !!erreur && { borderColor: colors.disconnected }]}>
                <Ionicons name="key-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder={t("free_trial_token_placeholder")}
                  placeholderTextColor={colors.textMuted}
                  value={token}
                  onChangeText={(valeur) => { setToken(valeur.toUpperCase()); setErreur(""); }}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="next"
                  accessibilityLabel={t("free_trial_token_label")}
                />
              </View>

              <Text style={styles.fieldLabel}>{t("free_trial_name_label")}</Text>
              <View style={[styles.inputRow, !!erreur && { borderColor: colors.disconnected }]}>
                <Ionicons name="person-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder={t("free_trial_name_placeholder")}
                  placeholderTextColor={colors.textMuted}
                  value={name}
                  onChangeText={(valeur) => { setName(valeur); setErreur(""); }}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={soumettre}
                  accessibilityLabel={t("free_trial_name_label")}
                />
              </View>

              {/* Pays : sélecteur, jamais un champ libre. Une liste fermée est
                  la seule façon d'obtenir des statistiques exploitables. */}
              <Text style={styles.fieldLabel}>{t("free_trial_country_label")}</Text>
              <Pressable
                onPress={() => { setListePaysOuverte(true); setErreur(""); }}
                accessibilityRole="button"
                accessibilityLabel={t("free_trial_country_label")}
                style={({ pressed }) => [
                  styles.inputRow,
                  !!erreur && { borderColor: colors.disconnected },
                  pressed && styles.pressed,
                ]}
              >
                <Ionicons name="globe-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
                <Text style={[styles.selectValue, !nomPaysChoisi && styles.selectPlaceholder]} numberOfLines={1}>
                  {nomPaysChoisi ? `${countryFlag(country)}  ${nomPaysChoisi}` : t("free_trial_country_placeholder")}
                </Text>
                <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
              </Pressable>
            </Animated.View>

            {erreur ? (
              <View style={styles.errorWrap}>
                <Ionicons name="alert-circle" size={16} color={colors.disconnected} />
                <Text style={styles.errorText}>{erreur}</Text>
              </View>
            ) : (
              <Text style={styles.secureHint}>{t("free_trial_name_required")}</Text>
            )}

            <Pressable
              onPress={soumettre}
              disabled={chargement}
              style={({ pressed }) => [styles.primaryButton, chargement && styles.disabled, pressed && !chargement && styles.pressedLarge]}
            >
              <LinearGradient colors={colors.gradients.primary as [string, string]} style={styles.primaryButtonInner}>
                <Ionicons name={chargement ? "sync" : "shield-checkmark"} size={19} color={colors.primaryForeground} />
                <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                  {chargement ? t("free_trial_submitting") : t("free_trial_submit")}
                </Text>
              </LinearGradient>
            </Pressable>
          </View>

          {deviceId ? (
            <View style={styles.deviceCard}>
              <View style={styles.deviceIcon}><Ionicons name="phone-portrait-outline" size={18} color={colors.primary} /></View>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceLabel}>{t("device_id")}</Text>
                <Text style={styles.deviceValue} numberOfLines={1} ellipsizeMode="middle">{deviceId}</Text>
              </View>
            </View>
          ) : null}

          {/* Bandeau de réassurance : trois promesses, trois colonnes. */}
          <View style={styles.assuranceBar}>
            <View style={styles.assuranceCell}>
              <Ionicons name="shield-checkmark-outline" size={20} color={colors.primary} />
              <Text style={styles.assuranceTitle}>{t("free_trial_assurance_secure_title")}</Text>
              <Text style={styles.assuranceDesc}>{t("free_trial_assurance_secure_desc")}</Text>
            </View>
            <View style={styles.assuranceDivider} />
            <View style={styles.assuranceCell}>
              <Ionicons name="flash-outline" size={20} color={colors.primary} />
              <Text style={styles.assuranceTitle}>{t("free_trial_assurance_fast_title")}</Text>
              <Text style={styles.assuranceDesc}>{t("free_trial_assurance_fast_desc")}</Text>
            </View>
            <View style={styles.assuranceDivider} />
            <View style={styles.assuranceCell}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.primary} />
              <Text style={styles.assuranceTitle}>{t("free_trial_assurance_free_title")}</Text>
              <Text style={styles.assuranceDesc}>{t("free_trial_assurance_free_desc")}</Text>
            </View>
          </View>

          {/* Promesse de sécurité explicite du propriétaire : elle reste
              visible sur l'écran de saisie ET sur l'écran d'attente. */}
          <Text style={styles.footer}>{t("free_trial_no_config_notice")}</Text>
          <Text style={styles.footer}>{t("activate_footer")}</Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={listePaysOuverte}
        animationType="slide"
        transparent
        onRequestClose={() => setListePaysOuverte(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + 12, marginTop: insets.top + 60 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("free_trial_country_label")}</Text>
              <Pressable
                onPress={() => setListePaysOuverte(false)}
                accessibilityLabel={t("free_trial_country_close")}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
              >
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.inputRow}>
              <Ionicons name="search-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={t("free_trial_country_search")}
                placeholderTextColor={colors.textMuted}
                value={recherchePays}
                onChangeText={setRecherchePays}
                autoCorrect={false}
                accessibilityLabel={t("free_trial_country_search")}
              />
            </View>
            <FlatList
              data={paysFiltres}
              keyExtractor={(entree: Country) => entree.code}
              keyboardShouldPersistTaps="handled"
              style={styles.modalList}
              ListEmptyComponent={<Text style={styles.secureHint}>{t("free_trial_country_none")}</Text>}
              renderItem={({ item }: { item: Country }) => (
                <Pressable
                  onPress={() => choisirPays(item.code)}
                  style={({ pressed }) => [styles.countryRow, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel={item[language]}
                >
                  <Text style={styles.countryFlag}>{countryFlag(item.code)}</Text>
                  <Text style={styles.countryName} numberOfLines={1}>{item[language]}</Text>
                  <Text style={styles.countryCode}>{item.code}</Text>
                  {item.code === country ? (
                    <Ionicons name="checkmark" size={18} color={colors.primary} />
                  ) : null}
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </LinearGradient>
  );
}

function makeStyles(colors: ReturnType<typeof import("@/hooks/useColors").useColors>) {
  return StyleSheet.create({
    container: { flex: 1 },
    centered: { flex: 1, alignItems: "center", justifyContent: "center" },
    content: { paddingHorizontal: 20, gap: 16 },
    topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    topBarLabel: { color: colors.textMuted, fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 1.4 },
    iconButton: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.bgCard + "D9", borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
    iconButtonPlaceholder: { width: 40 },
    pressed: { opacity: 0.68, transform: [{ scale: 0.97 }] },
    pressedLarge: { transform: [{ scale: 0.985 }] },
    brandBlock: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
    logoHalo: { width: 82, height: 82, borderRadius: 28, backgroundColor: colors.primaryDim, borderWidth: 1, borderColor: colors.primary + "45", alignItems: "center", justifyContent: "center", marginBottom: 18 },
    eyebrow: { color: colors.primary, fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1.8, marginBottom: 8 },
    title: { color: colors.textPrimary, fontSize: 26, lineHeight: 32, fontFamily: "Inter_700Bold", textAlign: "center" },
    subtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8, maxWidth: 340 },
    formCard: { backgroundColor: colors.bgCard + "F2", borderWidth: 1, borderColor: colors.border, borderRadius: 24, padding: 18, gap: 14 },
    formHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
    formIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" },
    formHeaderCopy: { flex: 1, gap: 2 },
    formTitle: { color: colors.textPrimary, fontSize: 15, fontFamily: "Inter_700Bold" },
    formHint: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular" },
    // Le champ vit désormais DANS une ligne à icône : la bordure et le fond
    // appartiennent à la ligne, le champ ne porte plus que le texte.
    input: { flex: 1, paddingVertical: 16, color: colors.textPrimary, fontSize: 14, fontFamily: "Inter_600SemiBold", letterSpacing: 0.4 },
    fieldLabel: { color: colors.textSecondary, fontSize: 12, fontFamily: "Inter_600SemiBold", marginTop: 12, marginBottom: 7 },
    inputRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.bgInput, borderWidth: 1, borderColor: colors.border2, borderRadius: 15, paddingHorizontal: 14 },
    inputIcon: { width: 20, textAlign: "center" },
    selectValue: { flex: 1, color: colors.textPrimary, fontSize: 14, fontFamily: "Inter_600SemiBold", paddingVertical: 16 },
    selectPlaceholder: { color: colors.textMuted, fontFamily: "Inter_400Regular" },
    assuranceBar: { flexDirection: "row", alignItems: "flex-start", backgroundColor: colors.bgCard + "D9", borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingVertical: 16, paddingHorizontal: 8 },
    assuranceCell: { flex: 1, alignItems: "center", gap: 6, paddingHorizontal: 6 },
    assuranceDivider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
    assuranceTitle: { color: colors.textPrimary, fontSize: 12, fontFamily: "Inter_700Bold", textAlign: "center" },
    assuranceDesc: { color: colors.textMuted, fontSize: 10, lineHeight: 14, fontFamily: "Inter_400Regular", textAlign: "center" },
    modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.62)", justifyContent: "flex-end" },
    modalCard: { flex: 1, backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 18, paddingTop: 16, gap: 12 },
    modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    modalTitle: { color: colors.textPrimary, fontSize: 17, fontFamily: "Inter_700Bold" },
    modalList: { flex: 1 },
    countryRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: colors.border },
    countryFlag: { fontSize: 20 },
    countryName: { flex: 1, color: colors.textPrimary, fontSize: 14, fontFamily: "Inter_500Medium" },
    countryCode: { color: colors.textMuted, fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 1 },
    errorWrap: { flexDirection: "row", alignItems: "center", gap: 7 },
    errorText: { color: colors.disconnected, fontSize: 12, flex: 1, fontFamily: "Inter_500Medium" },
    secureHint: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_400Regular", textAlign: "center" },
    primaryButton: { borderRadius: 16, overflow: "hidden" },
    primaryButtonInner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, paddingVertical: 16 },
    primaryButtonText: { fontSize: 15, fontFamily: "Inter_700Bold" },
    ghostButton: { alignItems: "center", paddingVertical: 12 },
    ghostButtonText: { color: colors.textMuted, fontSize: 12, fontFamily: "Inter_500Medium" },
    disabled: { opacity: 0.6 },
    statusCard: { backgroundColor: colors.bgCard + "F2", borderWidth: 1, borderColor: colors.border, borderRadius: 24, padding: 22, gap: 12, alignItems: "center" },
    statusOrb: { width: 92, height: 92, borderRadius: 32, backgroundColor: colors.bgInput, alignItems: "center", justifyContent: "center", marginBottom: 6 },
    statusTitle: { color: colors.textPrimary, fontSize: 20, lineHeight: 26, fontFamily: "Inter_700Bold", textAlign: "center" },
    statusSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 20, fontFamily: "Inter_400Regular", textAlign: "center" },
    statusServer: { color: colors.primary, fontSize: 12, fontFamily: "Inter_500Medium", textAlign: "center" },
    summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", alignSelf: "stretch", gap: 12, paddingTop: 6 },
    summaryLabel: { color: colors.textMuted, fontSize: 11, fontFamily: "Inter_500Medium" },
    summaryValue: { color: colors.textPrimary, fontSize: 12, fontFamily: "Inter_600SemiBold", flex: 1, textAlign: "right" },
    deviceCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.bgCard + "D9", borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: 14 },
    deviceIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: colors.primaryDim, alignItems: "center", justifyContent: "center" },
    deviceCopy: { flex: 1, gap: 2 },
    deviceLabel: { color: colors.textMuted, fontSize: 10, fontFamily: "Inter_500Medium", letterSpacing: 1 },
    deviceValue: { color: colors.textPrimary, fontSize: 12, fontFamily: "Inter_600SemiBold" },
    footer: { color: colors.textMuted, fontSize: 11, lineHeight: 17, fontFamily: "Inter_400Regular", textAlign: "center" },
  });
}

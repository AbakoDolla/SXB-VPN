import React, { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useResponsive } from "@/hooks/useResponsive";
import { useTranslation } from "@/localization";
import { useVpnContext, type StepLogItem } from "@/contexts/VpnContext";
import { chronometrer } from "@/services/journalChronologie";
import { retenue, type Niveau, type Source } from "@/services/journalFiltres";
import { alpha, radius, responsiveLayout, spacing, type } from "@/constants/theme";
import { EmptyState, ScreenHeader } from "@/components/ui/Primitives";

/**
 * Journal d'activité — ce que l'application fait, en clair.
 *
 * CE QU'IL MONTRE : des phrases. « Vérification du quota… », « Négociation
 * sécurisée… », « Tunnel sécurisé prêt ». Rien d'autre.
 *
 * CE QU'IL NE PEUT PAS MONTRER, par construction et non par filtrage : les
 * adresses de serveur, les configurations, les identifiants, la sortie brute du
 * moteur. Cet écran ne lit QUE `stepLogs`, dont chaque entrée est une CLÉ de
 * traduction choisie dans le code — jamais une chaîne venue du réseau, du
 * moteur ou d'une configuration. Une fuite exigerait qu'on invente une clé
 * contenant un secret, ce qu'aucune donnée extérieure ne peut faire.
 *
 * Le champ `detail` des étapes, lui, peut porter un code de diagnostic. Il
 * n'est affiché que s'il ressemble à un code — majuscules, chiffres et tirets
 * bas — et jamais tel quel : un texte libre y serait ignoré plutôt que rendu.
 */

/** Un code de diagnostic, et rien d'autre : `PVN_NETWORK`, `ERR_TIMEOUT`. */
const CODE_SUR = /^[A-Z][A-Z0-9_]{2,31}$/;

function detailAffichable(detail: string | undefined): string | null {
  if (!detail) return null;
  return CODE_SUR.test(detail) ? detail : null;
}

/**
 * Un choix parmi quelques-uns, sur une seule ligne.
 *
 * Les libellés sont traduits par l'appelant : ce composant ne connaît que des
 * textes déjà prêts, jamais une clé ni une valeur venue d'ailleurs.
 */
function Choix<T extends string>({ valeurs, actif, surChoix, legende }: {
  valeurs: Array<{ id: T; libelle: string }>;
  actif: T;
  surChoix: (id: T) => void;
  legende: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.rangeeFiltre}>
      <Text style={[type.micro, { color: colors.textMuted, width: 58 }]}>{legende}</Text>
      <View style={styles.choix}>
        {valeurs.map(({ id, libelle }) => {
          const choisi = id === actif;
          return (
            <Pressable
              key={id}
              onPress={() => surChoix(id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: choisi }}
              accessibilityLabel={`${legende} : ${libelle}`}
              hitSlop={8}
              style={({ pressed }) => [
                styles.puce,
                choisi
                  ? { backgroundColor: colors.primaryDim, borderColor: colors.primary + alpha.f24 }
                  : { backgroundColor: colors.bgInput, borderColor: colors.border2 },
                pressed && styles.presse,
              ]}
            >
              <Text style={[type.micro, { color: choisi ? colors.primary : colors.textSecondary }]}>{libelle}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Une action de la barre : icône, mot, surface tactile pleine. */
function Action({ icone, libelle, surAppui, teinte }: {
  icone: string;
  libelle: string;
  surAppui: () => void;
  teinte?: string;
}) {
  const colors = useColors();
  const couleur = teinte ?? colors.textSecondary;
  return (
    <Pressable
      onPress={surAppui}
      accessibilityRole="button"
      accessibilityLabel={libelle}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: colors.bgCard, borderColor: colors.border },
        pressed && styles.presse,
      ]}
    >
      <Ionicons name={icone as any} size={15} color={couleur} />
      <Text style={[type.captionMedium, { color: couleur }]} numberOfLines={1}>{libelle}</Text>
    </Pressable>
  );
}

function apparence(statut: StepLogItem["status"], colors: ReturnType<typeof useColors>) {
  switch (statut) {
    case "done":    return { icon: "checkmark-circle", color: colors.connected };
    case "error":   return { icon: "close-circle", color: colors.disconnected };
    case "warning": return { icon: "alert-circle", color: colors.accents.ambre ?? colors.textSecondary };
    case "active":  return { icon: "ellipse", color: colors.primary };
    default:        return { icon: "ellipse-outline", color: colors.textMuted };
  }
}

function LigneEtape({ item, dernier, duree, heure, lent }: {
  item: StepLogItem;
  dernier: boolean;
  /** Temps passé DANS cette étape — la colonne qui désigne le goulot. */
  duree: string | null;
  heure: string | null;
  /** L'étape a coûté assez pour expliquer l'attente : elle doit sauter aux yeux. */
  lent: boolean;
}) {
  const colors = useColors();
  const { t } = useTranslation();
  const style = apparence(item.status, colors);
  const code = detailAffichable(item.detail);

  return (
    <View style={styles.ligne}>
      <View style={styles.frise}>
        <View style={[styles.pastille, { backgroundColor: style.color + alpha.f12, borderColor: style.color + alpha.f24 }]}>
          <Ionicons name={style.icon as any} size={15} color={style.color} />
        </View>
        {!dernier && <View style={[styles.trait, { backgroundColor: colors.border }]} />}
      </View>

      <View style={[styles.carte, { backgroundColor: colors.bgCard, borderColor: style.color + alpha.f24 }]}>
        <Text style={[type.bodyMedium, { color: colors.textPrimary }]}>{t(item.translationKey as any)}</Text>
        <View style={styles.meta}>
          {item.timestamp ? (
            <Text style={[type.micro, { color: colors.textMuted }]}>{heure}</Text>
          ) : null}
          {duree ? (
            <View
              style={[
                styles.codePill,
                lent
                  ? { backgroundColor: colors.warningDim, borderColor: colors.warning + alpha.f24 }
                  : { backgroundColor: colors.bgInput, borderColor: colors.border2 },
              ]}
            >
              {lent ? <Ionicons name="hourglass-outline" size={11} color={colors.warning} /> : null}
              <Text style={[type.micro, { color: lent ? colors.warning : colors.textSecondary }]}>{duree}</Text>
            </View>
          ) : null}
          {/* Faits rapportés par le MOTEUR : « HTTP/1.1 200 », « TLSv1.3 ».
              C'est ce détail qui dit où une connexion casse. Il est teinté
              différemment du reste pour qu'on distingue d'un coup d'œil ce que
              l'application a fait de ce que le serveur a répondu. */}
          {(item.technique ?? []).map((valeur) => (
            <View
              key={valeur}
              style={[styles.codePill, { backgroundColor: colors.primaryDim, borderColor: colors.primary + alpha.f24 }]}
            >
              <Text style={[type.micro, { color: colors.primary }]}>{valeur}</Text>
            </View>
          ))}
          {code ? (
            <View style={[styles.codePill, { backgroundColor: colors.bgInput, borderColor: colors.border2 }]}>
              <Text style={[type.micro, { color: colors.textSecondary }]}>{code}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export default function JournalScreen() {
  const colors = useColors();
  const responsive = useResponsive();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { stepLogs, resetStepLogs } = useVpnContext();

  /**
   * Filtres du journal.
   *
   * `niveau` répond à « qu'est-ce qui a cassé ? » ; `source` répond à « est-ce
   * l'application ou le moteur ? ». Le tri lui-même vit dans `journalFiltres`,
   * pour pouvoir être mis à l'épreuve sans lancer l'application.
   */
  const [niveau, setNiveau] = useState<Niveau>("tout");
  const [source, setSource] = useState<Source>("tout");

  // Le plus récent en haut : c'est ce qu'on vient chercher quand une connexion
  // ne part pas. `chronometrer` donne à chaque étape le temps qu'elle a coûté.
  const toutes = useMemo(() => chronometrer([...stepLogs].reverse()), [stepLogs]);

  /**
   * Chronologie figée pendant qu'on la lit.
   *
   * Pendant une connexion, les étapes s'inscrivent sans prévenir : la ligne
   * qu'on examinait glisse sous le doigt. Geler garde une copie de l'instant
   * choisi — le moteur, lui, continue son travail sans rien savoir de cet
   * écran.
   */
  const [gelee, setGelee] = useState<typeof toutes | null>(null);
  const fige = gelee !== null;

  const etapes = useMemo(
    () => (gelee ?? toutes).filter(({ etape }) => retenue(etape, niveau, source)),
    [gelee, toutes, niveau, source],
  );

  /** Nombre d'étapes écartées par les filtres — jamais un chiffre inventé. */
  const masquees = (gelee ?? toutes).length - etapes.length;

  /**
   * Met le journal AFFICHÉ dans le presse-papiers du système de partage.
   *
   * Reconstruit depuis les mêmes clés de traduction que l'écran : le texte
   * partagé ne peut donc contenir ni plus ni autre chose que ce que
   * l'utilisateur voit. Aucune adresse, aucune configuration, aucun secret —
   * la garantie tient par construction, pas par vigilance.
   *
   * Il suit les filtres : partager « les problèmes » n'envoie que ceux-là,
   * ce qui évite de noyer le destinataire sous une chronologie entière.
   */
  const partager = useCallback(async () => {
    // Remis dans l'ordre chronologique : une chronologie se lit du début.
    const lignes = [...etapes].reverse().map(({ etape, duree, heure }) =>
      [heure, t(etape.translationKey as any), ...(etape.technique ?? []), duree, detailAffichable(etape.detail)]
        .filter(Boolean)
        .join('  '),
    );
    try {
      await Share.share({ message: [t("journal_title"), ...lignes].join('\n') });
    } catch {
      // Un partage refusé ou annulé n'est pas une erreur à signaler.
    }
  }, [etapes, t]);

  const basculerGel = useCallback(() => {
    setGelee((precedent) => (precedent === null ? toutes : null));
  }, [toutes]);

  /**
   * Efface la chronologie, après confirmation.
   *
   * Un journal effacé ne se récupère pas, et c'est précisément la trace qu'on
   * cherchait quand la connexion a échoué. La connexion en cours, elle, n'est
   * pas touchée : seul l'affichage repart de zéro.
   */
  const effacer = useCallback(() => {
    Alert.alert(t("journal_clear"), t("journal_clear_confirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("journal_clear"),
        style: "destructive",
        onPress: () => {
          setGelee(null);
          resetStepLogs();
        },
      },
    ]);
  }, [resetStepLogs, t]);

  return (
    <LinearGradient colors={colors.gradients.bg as [string, string, string]} style={styles.fond}>
      <ScrollView
        contentContainerStyle={[
          styles.contenu,
          { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing["3xl"], paddingHorizontal: responsive.screenPadding },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.entete}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [styles.retour, { backgroundColor: colors.bgCard, borderColor: colors.border }, pressed && styles.presse]}
            accessibilityLabel={t("back")}
            accessibilityRole="button"
          >
            <Ionicons name="arrow-back" size={20} color={colors.textSecondary} />
          </Pressable>
          <ScreenHeader
            title={t("journal_title")}
            eyebrow={t("journal_subtitle")}
            icon="list-outline"
            tone={colors.primary}
            paddingTop={0}
          />
        </View>

        <View style={[styles.note, { backgroundColor: colors.primaryDim, borderColor: colors.primary + alpha.f24 }]}>
          <Ionicons name="lock-closed-outline" size={15} color={colors.primary} />
          <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>{t("journal_privacy_note")}</Text>
        </View>

        {/* Barre de contrôle.
            Le journal s'écrit pendant qu'on le lit : sans gel, la ligne
            qu'on examine glisse sous le doigt. Sans filtre, il faut faire
            défiler quarante étapes pour retrouver le seul échec. */}
        {toutes.length > 0 ? (
          <View style={[styles.barre, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
            <Choix
              legende={t("journal_filter_level")}
              actif={niveau}
              surChoix={setNiveau}
              valeurs={[
                { id: "tout", libelle: t("journal_filter_all") },
                { id: "probleme", libelle: t("journal_filter_problems") },
                { id: "reussite", libelle: t("journal_filter_success") },
              ]}
            />
            <Choix
              legende={t("journal_filter_source")}
              actif={source}
              surChoix={setSource}
              valeurs={[
                { id: "tout", libelle: t("journal_filter_all") },
                { id: "application", libelle: t("journal_filter_app") },
                { id: "moteur", libelle: t("journal_filter_engine") },
              ]}
            />
            <View style={styles.actions}>
              <Action
                icone={fige ? "play-outline" : "pause-outline"}
                libelle={fige ? t("journal_resume") : t("journal_pause")}
                surAppui={basculerGel}
                teinte={fige ? colors.warning : undefined}
              />
              {etapes.length > 0 ? (
                <Action icone="share-outline" libelle={t("journal_share")} surAppui={() => void partager()} />
              ) : null}
              <Action icone="trash-outline" libelle={t("journal_clear")} surAppui={effacer} />
            </View>
            {fige ? (
              <Text style={[type.micro, { color: colors.warning }]}>{t("journal_paused_note")}</Text>
            ) : null}
          </View>
        ) : null}

        {toutes.length === 0 ? (
          <EmptyState icon="list-outline" title={t("journal_empty_title")} description={t("journal_empty_subtitle")} />
        ) : etapes.length === 0 ? (
          // Un journal vide et un filtre trop étroit ne se disent pas de la
          // même façon : l'un demande de patienter, l'autre de relâcher le
          // filtre. Les confondre enverrait l'utilisateur chercher une panne
          // qui n'existe pas.
          <EmptyState
            icon="funnel-outline"
            title={t("journal_filtered_title")}
            description={t("journal_filtered_subtitle")}
          />
        ) : (
          <View style={styles.liste}>
            {etapes.map(({ etape, duree, heure, lent }, index) => (
              <LigneEtape
                key={`${etape.key}-${index}`}
                item={etape}
                dernier={index === etapes.length - 1}
                duree={duree}
                heure={heure}
                lent={lent}
              />
            ))}
            {masquees > 0 ? (
              <Text style={[type.micro, { color: colors.textMuted, paddingLeft: 30 + spacing.md }]}>
                {t("journal_hidden_count").replace("{n}", String(masquees))}
              </Text>
            ) : null}
          </View>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fond: { flex: 1 },
  contenu: { gap: spacing.lg, width: "100%", maxWidth: responsiveLayout.contentMaxWidth, alignSelf: "center" },
  entete: { gap: spacing.md },
  retour: { width: 44, height: 44, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  presse: { opacity: 0.68, transform: [{ scale: 0.97 }] },
  note: { flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  barre: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  rangeeFiltre: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  choix: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, flex: 1 },
  puce: {
    minHeight: 32,
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actions: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs },
  action: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
  },
  liste: { gap: spacing.xs },
  ligne: { flexDirection: "row", gap: spacing.md },
  frise: { alignItems: "center", width: 30 },
  pastille: { width: 30, height: 30, borderRadius: radius.full, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  trait: { width: 2, flex: 1, marginTop: spacing.xs, borderRadius: radius.full },
  carte: { flex: 1, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.xs },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  codePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
});

import React, { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useColors } from "@/hooks/useColors";
import { useResponsive } from "@/hooks/useResponsive";
import { useTranslation } from "@/localization";
import { useVpnContext, type StepLogItem } from "@/contexts/VpnContext";
import { chronometrer } from "@/services/journalChronologie";
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
 * Les quatre lectures du journal.
 *
 * « Problèmes » d'abord, parce que c'est la raison pour laquelle on ouvre cet
 * écran. La séparation « Moteur » / « Application » n'est pas décorative : elle
 * répond à la seule question qui compte quand rien ne marche — est-ce nous, ou
 * est-ce le serveur ? Une étape venue du moteur porte le préfixe `moteur:`,
 * posé à l'inscription ; aucune heuristique n'est nécessaire pour les départager.
 */
type Filtre = 'tout' | 'problemes' | 'moteur' | 'app';

const FILTRES: { id: Filtre; cle: string; icone: string }[] = [
  { id: 'tout',      cle: 'journal_filter_all',    icone: 'apps-outline' },
  { id: 'problemes', cle: 'journal_filter_issues', icone: 'warning-outline' },
  { id: 'moteur',    cle: 'journal_filter_engine', icone: 'hardware-chip-outline' },
  { id: 'app',       cle: 'journal_filter_app',    icone: 'phone-portrait-outline' },
];

function correspond(etape: StepLogItem, filtre: Filtre): boolean {
  switch (filtre) {
    case 'problemes': return etape.status === 'error' || etape.status === 'warning';
    case 'moteur':    return etape.key.startsWith('moteur:');
    case 'app':       return !etape.key.startsWith('moteur:');
    default:          return true;
  }
}

/**
 * L'étape est-elle postérieure à un effacement d'affichage ?
 *
 * `timestamp` est facultatif dans le modèle. Une étape sans heure ne peut pas
 * être située : on la traite comme antérieure, donc masquée. C'est le choix
 * prudent — effacer l'affichage doit vider l'écran de façon prévisible, pas
 * y laisser des restes que l'utilisateur croira récents.
 */
function estApres(etape: StepLogItem, borne: string | null): boolean {
  if (!borne) return true;
  return typeof etape.timestamp === 'string' && etape.timestamp > borne;
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
  const { stepLogs } = useVpnContext();

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * COMMANDES DE LECTURE — pourquoi elles n'altèrent jamais le journal
   * ═══════════════════════════════════════════════════════════════════════
   * Un journal se consulte au pire moment : la connexion ne part pas, les
   * étapes défilent, et celle qu'on cherche est déjà remontée. Trois gestes
   * manquaient — trier, arrêter, repartir de zéro.
   *
   * Tous trois agissent sur l'AFFICHAGE seulement. `stepLogs` n'est jamais
   * vidé ni figé : le diagnostic reste entier pour le partage, et une
   * fausse manœuvre en pleine panne ne peut pas détruire la trace de la
   * panne. C'est la différence entre masquer et effacer, et elle compte
   * précisément quand l'utilisateur est pressé.
   */
  const [filtre, setFiltre] = useState<Filtre>('tout');
  const [gele, setGele] = useState(false);
  /** Étapes antérieures à cette heure : masquées, jamais supprimées. */
  const [masqueAvant, setMasqueAvant] = useState<string | null>(null);

  /**
   * Copie retenue pendant le gel.
   *
   * `stepLogs` continue d'avancer — c'est voulu, rien ne doit se perdre.
   * L'écran, lui, garde la vue qu'on était en train de lire.
   */
  const geleRef = useRef<StepLogItem[]>([]);
  if (!gele) geleRef.current = stepLogs;
  const source = gele ? geleRef.current : stepLogs;

  const retenues = useMemo(
    () => source.filter((e) => correspond(e, filtre) && estApres(e, masqueAvant)),
    [source, filtre, masqueAvant],
  );

  /** Compteurs par onglet — un filtre sans volume ne se choisit pas à l'aveugle. */
  const volumes = useMemo(() => {
    const visible = source.filter((e) => estApres(e, masqueAvant));
    return {
      tout: visible.length,
      problemes: visible.filter((e) => correspond(e, 'problemes')).length,
      moteur: visible.filter((e) => correspond(e, 'moteur')).length,
      app: visible.filter((e) => correspond(e, 'app')).length,
    } as Record<Filtre, number>;
  }, [source, masqueAvant]);

  // Le plus récent en haut : c'est ce qu'on vient chercher quand une connexion
  // ne part pas. `chronometrer` donne à chaque étape le temps qu'elle a coûté.
  const etapes = useMemo(() => chronometrer([...retenues].reverse()), [retenues]);

  /**
   * Met le journal AFFICHÉ dans le presse-papiers du système de partage.
   *
   * Reconstruit depuis les mêmes clés de traduction que l'écran : le texte
   * partagé ne peut donc contenir ni plus ni autre chose que ce que
   * l'utilisateur voit. Aucune adresse, aucune configuration, aucun secret —
   * la garantie tient par construction, pas par vigilance.
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

        {/* Partage du journal.
            Sans lui, l'utilisateur qui constate une connexion lente devait
            recopier l'écran à la main ou photographier son téléphone : le
            diagnostic n'arrivait jamais jusqu'au développeur.
            Ce qui part est EXACTEMENT ce qui est affiché — des libellés
            traduits, des heures et des durées. Le texte est reconstruit depuis
            les mêmes clés de traduction, donc il ne peut rien contenir de plus
            que l'écran : aucune adresse, aucune configuration, aucun secret. */}
        {etapes.length > 0 ? (
          <Pressable
            onPress={() => void partager()}
            accessibilityRole="button"
            accessibilityLabel={t("journal_share")}
            style={({ pressed }) => [
              styles.note,
              { backgroundColor: colors.bgCard, borderColor: colors.border },
              pressed && styles.presse,
            ]}
          >
            <Ionicons name="share-outline" size={15} color={colors.textSecondary} />
            <Text style={[type.captionMedium, { color: colors.textSecondary, flex: 1 }]}>{t("journal_share")}</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </Pressable>
        ) : null}

        {/* Barre de lecture — trier, arrêter, repartir.
            Les compteurs sont portés par les onglets : sans eux, choisir un
            filtre revient à parier sur ce qu'il contient. « Problèmes » à 0
            est une information, pas un onglet vide. */}
        {stepLogs.length > 0 ? (
          <View style={styles.commandes}>
            <View style={styles.onglets}>
              {FILTRES.map(({ id, cle, icone }) => {
                const actif = filtre === id;
                const n = volumes[id];
                return (
                  <Pressable
                    key={id}
                    onPress={() => setFiltre(id)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: actif }}
                    accessibilityLabel={`${t(cle as any)} — ${n}`}
                    style={({ pressed }) => [
                      styles.onglet,
                      actif
                        ? { backgroundColor: colors.primaryDim, borderColor: colors.primary + alpha.f24 }
                        : { backgroundColor: colors.bgCard, borderColor: colors.border },
                      pressed && styles.presse,
                    ]}
                  >
                    <Ionicons name={icone as any} size={13} color={actif ? colors.primary : colors.textMuted} />
                    <Text style={[type.micro, { color: actif ? colors.primary : colors.textSecondary }]}>
                      {t(cle as any)}
                    </Text>
                    <Text style={[type.micro, { color: actif ? colors.primary : colors.textMuted }]}>{n}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.actions}>
              <Pressable
                onPress={() => setGele((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ selected: gele }}
                accessibilityLabel={gele ? t("journal_resume") : t("journal_freeze")}
                style={({ pressed }) => [
                  styles.action,
                  gele
                    ? { backgroundColor: colors.warningDim, borderColor: colors.warning + alpha.f24 }
                    : { backgroundColor: colors.bgCard, borderColor: colors.border },
                  pressed && styles.presse,
                ]}
              >
                <Ionicons
                  name={gele ? "play-outline" : "pause-outline"}
                  size={14}
                  color={gele ? colors.warning : colors.textSecondary}
                />
                <Text style={[type.micro, { color: gele ? colors.warning : colors.textSecondary }]}>
                  {gele ? t("journal_resume") : t("journal_freeze")}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => setMasqueAvant(new Date().toISOString())}
                accessibilityRole="button"
                accessibilityLabel={t("journal_clear")}
                style={({ pressed }) => [
                  styles.action,
                  { backgroundColor: colors.bgCard, borderColor: colors.border },
                  pressed && styles.presse,
                ]}
              >
                <Ionicons name="eye-off-outline" size={14} color={colors.textSecondary} />
                <Text style={[type.micro, { color: colors.textSecondary }]}>{t("journal_clear")}</Text>
              </Pressable>
            </View>

            {/* Un état inhabituel doit se dire, sinon il passe pour une panne :
                un journal figé ressemble trait pour trait à un journal mort. */}
            {gele ? (
              <View style={[styles.note, { backgroundColor: colors.warningDim, borderColor: colors.warning + alpha.f24 }]}>
                <Ionicons name="pause-circle-outline" size={15} color={colors.warning} />
                <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>{t("journal_frozen_notice")}</Text>
              </View>
            ) : null}
            {masqueAvant ? (
              <View style={[styles.note, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                <Ionicons name="eye-off-outline" size={15} color={colors.textMuted} />
                <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>{t("journal_cleared_notice")}</Text>
                <Pressable
                  onPress={() => setMasqueAvant(null)}
                  accessibilityRole="button"
                  accessibilityLabel={t("journal_filter_all")}
                  hitSlop={8}
                >
                  <Ionicons name="refresh-outline" size={15} color={colors.primary} />
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

        {stepLogs.length === 0 ? (
          <EmptyState icon="list-outline" title={t("journal_empty_title")} description={t("journal_empty_subtitle")} />
        ) : etapes.length === 0 ? (
          <EmptyState icon="funnel-outline" title={t("journal_filtered_empty")} description={t("journal_empty_subtitle")} />
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
  commandes: { gap: spacing.sm },
  onglets: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  onglet: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    // 34 px de haut : la cible tactile reste confortable sans écraser la frise.
    paddingVertical: 8,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
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

import React, { useCallback, useMemo } from "react";
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

  // Le plus récent en haut : c'est ce qu'on vient chercher quand une connexion
  // ne part pas. `chronometrer` donne à chaque étape le temps qu'elle a coûté.
  const etapes = useMemo(() => chronometrer([...stepLogs].reverse()), [stepLogs]);

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
      [heure, t(etape.translationKey as any), duree, detailAffichable(etape.detail)]
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

        {etapes.length === 0 ? (
          <EmptyState icon="list-outline" title={t("journal_empty_title")} description={t("journal_empty_subtitle")} />
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

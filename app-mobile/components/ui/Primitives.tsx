/**
 * Primitives d'interface SXB VPN.
 *
 * Ces composants portent le vocabulaire visuel partagé par tous les écrans.
 * Les écrans décrivent CE QU'ILS AFFICHENT ; ces primitives décident COMMENT.
 * Auparavant chaque écran redéfinissait ses cartes, ses libellés et ses barres
 * de progression en style en ligne, d'où des bordures, des rayons et des
 * graisses qui divergeaient d'un écran à l'autre.
 *
 * Toutes s'accordent au thème clair/sombre via `useColors()`.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle, type StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { alpha, elevation, glow, layout, radius, spacing, type } from '@/constants/theme';

// ── Surface ──────────────────────────────────────────────────────────────────

interface SurfaceProps {
  children: React.ReactNode;
  /** `flat` pour une carte imbriquée, `raised` pour un bloc de premier plan. */
  variant?: 'flat' | 'raised' | 'outline';
  /** Teinte d'accent : colore la bordure et le fond (états d'alerte). */
  tone?: string;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}

/**
 * Carte de base.
 *
 * LE RELIEF suit la règle établie par `PowerButton` : **une seule source de
 * lumière, en haut à gauche**. Ce n'est pas le nombre de couches qui produit la
 * profondeur, c'est la cohérence de cette convention d'un composant à l'autre.
 *
 * Deux couches seulement ici, et elles suffisent :
 *  1. un lavis clair en haut, qui simule la lumière reçue par l'arête haute ;
 *  2. un liseré clair sur cette même arête, qui lui donne son épaisseur.
 *
 * L'ombre est TEINTÉE par l'accent de la carte plutôt que noire : sur un fond
 * très sombre, une ombre neutre ternit au lieu de creuser.
 */
export function Surface({ children, variant = 'flat', tone, style, padded = true }: SurfaceProps) {
  const colors = useColors();
  const toned = tone
    ? { borderColor: tone + alpha.f40, backgroundColor: tone + alpha.f08 }
    : { borderColor: colors.border, backgroundColor: variant === 'outline' ? 'transparent' : colors.bgCard };

  return (
    <View
      style={[
        styles.surface,
        toned,
        variant === 'raised' && elevation.md,
        // Une carte teintée porte le halo de sa propre teinte : c'est ce qui la
        // détache du fond sans l'éclaircir.
        tone ? glow(tone, 'sm') : null,
        style,
      ]}
    >
      {variant !== 'outline' && (
        <>
          <LinearGradient
            colors={['rgba(255,255,255,0.055)', 'rgba(255,255,255,0.012)', 'transparent']}
            start={{ x: 0.15, y: 0 }}
            end={{ x: 0.85, y: 1 }}
            style={styles.surfaceWash}
            pointerEvents="none"
          />
          <View style={styles.surfaceEdge} pointerEvents="none" />
        </>
      )}
      <View style={padded ? { padding: layout.cardPadding, gap: spacing.md } : undefined}>
        {children}
      </View>
    </View>
  );
}

// ── SectionHeader ────────────────────────────────────────────────────────────

interface SectionHeaderProps {
  title: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Élément aligné à droite : indicateur d'activité, action, valeur. */
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function SectionHeader({ title, icon, trailing, style }: SectionHeaderProps) {
  const colors = useColors();
  return (
    <View style={[styles.sectionHeader, style]}>
      <View style={styles.sectionHeaderLeft}>
        {icon && <Ionicons name={icon} size={14} color={colors.textMuted} />}
        <Text style={[type.overline, { color: colors.textMuted, textTransform: 'uppercase' }]}>
          {title}
        </Text>
      </View>
      {trailing}
    </View>
  );
}

// ── StatTile ─────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string;
  value: string;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: string;
  /** Chiffres alignés en colonne : indispensable pour une valeur qui varie. */
  monospace?: boolean;
}

export function StatTile({ label, value, icon, tone, monospace }: StatTileProps) {
  const colors = useColors();
  return (
    <View style={styles.statTile}>
      {icon && (
        <View style={[styles.statIcon, { backgroundColor: (tone || colors.primary) + alpha.f12 }]}>
          <Ionicons name={icon} size={13} color={tone || colors.primary} />
        </View>
      )}
      <Text
        style={[
          type.h3,
          { color: colors.textPrimary },
          // `tabular-nums` empêche la valeur de « sauter » quand les chiffres
          // changent, ce qui est très visible sur un compteur temps réel.
          monospace ? { fontVariant: ['tabular-nums' as const] } : null,
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
      >
        {value}
      </Text>
      <Text style={[type.micro, { color: colors.textMuted }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Rangée de tuiles séparées par un filet vertical. */
export function StatRow({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.statRow}>
      {items.map((child, i) => (
        <React.Fragment key={i}>
          {child}
          {i < items.length - 1 && (
            <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          )}
        </React.Fragment>
      ))}
    </View>
  );
}

// ── ProgressBar ──────────────────────────────────────────────────────────────

interface ProgressBarProps {
  /** Avancement entre 0 et 1. Les valeurs hors bornes sont ramenées. */
  progress: number;
  tone?: string;
  /** Teinte appliquée au-delà de 80 % : signale une limite proche. */
  warnTone?: string;
  height?: number;
}

export function ProgressBar({ progress, tone, warnTone, height = 7 }: ProgressBarProps) {
  const colors = useColors();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const fill = clamped > 0.8 && warnTone ? warnTone : tone || colors.primary;
  return (
    <View style={[styles.progressTrack, { height, borderRadius: height / 2, backgroundColor: colors.bgInput }]}>
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          borderRadius: height / 2,
          backgroundColor: fill,
        }}
      />
    </View>
  );
}

// ── Pill ─────────────────────────────────────────────────────────────────────

interface PillProps {
  label: string;
  tone: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Point coloré, pour signaler un état vivant (connexion active). */
  dot?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Pill({ label, tone, icon, dot, style }: PillProps) {
  return (
    <View style={[styles.pill, { borderColor: tone + alpha.f40, backgroundColor: tone + alpha.f12 }, style]}>
      {dot && <View style={[styles.pillDot, { backgroundColor: tone }]} />}
      {icon && <Ionicons name={icon} size={12} color={tone} />}
      <Text style={[type.captionMedium, { color: tone }]}>{label}</Text>
    </View>
  );
}

// ── IconButton ───────────────────────────────────────────────────────────────

interface IconButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  accessibilityLabel: string;
  tone?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}

export function IconButton({ icon, onPress, accessibilityLabel, tone, disabled, children }: IconButtonProps) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // Cible tactile élargie sans agrandir le dessin : la recommandation
      // d'accessibilité est d'au moins 44 px, le bouton n'en fait que 40.
      hitSlop={8}
      style={({ pressed }) => [
        styles.iconButton,
        { borderColor: colors.border, backgroundColor: colors.bgCard },
        pressed && { opacity: 0.7, transform: [{ scale: 0.95 }] },
        disabled && { opacity: 0.45 },
      ]}
    >
      {children ?? <Ionicons name={icon} size={19} color={tone || colors.textSecondary} />}
    </Pressable>
  );
}

// ── AccentCard ───────────────────────────────────────────────────────────────

interface AccentCardProps {
  children: React.ReactNode;
  /** Teinte de la carte, issue de `colors.accents`. */
  tone: string;
  icon?: keyof typeof Ionicons.glyphMap;
  title?: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Carte à en-tête teinté.
 *
 * POURQUOI : toutes les cartes étaient identiques — même bordure, même fond,
 * même absence de couleur. Rien ne signalait d'un coup d'œil qu'on regardait un
 * quota plutôt qu'un support ou une alerte ; il fallait lire chaque titre.
 *
 * La teinte est portée par une bande dégradée derrière l'en-tête, pas par le
 * fond entier : une carte intégralement colorée écraserait son contenu et
 * rendrait le texte moins lisible.
 */
export function AccentCard({ children, tone, icon, title, subtitle, trailing, style }: AccentCardProps) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.surface,
        { borderColor: tone + alpha.f24, backgroundColor: colors.bgCard, overflow: 'hidden' },
        elevation.sm,
        style,
      ]}
      // Le padding vit sur le corps, pour que le dégradé touche les bords.
      >
      <LinearGradient
        colors={[tone + alpha.f24, tone + alpha.f08, 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.accentWash}
        pointerEvents="none"
      />
      {(title || icon) && (
        <View style={styles.accentHeader}>
          {icon && (
            <View style={[styles.accentIcon, { backgroundColor: tone + alpha.f16, borderColor: tone + alpha.f24 }]}>
              <Ionicons name={icon} size={16} color={tone} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            {title && (
              <Text style={[type.h3, { color: colors.textPrimary }]} numberOfLines={1}>{title}</Text>
            )}
            {subtitle && (
              <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>{subtitle}</Text>
            )}
          </View>
          {trailing}
        </View>
      )}
      <View style={styles.accentBody}>{children}</View>
    </View>
  );
}

// ── ScreenHeader ─────────────────────────────────────────────────────────────

interface ScreenHeaderProps {
  title: string;
  /** Surtitre discret — en général le nom du produit. */
  eyebrow?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Teinte de l'écran. Reprend celle de l'onglet, pour que la couleur reste un repère. */
  tone: string;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
  paddingTop: number;
}

/**
 * En-tête d'écran teinté.
 *
 * POURQUOI : chaque écran répétait le même en-tête cyan, si bien que passer de
 * l'historique au profil ne se voyait pas — seul le titre changeait. La teinte
 * reprend ici celle de l'onglet correspondant : la couleur devient le repère
 * qui dit « où je suis » avant même la lecture.
 */
export function ScreenHeader({
  title, eyebrow, icon, tone, trailing, children, paddingTop,
}: ScreenHeaderProps) {
  const colors = useColors();
  return (
    <View style={[styles.screenHeader, { paddingTop, borderBottomColor: colors.border }]}>
      <LinearGradient
        colors={[tone + alpha.f16, 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.6, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.screenHeaderRow}>
        {icon && (
          <View style={[styles.screenHeaderIcon, { backgroundColor: tone + alpha.f16, borderColor: tone + alpha.f40 }]}>
            <Ionicons name={icon} size={19} color={tone} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          {eyebrow && (
            <Text style={[type.overline, { color: tone }]} numberOfLines={1}>{eyebrow}</Text>
          )}
          <Text style={[type.h1, { color: colors.textPrimary }]} numberOfLines={1}>{title}</Text>
        </View>
        {trailing}
      </View>
      {children}
    </View>
  );
}

// ── EmptyState ───────────────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.textMuted + alpha.f08 }]}>
        <Ionicons name={icon} size={22} color={colors.textMuted} />
      </View>
      <Text style={[type.bodyMedium, { color: colors.textSecondary, textAlign: 'center' }]}>{title}</Text>
      {description && (
        <Text style={[type.caption, { color: colors.textMuted, textAlign: 'center' }]}>{description}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
    // `overflow` contient le lavis dans les coins arrondis ; sans lui il
    // débordait en carré au-dessus de la bordure.
    overflow: 'hidden',
  },
  // Le lavis ne couvre que le haut : au-delà, il passerait derrière le texte
  // du corps et en abaisserait le contraste.
  surfaceWash: { position: 'absolute', left: 0, right: 0, top: 0, height: 72 },
  // Arête haute : un cheveu de lumière qui donne son épaisseur à la carte.
  surfaceEdge: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
  },
  statIcon: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginHorizontal: spacing.sm,
  },
  progressTrack: {
    width: '100%',
    overflow: 'hidden',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  pillDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },

  // ── AccentCard ─────────────────────────────────────────────────────────────
  // Le lavis ne couvre que le haut de la carte : au-delà, il passerait derrière
  // le texte du corps et en abaisserait le contraste.
  accentWash: { position: 'absolute', left: 0, right: 0, top: 0, height: 96 },
  accentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.cardPadding,
    paddingTop: layout.cardPadding,
  },
  accentIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accentBody: { padding: layout.cardPadding, gap: spacing.md },

  // ── ScreenHeader ───────────────────────────────────────────────────────────
  screenHeader: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    overflow: 'hidden',
  },
  screenHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  screenHeaderIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

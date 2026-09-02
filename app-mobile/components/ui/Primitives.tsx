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
import { useColors } from '@/hooks/useColors';
import { alpha, elevation, layout, radius, spacing, type } from '@/constants/theme';

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

export function Surface({ children, variant = 'flat', tone, style, padded = true }: SurfaceProps) {
  const colors = useColors();
  const toned = tone
    ? { borderColor: tone + alpha.f40, backgroundColor: tone + alpha.f08 }
    : { borderColor: colors.border, backgroundColor: variant === 'outline' ? 'transparent' : colors.bgCard };

  return (
    <View
      style={[
        styles.surface,
        padded && { padding: layout.cardPadding },
        toned,
        variant === 'raised' && elevation.md,
        style,
      ]}
    >
      {children}
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
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
});

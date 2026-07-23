import Colors from '@/constants/colors';

/**
 * Returns the SXB VPN design tokens with semantic aliases.
 *
 * The base palette lives in constants/colors.ts. This hook exposes
 * both the raw tokens and shadcn-compatible semantic names so every
 * component can use a consistent API regardless of the naming
 * convention in the base file.
 */
export function useColors() {
  return {
    // ── Raw tokens ──────────────────────────────────────────────
    ...Colors,

    // ── Semantic aliases ─────────────────────────────────────────
    /** Main text colour */
    foreground: Colors.textPrimary,
    /** Page / screen background */
    background: Colors.bg,
    /** Card surface */
    card: Colors.bgCard,
    /** Text on primary-coloured surfaces */
    primaryForeground: Colors.bg,
    /** Muted / secondary text */
    mutedForeground: Colors.textSecondary,
    /** Muted surface (chips, tags, etc.) */
    muted: Colors.bgCard2,
    /** Error / danger colour */
    destructive: Colors.disconnected,
    /** Success colour (alias for connected) */
    success: Colors.connected,
    /** Informational colour (alias for primary) */
    info: Colors.primary,
    /** Input background */
    input: Colors.bgInput,
    /** In-progress / connecting colour (amber) */
    connecting: Colors.warning,
    /** Glass-effect border */
    glassBorder: Colors.border2,
  } as const;
}

export type AppColors = ReturnType<typeof useColors>;

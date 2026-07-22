import Colors from '@/constants/colors';

/**
 * Returns the design tokens for the current color scheme.
 */
export function useColors() {
  return {
    ...Colors,
    destructive: Colors.disconnected,
    foreground: Colors.textPrimary,
    mutedForeground: Colors.textMuted,
    card: Colors.bgCard,
    radius: 16,

    // Mapping standard theme names
    background: Colors.bg,
    primaryForeground: "#000000",
    glassBorder: "rgba(26,37,64,0.4)",
    success: Colors.connected,
    info: Colors.primary,
    muted: Colors.textMuted,
    connecting: Colors.warning,
    input: Colors.bgInput,
  };
}

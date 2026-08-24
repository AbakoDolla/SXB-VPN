import { getThemeColors } from "@/constants/colors";
import { useThemeContext } from "@/contexts/ThemeContext";

/**
 * Tokens réactifs de l’interface. Les écrans hérités peuvent continuer à
 * importer `Colors` pour leur rendu sombre par défaut, tandis que les écrans
 * refondus utilisent ce hook pour suivre le choix clair/sombre/système.
 */
export function useColors() {
  const { colorScheme } = useThemeContext();
  const colors = getThemeColors(colorScheme);
  return {
    ...colors,
    destructive: colors.disconnected,
    foreground: colors.textPrimary,
    mutedForeground: colors.textMuted,
    card: colors.bgCard,
    radius: 18,
    background: colors.bg,
    primaryForeground: colorScheme === "dark" ? "#06101D" : "#FFFFFF",
    glassBorder: colorScheme === "dark" ? "rgba(65,216,255,0.20)" : "rgba(23,105,232,0.16)",
    success: colors.connected,
    info: colors.primary,
    muted: colors.textMuted,
    connecting: colors.warning,
    input: colors.bgInput,
  };
}

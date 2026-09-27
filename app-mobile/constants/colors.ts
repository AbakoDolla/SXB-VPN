export type AppColorScheme = "light" | "dark";

export type ThemeColors = {
  /** Schéma résolu : permet aux aides de teinte de choisir la bonne méthode. */
  scheme: AppColorScheme;
  bg: string;
  bgCard: string;
  bgCard2: string;
  bgInput: string;
  border: string;
  border2: string;
  /** Rail des barres de progression : visible sur une carte comme sur le fond. */
  track: string;
  /** Couleur et intensité des ombres portées. Noires sur fond nuit, bleu
   *  ardoise et deux fois plus légères sur fond clair : une ombre noire sur du
   *  blanc salit la carte au lieu de la détacher. */
  shadow: string;
  shadowScale: number;
  /** Relief du bouton de connexion. Les dégradés noirs qui creusent l'embase
   *  sur fond nuit deviennent un gris métallique terne sur fond clair : le
   *  thème clair reçoit sa propre lumière, blanche et bleutée. */
  depth: {
    well: readonly [string, string, string];
    bezel: readonly [string, string, string];
    core: 'tinted' | 'porcelain';
    coreShade: string;
    gloss: readonly [string, string];
  };
  primary: string;
  primaryDim: string;
  primaryGlow: string;
  connected: string;
  connectedDim: string;
  connectedGlow: string;
  disconnected: string;
  disconnectedDim: string;
  warning: string;
  warningDim: string;
  purple: string;
  purpleDim: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textAccent: string;
  tabActive: string;
  tabInactive: string;
  overlay: string;
  /**
   * Teintes d'accent nommées.
   *
   * POURQUOI : toute l'interface tirait sur un seul cyan, si bien que rien ne
   * distinguait un écran d'un autre ni une catégorie d'une autre — l'ensemble
   * était cohérent mais monotone, et le repérage reposait uniquement sur la
   * lecture des titres.
   *
   * Chaque teinte est choisie pour rester lisible sur le fond sombre ET sur le
   * fond clair, et pour se distinguer des voisines même en vision daltonienne
   * (les couples critiques ne sont jamais rouge/vert seuls : un icône ou un
   * libellé accompagne toujours la couleur).
   */
  accents: {
    cyan: string;
    violet: string;
    emeraude: string;
    ambre: string;
    rose: string;
    indigo: string;
    corail: string;
    turquoise: string;
  };
  gradients: {
    bg: readonly string[];
    primary: readonly string[];
    connected: readonly string[];
    shield: readonly string[];
    card: readonly string[];
  };
};

const darkColors: ThemeColors = {
  scheme: "dark",
  // Fond nettement plus profond et légèrement désaturé vers le bleu nuit : il
  // fait ressortir le halo du bouton de connexion, qui est le point focal de
  // l'écran d'accueil. L'ancien #07101F restait trop clair pour cela.
  bg: "#050B16",
  bgCard: "#0C1526",
  bgCard2: "#131F33",
  bgInput: "#0A1220",
  border: "#1D2C44",
  border2: "#294059",
  track: "#1B2A42",
  shadow: "#000000",
  shadowScale: 1,
  depth: {
    well: ["rgba(0,0,0,0.55)", "rgba(0,0,0,0.12)", "rgba(255,255,255,0.05)"],
    bezel: ["rgba(255,255,255,0.18)", "rgba(255,255,255,0.02)", "rgba(0,0,0,0.35)"],
    core: "tinted",
    coreShade: "rgba(0,0,0,0.30)",
    gloss: ["rgba(255,255,255,0.30)", "rgba(255,255,255,0.05)"],
  },
  primary: "#41D8FF",
  primaryDim: "rgba(65,216,255,0.14)",
  primaryGlow: "rgba(65,216,255,0.28)",
  connected: "#39E6B0",
  connectedDim: "rgba(57,230,176,0.14)",
  connectedGlow: "rgba(57,230,176,0.28)",
  disconnected: "#FF637B",
  disconnectedDim: "rgba(255,99,123,0.14)",
  warning: "#FFC857",
  warningDim: "rgba(255,200,87,0.14)",
  purple: "#A78BFA",
  purpleDim: "rgba(167,139,250,0.14)",
  textPrimary: "#F6FAFF",
  textSecondary: "#AFC0D6",
  textMuted: "#6B819F",
  textAccent: "#41D8FF",
  tabActive: "#41D8FF",
  tabInactive: "#6B819F",
  overlay: "rgba(3,7,14,0.9)",
  // Teintes saturées mais non fluorescentes : sur un fond très sombre, une
  // couleur pure « bave » et fatigue l'œil. Chacune garde assez de luminance
  // pour rester lisible en texte de petite taille.
  accents: {
    cyan: "#41D8FF",
    violet: "#A78BFA",
    emeraude: "#39E6B0",
    ambre: "#FFC857",
    rose: "#FF7EB6",
    indigo: "#7C9CFF",
    corail: "#FF9776",
    turquoise: "#4BE3D2",
  },
  gradients: {
    // Dégradé en trois temps : le point le plus clair est légèrement au-dessus
    // du centre, là où se trouve le bouton, ce qui crée une lumière naturelle.
    bg: ["#050B16", "#0A1729", "#050B16"],
    primary: ["#41D8FF", "#3E7BFF"],
    connected: ["#39E6B0", "#159A8A"],
    shield: ["rgba(65,216,255,0.20)", "rgba(65,216,255,0)", "rgba(57,230,176,0.12)"],
    card: ["#0C1526", "#131F33"],
  },
};

const lightColors: ThemeColors = {
  scheme: "light",
  // Fond clair légèrement bleuté, cartes blanches franches : l'ancien écart
  // (#F4F8FC contre #FFFFFF) ne séparait plus les cartes du fond, et tout
  // l'écran paraissait gris et délavé.
  bg: "#EFF3F9",
  bgCard: "#FFFFFF",
  bgCard2: "#F4F7FC",
  bgInput: "#F1F5FA",
  border: "#DAE3EE",
  border2: "#BFCEE0",
  track: "#E1E9F3",
  shadow: "#1D3B5E",
  shadowScale: 0.45,
  depth: {
    // Embase : un creux doux (ombre ardoise en haut, lumière en bas) au lieu
    // du puits noir du thème nuit.
    well: ["rgba(29,59,94,0.10)", "rgba(29,59,94,0.03)", "rgba(255,255,255,0.95)"],
    // Couronne en relief : blanche, éclairée en haut à gauche.
    bezel: ["#FFFFFF", "#F2F6FC", "rgba(29,59,94,0.14)"],
    // Dôme en porcelaine : blanc éclairé, teinté par l'état vers le bas.
    core: "porcelain",
    coreShade: "rgba(29,59,94,0.10)",
    gloss: ["rgba(255,255,255,0.85)", "rgba(255,255,255,0.10)"],
  },
  primary: "#1769E8",
  primaryDim: "rgba(23,105,232,0.10)",
  primaryGlow: "rgba(23,105,232,0.18)",
  // Teintes d'état assombries : sur blanc, les versions précédentes
  // tombaient sous 4,5:1 et les montants en vert (« 1 GB restant ») comme les
  // pastilles « Actif » se lisaient mal.
  connected: "#067F5B",
  connectedDim: "rgba(6,127,91,0.10)",
  connectedGlow: "rgba(6,127,91,0.20)",
  disconnected: "#C42F49",
  disconnectedDim: "rgba(196,47,73,0.10)",
  warning: "#8F5B00",
  warningDim: "rgba(143,91,0,0.10)",
  purple: "#6D4BD2",
  purpleDim: "rgba(109,75,210,0.10)",
  textPrimary: "#0C1B2E",
  textSecondary: "#3D5570",
  // 5,5:1 sur blanc (l'ancien #71869D plafonnait à 3,7:1).
  textMuted: "#566B84",
  textAccent: "#1769E8",
  tabActive: "#1769E8",
  tabInactive: "#566B84",
  overlay: "rgba(12,27,46,0.52)",
  // Mêmes familles qu'en sombre, assombries jusqu'à 4,5:1 au moins sur blanc :
  // les teintes claires du thème sombre passeraient pour du pastel délavé, et
  // un texte écrit avec ne serait plus lisible.
  accents: {
    cyan: "#0A76A6",
    violet: "#6D4BD2",
    emeraude: "#067F5B",
    ambre: "#8F5B00",
    rose: "#C63C82",
    indigo: "#3C5FD0",
    corail: "#B84A26",
    turquoise: "#0B7A72",
  },
  gradients: {
    // Lumière douce derrière le bouton de connexion, sans voile gris.
    bg: ["#F3F6FB", "#E6EEF9", "#F3F6FB"],
    primary: ["#1769E8", "#4E8DFF"],
    connected: ["#067F5B", "#1FAE83"],
    shield: ["rgba(23,105,232,0.12)", "rgba(23,105,232,0)", "rgba(6,127,91,0.08)"],
    card: ["#FFFFFF", "#F4F7FC"],
  },
};

export function getThemeColors(scheme: AppColorScheme): ThemeColors {
  return scheme === "light" ? lightColors : darkColors;
}

function channels(value: string): [number, number, number] | null {
  const hex = value.trim().replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

/**
 * Fond teinté d'une surface posée sur le fond de page.
 *
 * Sur fond nuit, une teinte translucide rayonne. Sur fond clair, la même
 * teinte translucide se mélange au bleu-gris du fond et donne un gris sale :
 * c'est ce qui rendait les alertes et les boutons du profil ternes. En clair,
 * la teinte est donc mélangée à la couleur de carte et rendue opaque.
 */
export function tintedSurface(colors: ThemeColors, tone: string, amount = 0.08): string {
  const from = channels(tone);
  const base = channels(colors.bgCard);
  if (colors.scheme === "dark" || !from || !base) {
    return tone + Math.round(Math.min(1, Math.max(0, amount)) * 255).toString(16).padStart(2, "0").toUpperCase();
  }
  const mixed = from.map((channel, index) => Math.round(channel * amount + base[index] * (1 - amount)));
  return "#" + mixed.map(channel => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
}

type ShadowLevel = "sm" | "md" | "lg";
const SHADOWS: Record<ShadowLevel, { opacity: number; radius: number; offset: number; elevation: number }> = {
  sm: { opacity: 0.16, radius: 10, offset: 3, elevation: 3 },
  md: { opacity: 0.22, radius: 18, offset: 7, elevation: 7 },
  lg: { opacity: 0.3, radius: 28, offset: 12, elevation: 14 },
};

/** Ombre portée adaptée au thème (voir `shadow` et `shadowScale`). */
export function surfaceShadow(colors: ThemeColors, level: ShadowLevel = "sm") {
  const preset = SHADOWS[level];
  return {
    shadowColor: colors.shadow,
    shadowOpacity: preset.opacity * colors.shadowScale,
    shadowRadius: preset.radius,
    shadowOffset: { width: 0, height: preset.offset },
    elevation: colors.scheme === "dark" ? preset.elevation : Math.max(1, Math.round(preset.elevation / 2)),
  };
}

// Compatibilité avec les écrans hérités : le rendu par défaut reste sombre.
export const Colors = darkColors;
export default Colors;

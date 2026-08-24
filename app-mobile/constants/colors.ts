export type AppColorScheme = "light" | "dark";

export type ThemeColors = {
  bg: string;
  bgCard: string;
  bgCard2: string;
  bgInput: string;
  border: string;
  border2: string;
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
  gradients: {
    bg: readonly string[];
    primary: readonly string[];
    connected: readonly string[];
    shield: readonly string[];
    card: readonly string[];
  };
};

const darkColors: ThemeColors = {
  bg: "#07101F",
  bgCard: "#0D1B2E",
  bgCard2: "#12243A",
  bgInput: "#091729",
  border: "#203754",
  border2: "#2A4667",
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
  textSecondary: "#B3C3D8",
  textMuted: "#7086A4",
  textAccent: "#41D8FF",
  tabActive: "#41D8FF",
  tabInactive: "#7086A4",
  overlay: "rgba(4,10,20,0.88)",
  gradients: {
    bg: ["#07101F", "#0B1A31", "#07101F"],
    primary: ["#41D8FF", "#3E7BFF"],
    connected: ["#39E6B0", "#159A8A"],
    shield: ["rgba(65,216,255,0.20)", "rgba(65,216,255,0)", "rgba(57,230,176,0.12)"],
    card: ["#0D1B2E", "#12243A"],
  },
};

const lightColors: ThemeColors = {
  bg: "#F4F8FC",
  bgCard: "#FFFFFF",
  bgCard2: "#EEF4FA",
  bgInput: "#F7FAFD",
  border: "#D7E2EE",
  border2: "#B8CBE0",
  primary: "#1769E8",
  primaryDim: "rgba(23,105,232,0.10)",
  primaryGlow: "rgba(23,105,232,0.18)",
  connected: "#07966B",
  connectedDim: "rgba(7,150,107,0.10)",
  connectedGlow: "rgba(7,150,107,0.20)",
  disconnected: "#D63B55",
  disconnectedDim: "rgba(214,59,85,0.10)",
  warning: "#A66A00",
  warningDim: "rgba(166,106,0,0.10)",
  purple: "#6D4BD2",
  purpleDim: "rgba(109,75,210,0.10)",
  textPrimary: "#102033",
  textSecondary: "#48627E",
  textMuted: "#71869D",
  textAccent: "#1769E8",
  tabActive: "#1769E8",
  tabInactive: "#71869D",
  overlay: "rgba(16,32,51,0.58)",
  gradients: {
    bg: ["#F4F8FC", "#EAF2FB", "#F4F8FC"],
    primary: ["#1769E8", "#4E8DFF"],
    connected: ["#07966B", "#20B989"],
    shield: ["rgba(23,105,232,0.12)", "rgba(23,105,232,0)", "rgba(7,150,107,0.08)"],
    card: ["#FFFFFF", "#EEF4FA"],
  },
};

export function getThemeColors(scheme: AppColorScheme): ThemeColors {
  return scheme === "light" ? lightColors : darkColors;
}

// Compatibilité avec les écrans hérités : le rendu par défaut reste sombre.
export const Colors = darkColors;
export default Colors;

// SXB VPN — Premium Dark Design System

export const Colors = {
  // Backgrounds
  bg: "#060914",
  bgCard: "#0D1421",
  bgCard2: "#111827",
  bgInput: "#0A0F1C",

  // Borders
  border: "#1A2540",
  border2: "#1F2D45",

  // Brand
  primary: "#00D4FF",
  primaryDim: "rgba(0,212,255,0.15)",
  primaryGlow: "rgba(0,212,255,0.25)",

  // States
  connected: "#00E5A0",
  connectedDim: "rgba(0,229,160,0.15)",
  connectedGlow: "rgba(0,229,160,0.3)",

  disconnected: "#FF4560",
  disconnectedDim: "rgba(255,69,96,0.15)",

  warning: "#F59E0B",
  warningDim: "rgba(245,158,11,0.15)",

  purple: "#8B5CF6",
  purpleDim: "rgba(139,92,246,0.15)",

  // Text
  textPrimary: "#FFFFFF",
  textSecondary: "#8B9CC8",
  textMuted: "#4B5B7A",
  textAccent: "#00D4FF",

  // Gradient stops
  gradients: {
    bg: ["#060914", "#0A1025", "#060914"] as [string, string, string],
    primary: ["#00D4FF", "#0080FF"] as [string, string],
    connected: ["#00E5A0", "#00B07A"] as [string, string],
    shield: ["rgba(0,212,255,0.2)", "rgba(0,212,255,0)", "rgba(0,229,160,0.1)"] as [string, string, string],
    card: ["#0D1421", "#111827"] as [string, string],
  },

  // Semantic
  tabActive: "#00D4FF",
  tabInactive: "#3B4D6E",
  overlay: "rgba(6,9,20,0.85)",
};

export default Colors;

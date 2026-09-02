/**
 * Socle du système de design SXB VPN.
 *
 * Les couleurs vivent dans `constants/colors.ts` et restent pilotées par le
 * thème clair/sombre. Ce fichier définit tout le reste — les grandeurs qui ne
 * dépendent pas du thème — afin qu'aucun écran n'ait à réinventer une marge,
 * un rayon ou une taille de police.
 *
 * Pourquoi une échelle plutôt que des valeurs libres : les écrans mélangeaient
 * des marges de 8, 10, 12, 14, 16, 18 et 20 px sans logique, ce qui produisait
 * un rythme vertical irrégulier. Une échelle restreinte rend l'alignement
 * automatique et l'ensemble immédiatement plus soigné.
 */

/** Échelle d'espacement, base 4. Tout espacement doit venir d'ici. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 56,
} as const;

/** Rayons de bordure. Les cartes utilisent `lg`, les pastilles `full`. */
export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  '2xl': 32,
  full: 999,
} as const;

/**
 * Échelle typographique. Les familles correspondent aux polices Inter déjà
 * chargées par `app/_layout.tsx` : ne pas y introduire de graisse non chargée,
 * React Native retomberait silencieusement sur la police système.
 */
export const font = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

export const type = {
  /** Compteurs héros : durée de session, valeur de quota principale. */
  display: { fontSize: 40, lineHeight: 46, fontFamily: font.bold, letterSpacing: -1 },
  h1: { fontSize: 26, lineHeight: 32, fontFamily: font.bold, letterSpacing: -0.5 },
  h2: { fontSize: 19, lineHeight: 25, fontFamily: font.semibold, letterSpacing: -0.2 },
  h3: { fontSize: 16, lineHeight: 22, fontFamily: font.semibold },
  body: { fontSize: 14, lineHeight: 20, fontFamily: font.regular },
  bodyMedium: { fontSize: 14, lineHeight: 20, fontFamily: font.medium },
  caption: { fontSize: 12, lineHeight: 17, fontFamily: font.regular },
  captionMedium: { fontSize: 12, lineHeight: 17, fontFamily: font.medium },
  /** Intitulés de section et de statistique, en majuscules espacées. */
  overline: { fontSize: 11, lineHeight: 15, fontFamily: font.semibold, letterSpacing: 0.8 },
  micro: { fontSize: 10, lineHeight: 14, fontFamily: font.medium, letterSpacing: 0.3 },
} as const;

/**
 * Élévations. Une ombre colorée par la teinte de l'élément (plutôt que noire)
 * évite l'aspect terne caractéristique des ombres neutres sur fond sombre.
 */
export const elevation = {
  none: {},
  sm: {
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  md: {
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 7 },
    elevation: 7,
  },
  lg: {
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 14,
  },
} as const;

/** Halo teinté, pour le bouton de connexion et les états actifs. */
export function glow(color: string, intensity: 'sm' | 'md' | 'lg' = 'md') {
  const presets = {
    sm: { shadowOpacity: 0.35, shadowRadius: 14, elevation: 6 },
    md: { shadowOpacity: 0.45, shadowRadius: 24, elevation: 12 },
    lg: { shadowOpacity: 0.6, shadowRadius: 38, elevation: 20 },
  } as const;
  return {
    shadowColor: color,
    shadowOffset: { width: 0, height: 0 },
    ...presets[intensity],
  };
}

/** Durées d'animation, en millisecondes. */
export const duration = {
  fast: 150,
  base: 260,
  slow: 420,
  pulse: 2200,
} as const;

/**
 * Opacités d'incrustation, en suffixe hexadécimal. Écrire `color + alpha.f12`
 * documente l'intention, là où un `+ '1F'` littéral n'évoque rien.
 */
export const alpha = {
  f08: '14',
  f12: '1F',
  f16: '29',
  f24: '3D',
  f40: '66',
  f60: '99',
} as const;

export const layout = {
  screenPadding: spacing.xl,
  cardPadding: spacing.lg,
  gap: spacing.md,
  /** Marge basse laissant respirer le contenu au-dessus de la barre d'onglets. */
  tabBarClearance: 108,
} as const;

import { useMemo } from 'react';
import * as ReactNative from 'react-native';
import { breakpoints, responsiveLayout, spacing } from '@/constants/theme';

export type WindowClass = 'compact' | 'regular' | 'large';

export interface ResponsiveLayout {
  width: number;
  height: number;
  fontScale: number;
  windowClass: WindowClass;
  isCompact: boolean;
  isLarge: boolean;
  isLandscape: boolean;
  screenPadding: number;
  cardPadding: number;
  gap: number;
  contentMaxWidth: number | undefined;
  wideContentMaxWidth: number | undefined;
  touchTarget: number;
  quickActionColumns: number;
  statColumns: number;
}

export function deriveResponsiveLayout({
  width,
  height,
  fontScale = 1,
}: {
  width: number;
  height: number;
  fontScale?: number;
}): ResponsiveLayout {
  const isCompact = width < breakpoints.compact;
  const isLarge = width >= breakpoints.large;
  const windowClass: WindowClass = isCompact ? 'compact' : isLarge ? 'large' : 'regular';
  const scaledCompact = isCompact || fontScale >= 1.25;

  return {
    width,
    height,
    fontScale,
    windowClass,
    isCompact,
    isLarge,
    isLandscape: width > height,
    screenPadding: isCompact
      ? responsiveLayout.compactPadding
      : isLarge
        ? responsiveLayout.largePadding
        : responsiveLayout.regularPadding,
    cardPadding: isCompact
      ? responsiveLayout.compactCardPadding
      : isLarge
        ? responsiveLayout.largeCardPadding
        : responsiveLayout.regularCardPadding,
    gap: isCompact ? spacing.sm : isLarge ? spacing.lg : spacing.md,
    contentMaxWidth: isLarge ? responsiveLayout.contentMaxWidth : undefined,
    wideContentMaxWidth: isLarge ? responsiveLayout.wideContentMaxWidth : undefined,
    touchTarget: responsiveLayout.touchTarget,
    quickActionColumns: isLarge ? 4 : 2,
    statColumns: isLarge ? 4 : scaledCompact ? 2 : 3,
  };
}

export function useResponsive(): ResponsiveLayout {
  const readWindowDimensions = ReactNative.useWindowDimensions ?? (() => ({
    width: 390,
    height: 844,
    fontScale: 1,
  }));
  const { width, height, fontScale } = readWindowDimensions();
  return useMemo(
    () => deriveResponsiveLayout({ width, height, fontScale }),
    [width, height, fontScale],
  );
}

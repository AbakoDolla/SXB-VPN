import React, { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useMotionPreference } from '@/hooks/useMotionPreference';
import { useTranslation } from '@/localization';
import { alpha, elevation, font, radius, spacing, type } from '@/constants/theme';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];
type TabName = 'index' | 'history' | 'profile' | 'notifications';
type TabItem = {
  labelKey: 'home' | 'history' | 'profile' | 'alerts_tab';
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  tone: 'cyan' | 'violet' | 'emeraude' | 'ambre';
};

const TAB_ITEMS: Record<TabName, TabItem> = {
  index: { labelKey: 'home', icon: 'home-outline', activeIcon: 'home', tone: 'cyan' },
  history: { labelKey: 'history', icon: 'time-outline', activeIcon: 'time', tone: 'violet' },
  profile: { labelKey: 'profile', icon: 'person-outline', activeIcon: 'person', tone: 'emeraude' },
  notifications: { labelKey: 'alerts_tab', icon: 'notifications-outline', activeIcon: 'notifications', tone: 'ambre' },
};

function isTabName(name: string): name is TabName {
  return Object.prototype.hasOwnProperty.call(TAB_ITEMS, name);
}

function DockItem({
  tab, label, selected, motionEnabled, onPress, onLongPress, testID,
}: {
  tab: TabItem;
  label: string;
  selected: boolean;
  motionEnabled: boolean;
  onPress: () => void;
  onLongPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const tone = colors.accents[tab.tone];
  const [focused, setFocused] = useState(false);
  const selectedValue = useRef(new Animated.Value(selected ? 1 : 0)).current;

  useEffect(() => {
    if (!motionEnabled) {
      selectedValue.stopAnimation();
      selectedValue.setValue(selected ? 1 : 0);
      return;
    }
    const animation = Animated.spring(selectedValue, {
      toValue: selected ? 1 : 0,
      damping: 20,
      stiffness: 230,
      mass: 0.8,
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [motionEnabled, selected, selectedValue]);

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      aria-selected={selected}
      onPress={onPress}
      onLongPress={onLongPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID={testID}
      style={({ pressed }) => [
        styles.item,
        { borderColor: focused ? colors.textPrimary : 'transparent' },
        pressed && { backgroundColor: tone + alpha.f08 },
      ]}
    >
      <Animated.View style={[
        styles.icon,
        { backgroundColor: colors.bgCard2 },
        selected && { ...elevation.sm, shadowColor: tone },
        { transform: [{ translateY: motionEnabled
          ? selectedValue.interpolate({ inputRange: [0, 1], outputRange: [0, -4] })
          : 0 }] },
      ]}>
        <Animated.View pointerEvents="none" style={[styles.iconFill, { opacity: selectedValue }]}>
          <LinearGradient
            colors={[tone, colors.primary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.iconFill}
          />
          <View style={styles.highlight} />
        </Animated.View>
        <Ionicons
          name={selected ? tab.activeIcon : tab.icon}
          size={22}
          color={selected ? colors.primaryForeground : colors.textSecondary}
          accessible={false}
          aria-hidden
        />
      </Animated.View>
      <Text style={[type.captionMedium, styles.label, {
        color: selected ? colors.textPrimary : colors.textSecondary,
        fontFamily: selected ? font.bold : type.captionMedium.fontFamily,
      }]}>
        {label}
      </Text>
      <View
        accessible={false}
        aria-hidden
        style={[styles.marker, { backgroundColor: selected ? tone : 'transparent' }]}
      />
    </Pressable>
  );
}

export default function TabDock({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { t } = useTranslation();
  const { motionEnabled } = useMotionPreference();

  return (
    <View style={[styles.shell, {
      backgroundColor: colors.bg,
      paddingBottom: Math.max(insets.bottom, spacing.sm),
      paddingLeft: Math.max(insets.left, spacing.md),
      paddingRight: Math.max(insets.right, spacing.md),
    }]}>
      <View style={styles.dockFrame}>
        <View pointerEvents="none" style={[styles.plinth, { backgroundColor: colors.border }]} />
        <View accessibilityRole="tablist" style={[
          styles.dock,
          elevation.md,
          { backgroundColor: colors.bgCard, borderColor: colors.border2 },
        ]}>
          {state.routes.map((route, index) => {
            if (!isTabName(route.name)) return null;
            const tab = TAB_ITEMS[route.name];
            const selected = state.index === index;
            const options = descriptors[route.key].options;
            return (
              <DockItem
                key={route.key}
                tab={tab}
                label={options.tabBarAccessibilityLabel || t(tab.labelKey)}
                testID={options.tabBarButtonTestID}
                selected={selected}
                motionEnabled={motionEnabled}
                onPress={() => {
                  const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                  if (selected || event.defaultPrevented) return;
                  navigation.navigate(route.name, route.params);
                  if (Platform.OS !== 'web') {
                    void Haptics.selectionAsync().catch(() => {
                      console.warn('[Navigation] Haptic feedback unavailable.');
                    });
                  }
                }}
                onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              />
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { paddingTop: spacing.sm },
  dockFrame: { width: '100%', maxWidth: 620, alignSelf: 'center', paddingBottom: spacing.xs },
  plinth: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: 0, height: 32, borderRadius: radius.xl },
  dock: { flexDirection: 'row', alignItems: 'stretch', padding: spacing.xs, borderWidth: 1, borderRadius: radius.xl },
  item: { flex: 1, minWidth: 0, minHeight: 90, alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.sm, borderWidth: 2, borderRadius: radius.lg },
  icon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  iconFill: { ...StyleSheet.absoluteFillObject, borderRadius: radius.md, overflow: 'hidden' },
  highlight: { position: 'absolute', top: 1, left: 10, right: 10, height: 1, backgroundColor: 'rgba(255,255,255,0.6)' },
  label: { textAlign: 'center', fontSize: 11, lineHeight: 16, flexShrink: 1, maxWidth: '100%' },
  marker: { width: 12, height: 3, borderRadius: radius.full },
});

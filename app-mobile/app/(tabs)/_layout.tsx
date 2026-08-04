import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Tabs, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useTranslation } from "@/localization";

type TabName = "index" | "history" | "profile" | "notifications";

type TabItem = { name: TabName; labelKey: 'home' | 'history' | 'profile' | 'alerts_tab'; icon: string; iconFocused: string };

const TAB_ITEMS: TabItem[] = [
  { name: "index",         labelKey: 'home',       icon: "home-outline",         iconFocused: "home" },
  { name: "history",       labelKey: 'history',    icon: "time-outline",          iconFocused: "time" },
  { name: "profile",       labelKey: 'profile',    icon: "person-outline",        iconFocused: "person" },
  { name: "notifications", labelKey: 'alerts_tab', icon: "notifications-outline", iconFocused: "notifications" },
];

function CustomTabBar({ state, descriptors, navigation }: any) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();

  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {state.routes.map((route: any, index: number) => {
        const tab = TAB_ITEMS[index];
        const isFocused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            style={styles.tabItem}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            {isFocused && <View style={styles.activeIndicator} />}
            <Ionicons
              name={(isFocused ? tab?.iconFocused : tab?.icon) as any}
              size={22}
              color={isFocused ? Colors.primary : Colors.tabInactive}
            />
            <Text style={[styles.tabLabel, { color: isFocused ? Colors.primary : Colors.tabInactive }]}>
              {tab ? t(tab.labelKey) : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="profile" />
      <Tabs.Screen name="notifications" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#0A0F1C",
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 10,
  },
  tabItem: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  activeIndicator: {
    position: "absolute",
    top: -10,
    width: 32,
    height: 2,
    backgroundColor: Colors.primary,
    borderRadius: 2,
  },
  tabLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
});

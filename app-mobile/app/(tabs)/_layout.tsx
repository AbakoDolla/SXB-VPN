import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";

type TabName = "index" | "history" | "profile" | "notifications";
type TabItem = { name: TabName; labelKey: "home" | "history" | "profile" | "alerts_tab"; icon: string; iconFocused: string };

const TAB_ITEMS: TabItem[] = [
  { name: "index", labelKey: "home", icon: "home-outline", iconFocused: "home" },
  { name: "history", labelKey: "history", icon: "time-outline", iconFocused: "time" },
  { name: "profile", labelKey: "profile", icon: "person-outline", iconFocused: "person" },
  { name: "notifications", labelKey: "alerts_tab", icon: "notifications-outline", iconFocused: "notifications" },
];

function CustomTabBar({ state, navigation }: any) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { t } = useTranslation();
  const bottomPadding = Platform.OS === "web" ? 10 : Math.max(insets.bottom, 10);

  return (
    <View style={[styles.shell, { backgroundColor: colors.bg, borderTopColor: colors.border, paddingBottom: bottomPadding }]}>
      <View style={[styles.tabBar, { backgroundColor: colors.bgCard + "F2", borderColor: colors.border }]}>
        {state.routes.map((route: any, index: number) => {
          const tab = TAB_ITEMS[index];
          const isFocused = state.index === index;
          const onPress = () => {
            const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
            if (!isFocused && !event.defaultPrevented) {
              if (Platform.OS !== "web") void Haptics.selectionAsync();
              navigation.navigate(route.name);
            }
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="tab"
              accessibilityState={{ selected: isFocused }}
              style={({ pressed }) => [styles.tabItem, pressed && styles.pressed]}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <View style={[styles.iconWrap, isFocused && { backgroundColor: colors.primaryDim }]}>
                <Ionicons name={(isFocused ? tab.iconFocused : tab.icon) as any} size={21} color={isFocused ? colors.primary : colors.tabInactive} />
                {isFocused && <View style={[styles.activeDot, { backgroundColor: colors.primary }]} />}
              </View>
              <Text style={[styles.tabLabel, { color: isFocused ? colors.primary : colors.tabInactive }]}>{t(tab.labelKey)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs tabBar={(props) => <CustomTabBar {...props} />} screenOptions={{ headerShown: false, animation: "fade" }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="profile" />
      <Tabs.Screen name="notifications" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  shell: { paddingTop: 8, paddingHorizontal: 14 },
  tabBar: { flexDirection: "row", borderWidth: 1, borderRadius: 24, paddingHorizontal: 8, paddingTop: 7, shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 8 },
  tabItem: { flex: 1, alignItems: "center", gap: 3, minHeight: 53 },
  pressed: { opacity: 0.68, transform: [{ scale: 0.97 }] },
  iconWrap: { width: 38, height: 30, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  activeDot: { position: "absolute", bottom: 1, width: 4, height: 4, borderRadius: 2 },
  tabLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.15 },
});

import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useTranslation } from "@/localization";
import { alpha, elevation, radius, spacing, type } from "@/constants/theme";

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
  const bottomPadding = Platform.OS === "web" ? spacing.md : Math.max(insets.bottom, spacing.md);

  return (
    <View style={[styles.shell, { paddingBottom: bottomPadding }]}>
      <View
        style={[
          styles.tabBar,
          { backgroundColor: colors.bgCard, borderColor: colors.border },
          elevation.lg,
        ]}
      >
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
              {/* Pastille pleine derrière l'onglet actif : repère plus lisible
                  qu'un simple changement de teinte, notamment en plein soleil. */}
              <View
                style={[
                  styles.iconWrap,
                  isFocused && { backgroundColor: colors.primary + alpha.f16 },
                ]}
              >
                <Ionicons
                  name={(isFocused ? tab.iconFocused : tab.icon) as any}
                  size={20}
                  color={isFocused ? colors.primary : colors.tabInactive}
                />
              </View>
              <Text
                style={[
                  type.micro,
                  { color: isFocused ? colors.primary : colors.tabInactive },
                ]}
                numberOfLines={1}
              >
                {t(tab.labelKey)}
              </Text>
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
  // La barre flotte au-dessus du contenu, sans fond plein ni filet supérieur :
  // le dégradé de l'écran reste visible en dessous, ce qui allège l'ensemble.
  shell: { paddingTop: spacing.sm, paddingHorizontal: spacing.lg, backgroundColor: "transparent" },
  tabBar: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: radius.xl,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  tabItem: { flex: 1, alignItems: "center", gap: spacing.xs, minHeight: 52 },
  pressed: { opacity: 0.68, transform: [{ scale: 0.97 }] },
  iconWrap: {
    width: 40,
    height: 30,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});

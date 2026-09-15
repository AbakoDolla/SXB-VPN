import { Tabs } from 'expo-router';
import TabDock from '@/components/ui/TabDock';
import { useColors } from '@/hooks/useColors';
import { useMotionPreference } from '@/hooks/useMotionPreference';

export default function TabLayout() {
  const colors = useColors();
  const { reduceMotion } = useMotionPreference();
  return (
    <Tabs
      tabBar={(props) => <TabDock {...props} />}
      screenOptions={{
        headerShown: false,
        animation: reduceMotion ? 'none' : 'fade',
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="profile" />
      <Tabs.Screen name="notifications" />
    </Tabs>
  );
}

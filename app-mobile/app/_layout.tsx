import React, { useEffect } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useFonts } from "expo-font";
import { Stack, router, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ThemeProvider, useThemeContext } from "@/contexts/ThemeContext";
import { AuthProvider, useAuthContext } from "@/contexts/AuthContext";
import { VpnProvider } from "@/contexts/VpnContext";
import { StatusBar } from "expo-status-bar";
import { syncAnnouncementNotifications } from "@/services/announcementNotifications";
import { syncPushTokenRegistration } from "@/services/pushNotifications";
import { useColors } from "@/hooks/useColors";
import { AppLockProvider } from "@/contexts/AppLockContext";
import { AppLockGate } from "@/components/AppLockGate";
import { PrivacyProvider, usePrivacy } from "@/contexts/PrivacyContext";
import PrivacyDisclosure from "@/components/PrivacyDisclosure";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 1000 * 60 * 3 },
  },
});

function AnnouncementNotificationSync() {
  const { isAuthenticated, deviceId } = useAuthContext();
  const { consent } = usePrivacy();

  useEffect(() => {
    if (!isAuthenticated || !consent.vpn || !consent.notifications) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) {
        timer = setInterval(() => { void syncAnnouncementNotifications(); }, 15 * 60_000);
      }
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === "active") {
      void syncAnnouncementNotifications();
      if (deviceId) {
        void syncPushTokenRegistration(deviceId).catch((error: any) => {
          console.warn("[Push] Enregistrement impossible:", error?.response?.status || error?.code || "NETWORK");
        });
      }
      start();
    }
    // Deux minutes réveillaient le réseau 720 fois par jour. Les annonces ne
    // sont pas un transport push : quinze minutes au premier plan, plus une
    // synchronisation immédiate à chaque retour dans l'app, donnent la même
    // expérience sans coût de veille.
    const foregroundSub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void syncAnnouncementNotifications();
        if (deviceId) {
          void syncPushTokenRegistration(deviceId).catch((error: any) => {
            console.warn("[Push] Enregistrement impossible:", error?.response?.status || error?.code || "NETWORK");
          });
        }
        start();
      } else {
        stop();
      }
    });
    return () => {
      stop();
      foregroundSub.remove();
    };
  }, [deviceId, isAuthenticated, consent.vpn, consent.notifications]);

  return null;
}

function RootLayoutNav() {
  const { colorScheme } = useThemeContext();
  const { isAuthenticated, isLoading } = useAuthContext();
  const segments = useSegments();
  const { consent } = usePrivacy();

  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    const firstSegment = segments[0] as string | undefined;
    const publicSegments = new Set(['index', 'onboarding', 'activate', 'privacy', '+not-found']);
    if (firstSegment && !publicSegments.has(firstSegment)) {
      router.replace('/activate');
    }
  }, [isAuthenticated, isLoading, segments]);

  useEffect(() => {
    if (consent.vpn && consent.notifications && Platform.OS === "android" && Platform.Version >= 33) {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
    }
  }, [consent.vpn, consent.notifications]);

  return (
    <>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <AnnouncementNotificationSync />
      <Stack screenOptions={{ headerShown: false, animation: "fade", contentStyle: { backgroundColor: colorScheme === "dark" ? "#07101F" : "#F4F8FC" } }}>
        <Stack.Screen name="index" options={{ animation: "fade" }} />
        <Stack.Screen name="onboarding" options={{ animation: "fade", gestureEnabled: false }} />
        <Stack.Screen name="activate" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="privacy" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="plan" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
                <Stack.Screen name="support" options={{
          headerShown: true,
          animation: "slide_from_right",
          headerTitle: "Support",
          headerStyle: { backgroundColor: colorScheme === "dark" ? "#07101F" : "#F4F8FC" },
          headerTintColor: colorScheme === "dark" ? "#F6FAFF" : "#102033",
        }} />
                <Stack.Screen name="settings" options={{
          headerShown: false,
          animation: "slide_from_right",
          headerTitle: "Paramètres",
          headerStyle: { backgroundColor: colorScheme === "dark" ? "#07101F" : "#F4F8FC" },
          headerTintColor: colorScheme === "dark" ? "#F6FAFF" : "#102033",
        }} />
        <Stack.Screen name="+not-found" />
      </Stack>
    </>
  );
}

function ThemedAppShell() {
  const colors = useColors();
  const { consent, loading } = usePrivacy();
  if (loading || !consent.vpn) return <PrivacyDisclosure />;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <VpnProvider>
        <AppLockProvider>
          <AppLockGate>
            <RootLayoutNav />
          </AppLockGate>
        </AppLockProvider>
      </VpnProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular: require("../assets/fonts/Inter_400Regular.ttf"),
    Inter_500Medium: require("../assets/fonts/Inter_500Medium.ttf"),
    Inter_600SemiBold: require("../assets/fonts/Inter_600SemiBold.ttf"),
    Inter_700Bold: require("../assets/fonts/Inter_700Bold.ttf"),
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <LanguageProvider>
            <ThemeProvider>
              <PrivacyProvider>
                <AuthProvider>
                  <ThemedAppShell />
                </AuthProvider>
              </PrivacyProvider>
            </ThemeProvider>
          </LanguageProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

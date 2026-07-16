import React, { useEffect } from 'react';
import { installCrashLogger } from '@/services/crashLogger';

// Installé en tout premier, avant tout autre import/provider, pour
// capturer les crashs le plus tôt possible dans le cycle de vie.
installCrashLogger();
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AuthProvider } from '@/contexts/AuthContext';
import { VpnProvider } from '@/contexts/VpnContext';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 1000 * 60 * 3 },
  },
});

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="index" options={{ animation: 'fade' }} />
      <Stack.Screen name="onboarding" options={{ animation: 'fade', gestureEnabled: false }} />
      <Stack.Screen name="activate" options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="plan"
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="support"
        options={{
          headerShown: true,
          animation: 'slide_from_right',
          headerTitle: 'Support',
          headerBackTitle: 'Retour',
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          headerShown: true,
          animation: 'slide_from_right',
          headerTitle: 'Paramètres',
          headerBackTitle: 'Retour',
        }}
      />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular: require('@/assets/fonts/Inter_400Regular.ttf'),
    Inter_500Medium: require('@/assets/fonts/Inter_500Medium.ttf'),
    Inter_600SemiBold: require('@/assets/fonts/Inter_600SemiBold.ttf'),
    Inter_700Bold: require('@/assets/fonts/Inter_700Bold.ttf'),
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
              <AuthProvider>
                <GestureHandlerRootView style={{ flex: 1 }}>
                  <KeyboardProvider>
                    <VpnProvider>
                      <RootLayoutNav />
                    </VpnProvider>
                  </KeyboardProvider>
                </GestureHandlerRootView>
              </AuthProvider>
            </ThemeProvider>
          </LanguageProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

import React, { useCallback } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuthContext } from '@/contexts/AuthContext';
import { useVpnContext } from '@/contexts/VpnContext';
import AppHeader from '@/components/AppHeader';
import SmartButton from '@/components/SmartButton';
import VpnStatusCard from '@/components/VpnStatusCard';
import SubscriptionCard from '@/components/SubscriptionCard';
import type { SmartButtonState } from '@/types/api';

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { accountState, refreshAccountState } = useAuthContext();
  const { isConnected, isConnecting, connect, disconnect } = useVpnContext();
  const [refreshing, setRefreshing] = React.useState(false);

  const getSmartButtonState = useCallback((): SmartButtonState => {
    if (!accountState) return 'no_account';
    if (accountState.state === 'suspended') return 'suspended';
    if (accountState.state === 'expired') return 'expired';
    if (accountState.state === 'no_package') return 'no_package';
    if (isConnecting) return isConnected ? 'disconnecting' : 'connecting';
    if (isConnected) return 'connected';
    return 'connect';
  }, [accountState, isConnected, isConnecting]);

  const handlePress = useCallback(async () => {
    const st = getSmartButtonState();
    switch (st) {
      case 'no_account': router.push('/activate'); break;
      case 'no_package': case 'expired': router.push('/plan'); break;
      case 'connect': await connect(); break;
      case 'connected': await disconnect(); break;
      case 'suspended': router.push('/support'); break;
    }
  }, [getSmartButtonState, connect, disconnect]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshAccountState();
    setRefreshing(false);
  };

  const bgColors: [string, string, string] = colors.background === '#080B14'
    ? ['#080B14', '#0D1530', '#080B14']
    : ['#F0F4FF', '#E4EAF8', '#F0F4FF'];

  return (
    <LinearGradient colors={bgColors} style={styles.container}>
      {/* Background glow */}
      <View
        style={[
          styles.bgGlow,
          {
            backgroundColor: isConnected ? colors.connected : colors.primary,
          },
        ]}
      />

      <AppHeader />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 80 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {/* VPN Status */}
        <VpnStatusCard isConnected={isConnected} isConnecting={isConnecting} />

        {/* Smart Button — centered hero */}
        <View style={styles.buttonSection}>
          <SmartButton
            state={getSmartButtonState()}
            onPress={handlePress}
          />
        </View>

        {/* Subscription Card */}
        {accountState && accountState.state !== 'no_package' && (
          <SubscriptionCard accountState={accountState} />
        )}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bgGlow: {
    position: 'absolute',
    width: 300,
    height: 300,
    borderRadius: 150,
    top: -80,
    alignSelf: 'center',
    opacity: 0.05,
  },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 16,
  },
  buttonSection: {
    alignItems: 'center',
    paddingVertical: 24,
  },
});

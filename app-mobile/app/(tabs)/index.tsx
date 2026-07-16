import React, { useCallback, useState } from 'react';
import {
  Clipboard, Modal, Pressable, RefreshControl,
  ScrollView, Share, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
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

const PROTO_COLORS: Record<string, string> = {
  VLESS: '#00B4FF', VMess: '#A855F7', Trojan: '#F97316',
  Shadowsocks: '#EAB308', Hysteria2: '#EC4899',
  SSH: '#10B981', 'SSH+Payload': '#06B6D4',
};

function ProtocolChip({ name, active, onPress }: { name: string; active: boolean; onPress: () => void }) {
  const color = PROTO_COLORS[name] || '#6B7280';
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75}
      style={[styles.chip, active && { borderColor: color, backgroundColor: color + '22' }]}>
      <View style={[styles.chipDot, { backgroundColor: active ? color : '#374151' }]} />
      <Text style={[styles.chipText, active && { color }]}>{name}</Text>
    </TouchableOpacity>
  );
}

function SubModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { Clipboard.setString(url); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const share = () => Share.share({ message: url, title: 'SXB VPN — Config' });
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.sheetTitle}>Lien d'''Abonnement</Text>
          <Text style={styles.sheetSub}>Importez dans Sing-box, V2Ray, NekoBox ou Clash</Text>
          <View style={styles.urlBox}><Text style={styles.urlText} numberOfLines={4}>{url}</Text></View>
          <View style={styles.sheetBtns}>
            <TouchableOpacity style={styles.btnPrimary} onPress={copy} activeOpacity={0.8}>
              <Text style={styles.btnPrimaryText}>{copied ? '✓ Copié !' : 'Copier l'''URL'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnSecondary} onPress={share} activeOpacity={0.8}>
              <Text style={styles.btnSecondaryText}>Partager</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sheetApps}>Compatible : Sing-box · V2Ray · NekoBox · Clash · Shadowrocket</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { accountState, refreshAccountState } = useAuthContext();
  const {
    isConnected, isConnecting, connect, disconnect,
    selectedProtocol, availableProtocols, subscriptionUrl, selectProtocol,
  } = useVpnContext();
  const [refreshing, setRefreshing] = useState(false);
  const [showSub, setShowSub] = useState(false);

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
    switch (getSmartButtonState()) {
      case 'no_account':  router.push('/activate'); break;
      case 'no_package':
      case 'expired':     router.push('/plan');     break;
      case 'connect':     await connect();           break;
      case 'connected':   await disconnect();        break;
      case 'suspended':   router.push('/support');   break;
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

  const selectedProto = availableProtocols.find(p => p.name === selectedProtocol);
  const protoColor = selectedProtocol ? (PROTO_COLORS[selectedProtocol] || '#6B7280') : '#6B7280';

  return (
    <LinearGradient colors={bgColors} style={styles.container}>
      <View style={[styles.bgGlow, { backgroundColor: isConnected ? colors.connected : colors.primary }]} />
      <AppHeader />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />}
      >
        <VpnStatusCard isConnected={isConnected} isConnecting={isConnecting} />
        <View style={styles.buttonSection}>
          <SmartButton state={getSmartButtonState()} onPress={handlePress} />
        </View>
        {accountState && accountState.state !== 'no_package' && (
          <SubscriptionCard accountState={accountState} />
        )}

        {/* Protocol Selector */}
        {availableProtocols.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>PROTOCOLE VPN</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {availableProtocols.map(p => (
                <ProtocolChip key={p.name} name={p.name} active={selectedProtocol === p.name} onPress={() => selectProtocol(p.name)} />
              ))}
            </ScrollView>
            {selectedProto && (
              <View style={[styles.protoInfo, { borderColor: protoColor + '33' }]}>
                {[['Protocole', selectedProto.name, protoColor], ['Port', String(selectedProto.port), '#E5E7EB'],
                  ['Transport', selectedProto.transport, '#E5E7EB'], ['Sécurité', selectedProto.security, '#E5E7EB']].map(([label, value, color]) => (
                  <View key={label} style={styles.protoRow}>
                    <Text style={styles.protoLabel}>{label}</Text>
                    <Text style={[styles.protoValue, { color }]}>{value}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Subscription URL */}
        {subscriptionUrl && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>CONFIGURATION</Text>
            <TouchableOpacity style={styles.subCard} onPress={() => setShowSub(true)} activeOpacity={0.85}>
              <Text style={styles.subIcon}>🔗</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.subTitle}>URL d'''Abonnement</Text>
                <Text style={styles.subHint}>Copier pour V2Ray · Sing-box · NekoBox</Text>
              </View>
              <Text style={styles.subArrow}>›</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
      {showSub && subscriptionUrl && <SubModal url={subscriptionUrl} onClose={() => setShowSub(false)} />}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bgGlow: { position: 'absolute', width: 300, height: 300, borderRadius: 150, top: -80, alignSelf: 'center', opacity: 0.05 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 8, gap: 16 },
  buttonSection: { alignItems: 'center', paddingVertical: 24 },
  section: { gap: 8 },
  sectionLabel: { fontSize: 10, fontWeight: '700', color: '#4B6A9A', letterSpacing: 1.5, fontFamily: 'Inter_700Bold' },
  chipRow: { gap: 8, paddingVertical: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: '#1F2937', backgroundColor: '#0D1117' },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: 12, fontWeight: '600', color: '#6B7280', fontFamily: 'Inter_600SemiBold' },
  protoInfo: { backgroundColor: '#0D1117', borderRadius: 12, borderWidth: 1, padding: 12, gap: 8, marginTop: 4 },
  protoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  protoLabel: { fontSize: 12, color: '#6B7280', fontFamily: 'Inter_400Regular' },
  protoValue: { fontSize: 12, fontWeight: '600', fontFamily: 'Inter_600SemiBold' },
  subCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0D1117', borderRadius: 14, borderWidth: 1, borderColor: '#1F2937', padding: 14 },
  subIcon: { fontSize: 22 },
  subTitle: { fontSize: 14, fontWeight: '600', color: '#E5E7EB', fontFamily: 'Inter_600SemiBold' },
  subHint: { fontSize: 11, color: '#6B7280', marginTop: 2, fontFamily: 'Inter_400Regular' },
  subArrow: { fontSize: 22, color: '#374151' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#0F1520', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, gap: 12 },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF', fontFamily: 'Inter_700Bold' },
  sheetSub: { fontSize: 13, color: '#6B7280', fontFamily: 'Inter_400Regular' },
  urlBox: { backgroundColor: '#070B14', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#1E3A5F' },
  urlText: { fontSize: 12, color: '#60A5FA', fontFamily: 'Inter_400Regular', lineHeight: 18 },
  sheetBtns: { flexDirection: 'row', gap: 10 },
  btnPrimary: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: '#1D4ED8', alignItems: 'center' },
  btnPrimaryText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF', fontFamily: 'Inter_600SemiBold' },
  btnSecondary: { flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: '#1F2937', alignItems: 'center' },
  btnSecondaryText: { fontSize: 14, fontWeight: '600', color: '#9CA3AF', fontFamily: 'Inter_600SemiBold' },
  sheetApps: { fontSize: 11, color: '#374151', textAlign: 'center', fontFamily: 'Inter_400Regular' },
});

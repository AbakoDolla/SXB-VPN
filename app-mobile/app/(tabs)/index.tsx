import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  Animated,
  StatusBar,
  RefreshControl,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useVpnContext } from '@/contexts/VpnContext';
import { useAuthContext } from '@/contexts/AuthContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '@/services/apiClient';
import AnnouncementModal from '@/components/AnnouncementModal';

const { width } = Dimensions.get('window');

interface VpnConnection {
  id: string;
  name: string;
  protocol: string;
  status: 'active' | 'inactive';
  config: any;
}

export default function HomeScreen() {
  const {
    vpnState,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    trafficStats,
    refreshVpnConfig,
  } = useVpnContext();

  const { accountState, refreshAccountState } = useAuthContext();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [ping, setPing] = useState<number | null>(null);
  const [connectedIp, setConnectedIp] = useState<string>("—");
  const [lastConnection, setLastConnection] = useState<string>("—");
  const [connections, setConnections] = useState<VpnConnection[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [activeAnnouncement, setActiveAnnouncement] = useState<any>(null);

  const checkAnnouncements = useCallback(async () => {
    try {
      const res = await apiClient.get('/mobile/notifications');
      const data = Array.isArray(res.data) ? res.data : [];
      const ann = data.find((n: any) => n.isAnnouncement && n.type === 'critical');
      if (ann) {
        const seenStr = await AsyncStorage.getItem('@sxb_seen_announcements');
        const seenIds = JSON.parse(seenStr || '[]');
        if (!seenIds.includes(ann.id)) {
          setActiveAnnouncement(ann);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    let timerId: ReturnType<typeof setInterval>;
    if (isConnected) {
      const measurePing = async () => {
        const start = Date.now();
        try {
          await apiClient.get("/health", { timeout: 4000 });
          setPing(Date.now() - start);
        } catch {
          setPing(null);
        }
      };
      measurePing();
      timerId = setInterval(measurePing, 10_000);
    } else {
      setPing(null);
    }
    return () => clearInterval(timerId);
  }, [isConnected]);

  useEffect(() => {
    if (isConnected) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      fetch("https://api.ipify.org?format=json", { signal: controller.signal })
        .then(res => res.json())
        .then((data: any) => {
          clearTimeout(timeoutId);
          setConnectedIp(data?.ip || "—");
        })
        .catch(() => setConnectedIp("—"));
    } else {
      setConnectedIp("—");
    }
  }, [isConnected]);

  useEffect(() => {
    if (isConnected) {
      const nowStr = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      setLastConnection(nowStr);
      AsyncStorage.setItem("@last_conn_time", nowStr).catch(() => {});
    }
  }, [isConnected]);

  useEffect(() => {
    AsyncStorage.getItem("@last_conn_time").then(t => {
      if (t) setLastConnection(t);
    });
  }, []);

  const fetchConnections = useCallback(async () => {
    try {
      setConnectionsLoading(true);
      const res = await apiClient.get("/mobile/connections");
      const conns: VpnConnection[] = res.data?.connections || [];
      setConnections(conns);
    } catch {
      // ignore
    } finally {
      setConnectionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
    checkAnnouncements();
  }, [fetchConnections, checkAnnouncements]);

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await Promise.all([refreshVpnConfig(), refreshAccountState(), fetchConnections()]);
    } catch (_) {
    } finally {
      setIsRefreshing(false);
    }
  };

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isConnecting) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.2, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isConnecting]);

  const getStatusColor = () => {
    if (isConnected) return '#10B981';
    if (isConnecting) return '#F59E0B';
    if (vpnState === 'handshaking') return '#3B82F6';
    return '#6B7280';
  };

  const getStatusText = () => {
    if (isConnected) return 'Connecté';
    if (isConnecting) return 'Connexion...';
    if (vpnState === 'handshaking') return 'Handshake...';
    return 'Déconnecté';
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={['#0F172A', '#1E293B']} style={styles.gradient}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor="#3B82F6" />
          }
        >
          <View style={styles.header}>
            <View>
              <Text style={styles.welcomeText}>SXB VPN</Text>
              <Text style={styles.subWelcome}>Sécurisé & Illimité</Text>
            </View>
            <TouchableOpacity style={styles.profileButton}>
              <Ionicons name="person-circle-outline" size={32} color="#3B82F6" />
            </TouchableOpacity>
          </View>

          <View style={styles.statusCard}>
            <Animated.View style={[styles.pulseCircle, { transform: [{ scale: pulseAnim }], borderColor: getStatusColor() }]} />
            <TouchableOpacity
              onPress={isConnected ? disconnect : connect}
              disabled={isConnecting}
              style={[styles.connectButton, { backgroundColor: getStatusColor() }]}
            >
              <Ionicons name={isConnected ? "stop" : "power"} size={48} color="white" />
            </TouchableOpacity>
            <Text style={[styles.statusLabel, { color: getStatusColor() }]}>{getStatusText()}</Text>
          </View>

          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Ionicons name="arrow-down" size={20} color="#10B981" />
              <Text style={styles.statValue}>{(trafficStats.downloadSpeed / 1024).toFixed(1)} KB/s</Text>
              <Text style={styles.statLabel}>Download</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Ionicons name="arrow-up" size={20} color="#3B82F6" />
              <Text style={styles.statValue}>{(trafficStats.uploadSpeed / 1024).toFixed(1)} KB/s</Text>
              <Text style={styles.statLabel}>Upload</Text>
            </View>
          </View>

          <View style={styles.infoSection}>
            <Text style={styles.sectionTitle}>Détails de connexion</Text>
            <View style={styles.infoCard}>
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Adresse IP</Text>
                <Text style={styles.infoValue}>{connectedIp}</Text>
              </View>
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Ping</Text>
                <Text style={styles.infoValue}>{ping ? `${ping}ms` : '—'}</Text>
              </View>
              <View style={styles.infoItem}>
                <Text style={styles.infoLabel}>Dernière session</Text>
                <Text style={styles.infoValue}>{lastConnection}</Text>
              </View>
            </View>
          </View>
        </ScrollView>
      </LinearGradient>

      {activeAnnouncement && (
        <AnnouncementModal
          announcement={activeAnnouncement}
          onClose={async () => {
            const seenStr = await AsyncStorage.getItem('@sxb_seen_announcements');
            const seenIds = JSON.parse(seenStr || '[]');
            seenIds.push(activeAnnouncement.id);
            await AsyncStorage.setItem('@sxb_seen_announcements', JSON.stringify(seenIds));
            setActiveAnnouncement(null);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  gradient: { flex: 1 },
  scrollContent: { padding: 20, paddingTop: 60 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 40 },
  welcomeText: { color: 'white', fontSize: 24, fontWeight: 'bold' },
  subWelcome: { color: '#94A3B8', fontSize: 14 },
  profileButton: { padding: 4 },
  statusCard: { alignItems: 'center', marginBottom: 40, position: 'relative' },
  pulseCircle: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    top: -10,
  },
  connectButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  statusLabel: { marginTop: 20, fontSize: 18, fontWeight: '600' },
  statsRow: {
    flexDirection: 'row',
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 20,
    justifyContent: 'space-around',
    alignItems: 'center',
    marginBottom: 30,
  },
  statItem: { alignItems: 'center' },
  statValue: { color: 'white', fontSize: 16, fontWeight: 'bold', marginVertical: 4 },
  statLabel: { color: '#94A3B8', fontSize: 12 },
  statDivider: { width: 1, height: 40, backgroundColor: '#334155' },
  infoSection: { marginBottom: 30 },
  sectionTitle: { color: 'white', fontSize: 18, fontWeight: 'bold', marginBottom: 15 },
  infoCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 20 },
  infoItem: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  infoLabel: { color: '#94A3B8', fontSize: 14 },
  infoValue: { color: 'white', fontSize: 14, fontWeight: '500' },
});

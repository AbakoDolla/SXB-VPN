import React, { useEffect, useRef } from 'react';
import { Animated, Image, Platform, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useAuthContext } from '@/contexts/AuthContext';
import { getLastCrash, clearLastCrash } from '@/services/crashLogger';

const LOGO = require('@/assets/images/icon.png');
const USE_NATIVE = Platform.OS !== 'web';

export default function SplashScreen() {
  const { isLoading, isAuthenticated, hasSeenOnboarding } = useAuthContext();

  // Animation values
  const logoOpacity   = useRef(new Animated.Value(0)).current;
  const logoScale     = useRef(new Animated.Value(0.55)).current;
  const titleOpacity  = useRef(new Animated.Value(0)).current;
  const titleY        = useRef(new Animated.Value(24)).current;
  const tagOpacity    = useRef(new Animated.Value(0)).current;
  const brandOpacity  = useRef(new Animated.Value(0)).current;
  const ring1Scale    = useRef(new Animated.Value(0.2)).current;
  const ring1Opacity  = useRef(new Animated.Value(0)).current;
  const ring2Scale    = useRef(new Animated.Value(0.2)).current;
  const ring2Opacity  = useRef(new Animated.Value(0)).current;
  const ring3Scale    = useRef(new Animated.Value(0.2)).current;
  const ring3Opacity  = useRef(new Animated.Value(0)).current;
  const glowOpacity   = useRef(new Animated.Value(0)).current;

  const hasRedirected = useRef(false);
  const [crashLog, setCrashLog] = React.useState<string | null>(null);

  useEffect(() => {
    getLastCrash().then((log) => {
      if (log) setCrashLog(log);
    });
  }, []);

  useEffect(() => {
    // Pulsing ring animation
    const pulseRing = (scale: Animated.Value, opacity: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(scale,   { toValue: 2.2, duration: 2400, useNativeDriver: USE_NATIVE }),
            Animated.sequence([
              Animated.timing(opacity, { toValue: 0.35, duration: 200, useNativeDriver: USE_NATIVE }),
              Animated.timing(opacity, { toValue: 0,    duration: 2200, useNativeDriver: USE_NATIVE }),
            ]),
          ]),
          Animated.parallel([
            Animated.timing(scale,   { toValue: 0.2, duration: 0, useNativeDriver: USE_NATIVE }),
          ]),
        ])
      ).start();
    };

    // Glow pulse
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowOpacity, { toValue: 0.18, duration: 1800, useNativeDriver: USE_NATIVE }),
        Animated.timing(glowOpacity, { toValue: 0.06, duration: 1800, useNativeDriver: USE_NATIVE }),
      ])
    ).start();

    // Main entry animation
    Animated.sequence([
      // 1. Logo pops in
      Animated.parallel([
        Animated.timing(logoOpacity, { toValue: 1, duration: 500, useNativeDriver: USE_NATIVE }),
        Animated.spring(logoScale,   { toValue: 1, tension: 55, friction: 6, useNativeDriver: USE_NATIVE }),
      ]),
      // 2. Title slides up
      Animated.parallel([
        Animated.timing(titleOpacity, { toValue: 1, duration: 450, useNativeDriver: USE_NATIVE }),
        Animated.timing(titleY,       { toValue: 0, duration: 450, useNativeDriver: USE_NATIVE }),
      ]),
      // 3. Tagline
      Animated.timing(tagOpacity, { toValue: 1, duration: 350, useNativeDriver: USE_NATIVE }),
      // 4. Brand
      Animated.delay(300),
      Animated.timing(brandOpacity, { toValue: 1, duration: 600, useNativeDriver: USE_NATIVE }),
    ]).start();

    // Staggered rings
    setTimeout(() => pulseRing(ring1Scale, ring1Opacity, 0),    300);
    setTimeout(() => pulseRing(ring2Scale, ring2Opacity, 0),    1100);
    setTimeout(() => pulseRing(ring3Scale, ring3Opacity, 0),    2000);
  }, []);

  useEffect(() => {
    if (!isLoading && !hasRedirected.current) {
      hasRedirected.current = true;
      const delay = setTimeout(() => {
        if (isAuthenticated) {
          router.replace('/(tabs)/');
        } else if (!hasSeenOnboarding) {
          router.replace('/onboarding');
        } else {
          router.replace('/activate');
        }
      }, 2800);
      return () => clearTimeout(delay);
    }
  }, [isLoading, isAuthenticated, hasSeenOnboarding]);

  return (
    <LinearGradient colors={['#050810', '#0A1530', '#050810']} style={styles.container}>

      {/* Glow orb behind logo */}
      <Animated.View style={[styles.glow, { opacity: glowOpacity }]} />

      {/* Pulse rings */}
      <Animated.View style={[styles.ring, { opacity: ring1Opacity, transform: [{ scale: ring1Scale }] }]} />
      <Animated.View style={[styles.ring, styles.ring2, { opacity: ring2Opacity, transform: [{ scale: ring2Scale }] }]} />
      <Animated.View style={[styles.ring, styles.ring3, { opacity: ring3Opacity, transform: [{ scale: ring3Scale }] }]} />

      {/* Content */}
      <View style={styles.content}>
        {/* Logo */}
        <Animated.View style={[styles.logoWrap, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}>
          <View style={styles.logoBg} />
          <Image source={LOGO} style={styles.logo} resizeMode="contain" />
        </Animated.View>

        {/* SXB VPN title */}
        <Animated.Text
          style={[styles.title, { opacity: titleOpacity, transform: [{ translateY: titleY }] }]}
        >
          SXB VPN
        </Animated.Text>

        {/* Tagline */}
        <Animated.Text style={[styles.tagline, { opacity: tagOpacity }]}>
          Protection · Vitesse · Liberté
        </Animated.Text>
      </View>

      {/* Bottom brand */}
      <Animated.View style={[styles.brandWrap, { opacity: brandOpacity }]}>
        <View style={styles.brandLine} />
        <Text style={styles.brand}>by StuffxBilal</Text>
        <View style={styles.brandLine} />
      </Animated.View>

      {/* Loading dots */}
      {isLoading && (
        <View style={styles.loadingWrap}>
          <View style={[styles.dot, styles.dot1]} />
          <View style={[styles.dot, styles.dot2]} />
          <View style={[styles.dot, styles.dot3]} />
        </View>
      )}

      {/* Crash précédent (si l'app a planté au lancement précédent) */}
      {crashLog && (
        <View style={styles.crashBox} pointerEvents="box-none">
          <Text style={styles.crashTitle}>Dernier crash détecté :</Text>
          <Text selectable style={styles.crashText}>{crashLog}</Text>
          <Text
            style={styles.crashDismiss}
            onPress={() => { clearLastCrash(); setCrashLog(null); }}
          >
            [ Fermer ]
          </Text>
        </View>
      )}
    </LinearGradient>
  );
}

const RING_BASE = 220;
const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  glow: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#0055CC',
    alignSelf: 'center',
    top: '50%',
    marginTop: -140,
  },

  ring: {
    position: 'absolute',
    width: RING_BASE,
    height: RING_BASE,
    borderRadius: RING_BASE / 2,
    borderWidth: 1,
    borderColor: '#007AFF',
    alignSelf: 'center',
    top: '50%',
    marginTop: -(RING_BASE / 2 + 30),
  },
  ring2: { width: RING_BASE + 40, height: RING_BASE + 40, borderRadius: (RING_BASE + 40) / 2, borderColor: '#0055CC', marginTop: -(RING_BASE / 2 + 50) },
  ring3: { width: RING_BASE - 30, height: RING_BASE - 30, borderRadius: (RING_BASE - 30) / 2, borderColor: '#00B4FF', marginTop: -(RING_BASE / 2 + 15) },

  content: { alignItems: 'center', gap: 14 },

  logoWrap: { alignItems: 'center', justifyContent: 'center', position: 'relative', marginBottom: 8 },
  logoBg: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: '#003399',
    opacity: 0.2,
  },
  logo: { width: 130, height: 130 },

  title: {
    fontSize: 42,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 8,
    fontFamily: 'Inter_700Bold',
  },

  tagline: {
    fontSize: 13,
    color: '#4B6A9A',
    letterSpacing: 1.2,
    fontFamily: 'Inter_400Regular',
  },

  brandWrap: {
    position: 'absolute',
    bottom: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandLine: { width: 30, height: 0.5, backgroundColor: '#1E2E45' },
  brand: {
    fontSize: 11,
    color: '#1E3050',
    letterSpacing: 2,
    fontFamily: 'Inter_400Regular',
    textTransform: 'uppercase',
  },

  loadingWrap: {
    position: 'absolute',
    bottom: 100,
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#007AFF',
    opacity: 0.6,
  },
  dot1: {},
  dot2: { opacity: 0.4 },
  dot3: { opacity: 0.2 },

  crashBox: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    maxHeight: '55%',
    backgroundColor: 'rgba(20,0,0,0.92)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FF4444',
    padding: 14,
  },
  crashTitle: { color: '#FF6666', fontWeight: '700', fontSize: 13, marginBottom: 8 },
  crashText: { color: '#FFCCCC', fontSize: 10, fontFamily: 'monospace' },
  crashDismiss: { color: '#FF9999', fontSize: 12, marginTop: 10, textAlign: 'right' },
});

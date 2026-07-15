import React, { useEffect, useRef } from 'react';
import { Animated, Image, Platform, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useAuthContext } from '@/contexts/AuthContext';

const LOGO = require('@/assets/images/icon.png');
const USE_NATIVE = Platform.OS !== 'web';

export default function SplashScreen() {
  const { isLoading, isAuthenticated, hasSeenOnboarding } = useAuthContext();
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.7)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const hasRedirected = useRef(false);

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 700,
          useNativeDriver: USE_NATIVE,
        }),
        Animated.spring(logoScale, {
          toValue: 1,
          tension: 70,
          friction: 7,
          useNativeDriver: USE_NATIVE,
        }),
      ]),
      Animated.timing(textOpacity, {
        toValue: 1,
        duration: 500,
        useNativeDriver: USE_NATIVE,
      }),
    ]).start();
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
      }, 2000);
      return () => clearTimeout(delay);
    }
  }, [isLoading, isAuthenticated, hasSeenOnboarding]);

  return (
    <LinearGradient colors={['#080B14', '#0A1228', '#080B14']} style={styles.container}>
      {/* Background glow circles */}
      <View style={styles.bgCircle1} />
      <View style={styles.bgCircle2} />

      {/* Logo */}
      <Animated.View
        style={[
          styles.logoWrapper,
          {
            opacity: logoOpacity,
            transform: [{ scale: logoScale }],
          },
        ]}
      >
        <Image source={LOGO} style={styles.logo} resizeMode="contain" />
      </Animated.View>

      {/* Text */}
      <Animated.View style={[styles.textBlock, { opacity: textOpacity }]}>
        <Text style={styles.appName}>SXB VPN</Text>
        <Text style={styles.tagline}>Naviguez en sécurité</Text>
      </Animated.View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 32,
  },
  bgCircle1: {
    position: 'absolute',
    width: 380,
    height: 380,
    borderRadius: 190,
    backgroundColor: '#1A3A7A',
    opacity: 0.12,
    top: -100,
    right: -100,
  },
  bgCircle2: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: '#005B8A',
    opacity: 0.1,
    bottom: -60,
    left: -60,
  },
  logoWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 160,
    height: 160,
  },
  textBlock: {
    alignItems: 'center',
    gap: 6,
  },
  appName: {
    fontSize: 36,
    fontWeight: '700',
    color: '#F0F4FF',
    letterSpacing: 4,
    fontFamily: 'Inter_700Bold',
  },
  tagline: {
    fontSize: 15,
    color: '#6B82A8',
    letterSpacing: 0.5,
    fontFamily: 'Inter_400Regular',
  },
});

import React, { useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuthContext } from '@/contexts/AuthContext';
import { useTranslation } from '@/localization';

const { width } = Dimensions.get('window');

function Shield1() {
  return (
    <Svg width={160} height={160} viewBox="0 0 160 160">
      <Path d="M80 12 L148 40 L148 90 C148 124 116 148 80 156 C44 148 12 124 12 90 L12 40 Z" fill="none" stroke="#5B8DEF" strokeWidth={3} />
      <Path d="M80 24 L136 48 L136 88 C136 118 110 140 80 148 C50 140 24 118 24 88 L24 48 Z" fill="rgba(91,141,239,0.1)" />
      <Path d="M52 82 L72 102 L110 64" stroke="#00E5A0" strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Shield2() {
  return (
    <Svg width={160} height={160} viewBox="0 0 160 160">
      <Rect x="20" y="30" width="120" height="100" rx="16" fill="rgba(91,141,239,0.1)" stroke="#5B8DEF" strokeWidth={2} />
      <Rect x="40" y="60" width="80" height="12" rx="6" fill="#5B8DEF" opacity={0.5} />
      <Rect x="40" y="82" width="55" height="10" rx="5" fill="#5B8DEF" opacity={0.3} />
      <Circle cx="130" cy="50" r="20" fill="#00E5A0" opacity={0.9} />
      <Path d="M122 50 L128 56 L138 44" stroke="white" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Shield3() {
  return (
    <Svg width={160} height={160} viewBox="0 0 160 160">
      <Rect x="30" y="20" width="100" height="120" rx="12" fill="rgba(91,141,239,0.08)" stroke="#5B8DEF" strokeWidth={2} />
      <Path d="M30 60 L130 60" stroke="#1E2A4A" strokeWidth={1} />
      <Circle cx="55" cy="85" r="14" fill="rgba(0,229,160,0.2)" stroke="#00E5A0" strokeWidth={1.5} />
      <Path d="M50 85 L54 89 L61 80" stroke="#00E5A0" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <Rect x="75" y="79" width="42" height="8" rx="4" fill="#1E2A4A" />
      <Rect x="75" y="91" width="28" height="7" rx="3.5" fill="#1E2A4A" />
      <Circle cx="80" cy="40" r="16" fill="rgba(91,141,239,0.2)" stroke="#5B8DEF" strokeWidth={1.5} />
      <Path d="M74 40 L79 45 L87 33" stroke="#5B8DEF" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Shield4() {
  return (
    <Svg width={160} height={160} viewBox="0 0 160 160">
      <Circle cx="80" cy="80" r="60" fill="rgba(0,229,160,0.08)" stroke="#00E5A0" strokeWidth={2} />
      <Circle cx="80" cy="80" r="44" fill="rgba(0,229,160,0.12)" />
      <Path d="M56 80 L72 96 L106 62" stroke="#00E5A0" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const Illustrations = [Shield1, Shield2, Shield3, Shield4];

export default function OnboardingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { markOnboardingDone } = useAuthContext();
  const { t } = useTranslation();
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  const dotAnim = useRef(new Animated.Value(0)).current;

  const slides = [
    { title: t('onboarding_title_1'), desc: t('onboarding_desc_1'), Illus: Illustrations[0] },
    { title: t('onboarding_title_2'), desc: t('onboarding_desc_2'), Illus: Illustrations[1] },
    { title: t('onboarding_title_3'), desc: t('onboarding_desc_3'), Illus: Illustrations[2] },
    { title: t('onboarding_title_4'), desc: t('onboarding_desc_4'), Illus: Illustrations[3] },
  ];

  const isLast = currentIndex === slides.length - 1;

  const handleNext = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isLast) {
      await markOnboardingDone();
      router.replace('/activate');
    } else {
      const next = currentIndex + 1;
      flatListRef.current?.scrollToIndex({ index: next, animated: true });
      setCurrentIndex(next);
    }
  };

  const handleSkip = async () => {
    await markOnboardingDone();
    router.replace('/activate');
  };

  return (
    <LinearGradient colors={['#080B14', '#0D1530', '#080B14']} style={styles.container}>
      {/* Skip */}
      <View style={[styles.topBar, { paddingTop: insets.top + 16 }]}>
        {!isLast ? (
          <Pressable onPress={handleSkip} style={styles.skipBtn}>
            <Text style={[styles.skipText, { color: colors.mutedForeground }]}>{t('skip')}</Text>
          </Pressable>
        ) : (
          <View />
        )}
      </View>

      {/* Slides */}
      <FlatList
        ref={flatListRef}
        data={slides}
        keyExtractor={(_, i) => String(i)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        renderItem={({ item }) => {
          const { Illus } = item;
          return (
            <View style={[styles.slide, { width }]}>
              <View style={styles.illusWrap}>
                <Illus />
              </View>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={[styles.desc, { color: colors.mutedForeground }]}>{item.desc}</Text>
            </View>
          );
        }}
      />

      {/* Dots */}
      <View style={styles.dotsRow}>
        {slides.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i === currentIndex ? colors.primary : colors.border,
                width: i === currentIndex ? 24 : 8,
              },
            ]}
          />
        ))}
      </View>

      {/* CTA */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 32 }]}>
        <Pressable
          onPress={handleNext}
          style={[styles.cta, { backgroundColor: isLast ? colors.connected : colors.primary }]}
        >
          <Text style={styles.ctaText}>{isLast ? t('start') : t('next')}</Text>
        </Pressable>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    paddingHorizontal: 24,
    alignItems: 'flex-end',
  },
  skipBtn: { padding: 8 },
  skipText: { fontSize: 15 },
  slide: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    gap: 28,
  },
  illusWrap: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 26,
    fontWeight: '700' as const,
    color: '#F0F4FF',
    textAlign: 'center',
    fontFamily: 'Inter_700Bold',
    lineHeight: 34,
  },
  desc: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 24,
    fontFamily: 'Inter_400Regular',
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 20,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  footer: {
    paddingHorizontal: 24,
  },
  cta: {
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  ctaText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600' as const,
    fontFamily: 'Inter_600SemiBold',
  },
});
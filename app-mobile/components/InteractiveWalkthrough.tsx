import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Dimensions, Pressable, Modal } from 'react-native';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withTiming,
  FadeIn,
  FadeOut,
  Layout
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';
import { useTranslation } from '@/localization';

const { width, height } = Dimensions.get('window');

interface Step {
  id: string;
  title: string;
  description: string;
  icon: string;
  position: { top?: number; bottom?: number; left?: number; right?: number };
}

export default function InteractiveWalkthrough({ visible, onFinish }: { visible: boolean; onFinish: () => void }) {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState(0);
  const opacity = useSharedValue(0);

  const STEPS: Step[] = [
    {
      id: 'welcome',
      title: t('walkthrough_welcome_title'),
      description: t('walkthrough_welcome_desc'),
      icon: 'sparkles',
      position: { top: height * 0.3, left: 20, right: 20 },
    },
    {
      id: 'vpn_btn',
      title: t('walkthrough_vpn_btn_title'),
      description: t('walkthrough_vpn_btn_desc'),
      icon: 'power',
      position: { top: height * 0.45, left: 20, right: 20 },
    },
    {
      id: 'config',
      title: t('walkthrough_config_title'),
      description: t('walkthrough_config_desc'),
      icon: 'layers',
      position: { top: 120, left: 20, right: 20 },
    },
    {
      id: 'quota',
      title: t('walkthrough_quota_title'),
      description: t('walkthrough_quota_desc'),
      icon: 'pie-chart',
      position: { bottom: 280, left: 20, right: 20 },
    },
    {
      id: 'actions',
      title: t('walkthrough_actions_title'),
      description: t('walkthrough_actions_desc'),
      icon: 'apps',
      position: { bottom: 100, left: 20, right: 20 },
    },
  ];

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: 500 });
    }
  }, [visible]);

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onFinish();
    }
  };

  if (!visible) return null;

  const step = STEPS[currentStep];

  return (
    <Modal transparent visible={visible} animationType="fade">
      <View style={styles.overlay}>
        <Animated.View 
          entering={FadeIn.duration(400)} 
          exiting={FadeOut.duration(300)}
          style={[styles.card, step.position]}
        >
          <View style={styles.header}>
            <View style={styles.iconContainer}>
              <Ionicons name={step.icon as any} size={24} color={Colors.primary} />
            </View>
            <Text style={styles.title}>{step.title}</Text>
          </View>
          
          <Text style={styles.description}>{step.description}</Text>
          
          <View style={styles.footer}>
            <View style={styles.dots}>
              {STEPS.map((_, i) => (
                <View 
                  key={i} 
                  style={[
                    styles.dot, 
                    i === currentStep ? styles.activeDot : null
                  ]} 
                />
              ))}
            </View>
            
            <Pressable style={styles.button} onPress={handleNext}>
              <Text style={styles.buttonText}>
                {currentStep === STEPS.length - 1 ? t('walkthrough_finish') : t('next')}
              </Text>
              <Ionicons 
                name={currentStep === STEPS.length - 1 ? "checkmark" : "arrow-forward"} 
                size={18} 
                color="#000" 
              />
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    position: 'absolute',
    backgroundColor: '#161B2E',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(0,212,255,0.2)',
    shadowColor: '#00D4FF',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(0,212,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFF',
    fontFamily: 'Inter_700Bold',
  },
  description: {
    fontSize: 15,
    color: '#A0AEC0',
    lineHeight: 24,
    fontFamily: 'Inter_400Regular',
    marginBottom: 24,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  dots: {
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  activeDot: {
    width: 16,
    backgroundColor: Colors.primary,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 8,
  },
  buttonText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
});

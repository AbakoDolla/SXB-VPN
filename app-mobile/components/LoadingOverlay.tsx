import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface LoadingOverlayProps {
  message?: string;
}

export default function LoadingOverlay({ message }: LoadingOverlayProps) {
  const colors = useColors();
  return (
    <View style={[styles.container, { backgroundColor: `${colors.background}CC` }]}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        {message ? (
          <Text style={[styles.message, { color: colors.foreground }]}>{message}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  card: {
    padding: 28,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    gap: 14,
  },
  message: {
    fontSize: 15,
    fontWeight: '500' as const,
    textAlign: 'center',
  },
});

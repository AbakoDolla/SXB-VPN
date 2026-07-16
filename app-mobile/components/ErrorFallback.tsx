import React, { useState } from 'react';
import {
  Modal,
  Platform as RNPlatform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { reloadAppAsync } from 'expo';

export type ErrorFallbackProps = {
  error: Error;
  resetError: () => void;
};

export function ErrorFallback({ error, resetError }: ErrorFallbackProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [isModalVisible, setIsModalVisible] = useState(false);

  const handleRestart = async () => {
    try {
      await reloadAppAsync();
    } catch (restartError) {
      console.error('Failed to restart app:', restartError);
      resetError();
    }
  };

  const monoFont = RNPlatform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'monospace',
  });

  // Toujours montrer le bouton de détails (pas seulement en __DEV__)
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Bouton détails — toujours visible pour le diagnostic */}
      <Pressable
        onPress={() => setIsModalVisible(true)}
        accessibilityLabel="View error details"
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.topButton,
          {
            top: insets.top + 16,
            backgroundColor: colors.card,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        <Feather name="alert-circle" size={20} color={colors.foreground} />
      </Pressable>

      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Something went wrong
        </Text>

        {/* Message d'erreur visible directement (toujours) */}
        <Text
          selectable
          style={[styles.errorInline, { color: colors.destructive, fontFamily: monoFont }]}
          numberOfLines={4}
        >
          {error.message || String(error)}
        </Text>

        <Text style={[styles.message, { color: colors.mutedForeground }]}>
          Appuyez sur ⓘ (en haut) pour les détails complets.
        </Text>

        <Pressable
          onPress={handleRestart}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
            Try Again
          </Text>
        </Pressable>
      </View>

      {/* Modal avec stack trace complète */}
      <Modal
        visible={isModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setIsModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContainer, { backgroundColor: colors.card }]}>
            <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                Détails de l'erreur
              </Text>
              <Pressable
                onPress={() => setIsModalVisible(false)}
                style={styles.closeButton}
              >
                <Feather name="x" size={24} color={colors.foreground} />
              </Pressable>
            </View>

            <ScrollView
              style={styles.modalScrollView}
              contentContainerStyle={styles.modalScrollContent}
            >
              <View style={[styles.errorContainer, { backgroundColor: colors.background }]}>
                <Text
                  selectable
                  style={[styles.errorText, { color: colors.foreground, fontFamily: monoFont }]}
                >
                  {`Error: ${error.message}\n\nStack:\n${error.stack ?? 'no stack'}`}
                </Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topButton: {
    position: 'absolute',
    right: 16,
    padding: 10,
    borderRadius: 20,
  },
  content: {
    width: '80%',
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorInline: {
    fontSize: 12,
    textAlign: 'left',
    width: '100%',
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(239,68,68,0.08)',
  },
  message: {
    fontSize: 14,
    textAlign: 'center',
  },
  button: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    width: '100%',
    height: '90%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalScrollView: {
    flex: 1,
  },
  modalScrollContent: {
    padding: 16,
  },
  errorContainer: {
    width: '100%',
    borderRadius: 8,
    overflow: 'hidden',
    padding: 16,
  },
  errorText: {
    fontSize: 12,
    lineHeight: 18,
    width: '100%',
  },
});
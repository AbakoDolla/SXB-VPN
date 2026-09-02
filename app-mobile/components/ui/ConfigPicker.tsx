/**
 * Sélecteur de profils VPN.
 *
 * L'accueil ne présentait les profils qu'en pastilles serrées sur une seule
 * ligne : au-delà de deux ou trois, les noms devenaient illisibles et rien ne
 * permettait de supprimer un profil devenu inutile. Cette feuille donne à
 * chaque profil une ligne entière — nom, protocole, état, quota — et regroupe
 * les actions de sélection et de suppression.
 *
 * Composant purement présentationnel : la bascule et la suppression restent
 * assurées par `VpnContext`, seul détenteur de la logique.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';
import { alpha, layout, radius, spacing, type } from '@/constants/theme';
import { EmptyState, Pill } from '@/components/ui/Primitives';
import type { VpnConnection } from '@/types/api';

export interface ConfigEntry {
  id: string;
  name: string;
  protocol: string;
  isActive: boolean;
}

interface ConfigPickerProps {
  visible: boolean;
  onClose: () => void;
  configs: ConfigEntry[];
  activeConfigId: string | null;
  connections: VpnConnection[];
  switching: boolean;
  onSelect: (configId: string) => void;
  onDelete: (configId: string) => Promise<boolean>;
}

export default function ConfigPicker({
  visible,
  onClose,
  configs,
  activeConfigId,
  connections,
  switching,
  onSelect,
  onDelete,
}: ConfigPickerProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const confirmDelete = (entry: ConfigEntry) => {
    Alert.alert(
      t('config_delete_title'),
      t('config_delete_confirm').replace('{name}', entry.name),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: async () => {
            setDeletingId(entry.id);
            await onDelete(entry.id);
            setDeletingId(null);
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay }]} onPress={onClose}>
        {/* L'appui sur la feuille ne doit pas la refermer : on stoppe la
            propagation en interceptant l'événement sans action. */}
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.bgCard, borderColor: colors.border }]}
          onPress={() => {}}
        >
          <View style={[styles.handle, { backgroundColor: colors.border2 }]} />

          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[type.h2, { color: colors.textPrimary }]}>{t('config_switch')}</Text>
              <Text style={[type.caption, { color: colors.textMuted }]}>
                {configs.length} {configs.length > 1 ? t('config_plural') : t('config_singular')}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('close')}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {configs.length === 0 ? (
              <EmptyState icon="shield-outline" title={t('no_vpn_connections')} description={t('ask_admin_for_plan')} />
            ) : (
              configs.map((entry) => {
                const remote = connections.find(c => c.id === entry.id);
                const status = remote?.status;
                const isUnusable = status === 'revoked' || status === 'expired'
                  || status === 'exhausted' || status === 'suspended';
                const isActive = entry.id === activeConfigId;
                const isDeleting = deletingId === entry.id;
                const tone = isUnusable ? colors.disconnected : isActive ? colors.primary : colors.textMuted;

                return (
                  <View
                    key={entry.id}
                    style={[
                      styles.row,
                      {
                        borderColor: isActive ? colors.primary + alpha.f40 : colors.border,
                        backgroundColor: isActive ? colors.primaryDim : colors.bgCard2,
                      },
                    ]}
                  >
                    <Pressable
                      style={styles.rowMain}
                      disabled={switching || isUnusable || isActive || isDeleting}
                      onPress={() => onSelect(entry.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isActive, disabled: isUnusable }}
                    >
                      <View style={[styles.rowIcon, { backgroundColor: tone + alpha.f12 }]}>
                        {switching && isActive ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <Ionicons
                            name={isActive ? 'shield-checkmark' : 'shield-outline'}
                            size={19}
                            color={tone}
                          />
                        )}
                      </View>

                      <View style={styles.rowCopy}>
                        <Text style={[type.h3, { color: colors.textPrimary }]} numberOfLines={1}>
                          {entry.name}
                        </Text>
                        <View style={styles.rowMeta}>
                          <Text style={[type.micro, { color: colors.textMuted }]}>{entry.protocol || '—'}</Text>
                          {isActive && <Pill label={t('config_active')} tone={colors.connected} />}
                          {isUnusable && <Pill label={t(status === 'expired' ? 'expired' : 'config_expired')} tone={colors.disconnected} />}
                        </View>
                      </View>
                    </Pressable>

                    <Pressable
                      onPress={() => confirmDelete(entry)}
                      disabled={isDeleting || switching}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('config_delete_title')}
                      style={({ pressed }) => [
                        styles.deleteBtn,
                        { borderColor: colors.disconnected + alpha.f24 },
                        pressed && { opacity: 0.6 },
                      ]}
                    >
                      {isDeleting ? (
                        <ActivityIndicator size="small" color={colors.disconnected} />
                      ) : (
                        <Ionicons name="trash-outline" size={17} color={colors.disconnected} />
                      )}
                    </Pressable>
                  </View>
                );
              })
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radius['2xl'],
    borderTopRightRadius: radius['2xl'],
    borderWidth: 1,
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.md,
    paddingBottom: spacing['3xl'],
    maxHeight: '80%',
  },
  handle: { width: 40, height: 4, borderRadius: radius.full, alignSelf: 'center', marginBottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingBottom: spacing.lg },

  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowCopy: { flex: 1, gap: spacing.xs },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  deleteBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

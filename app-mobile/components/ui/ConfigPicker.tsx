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
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useMotionPreference } from '@/hooks/useMotionPreference';
import { useTranslation } from '@/localization';
import { alpha, layout, radius, spacing, type } from '@/constants/theme';
import { EmptyState, Pill, ProgressBar } from '@/components/ui/Primitives';
import { protocolTone } from '@/constants/protocolTone';
import { formatBytes, type DerivedQuota } from '@/services/quotaState';
import type { VpnConnection } from '@/types/api';
import type { ProfileStatus } from '@/services/accessPolicy';
import { accesSansConfigLocale, visibleConfigs } from './configPickerItems';

export interface ConfigEntry {
  id: string;
  name: string;
  protocol: string;
  isActive: boolean;
  status?: ProfileStatus;
  assignmentOrigin?: {
    label: string;
    tone: 'superadmin' | 'admin' | 'reseller' | 'support' | 'default';
    role: string | null;
  } | null;
  /** Accès annoncé par le serveur dont l'appareil n'a pas encore la configuration. */
  enAttente?: boolean;
}

interface ConfigPickerProps {
  visible: boolean;
  onClose: () => void;
  configs: ConfigEntry[];
  activeConfigId: string | null;
  activeQuota?: Pick<DerivedQuota, 'totalBytes' | 'usedBytes' | 'expiryDate'>;
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
  activeQuota,
  connections,
  switching,
  onSelect,
  onDelete,
}: ConfigPickerProps) {
  const colors = useColors();
  const { t, language } = useTranslation();
  const insets = useSafeAreaInsets();
  const { reduceMotion } = useMotionPreference();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // Le sélecteur listait le COFFRE LOCAL, l'accueil liste le SERVEUR. Un accès
  // dont le provisionnement a échoué disparaissait donc d'ici tout en gardant
  // sa barre de quota là-bas, sans le moindre message. `switchConfig` sait
  // provisionner à la demande : il suffisait de rendre l'entrée atteignable.
  const tous = useMemo<ConfigEntry[]>(
    () => [...configs, ...accesSansConfigLocale(configs, connections)],
    [configs, connections],
  );
  const entries = useMemo(
    () => visibleConfigs(tous, activeConfigId, query, language),
    [activeConfigId, tous, language, query],
  );

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
            try {
              await onDelete(entry.id);
            } catch {
              Alert.alert(t('config_delete_title'), t('config_delete_error'));
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <Pressable style={[styles.overlay, { backgroundColor: colors.overlay, paddingTop: insets.top + spacing.md }]} onPress={onClose}>
        {/* L'appui sur la feuille ne doit pas la refermer : on stoppe la
            propagation en interceptant l'événement sans action. */}
        <Pressable
          style={[styles.sheet, {
            backgroundColor: colors.bgCard,
            borderColor: colors.border,
            paddingBottom: Math.max(insets.bottom, spacing.lg),
          }]}
          accessibilityViewIsModal
          aria-modal
          onPress={() => {}}
        >
          <View style={[styles.handle, { backgroundColor: colors.border2 }]} />

          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text accessibilityRole="header" style={[type.h2, { color: colors.textPrimary }]}>{t('config_switch')}</Text>
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                {tous.length} {tous.length > 1 ? t('config_plural') : t('config_singular')}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeButton} accessibilityRole="button" accessibilityLabel={t('close')}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          {(tous.length > 4 || query.length > 0) && (
            <View style={[styles.search, { backgroundColor: colors.bgInput, borderColor: colors.border2 }]}>
              <Ionicons name="search-outline" size={19} color={colors.textSecondary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={t('config_search')}
                placeholderTextColor={colors.textSecondary}
                accessibilityLabel={t('config_search')}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={[type.body, styles.searchInput, { color: colors.textPrimary }]}
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery('')} style={styles.closeButton} accessibilityRole="button" accessibilityLabel={t('config_clear_search')}>
                  <Ionicons name="close-circle" size={20} color={colors.textSecondary} />
                </Pressable>
              )}
            </View>
          )}

          <ScrollView style={styles.list} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {tous.length === 0 ? (
              <EmptyState icon="shield-outline" title={t('no_vpn_connections')} description={t('ask_admin_for_plan')} />
            ) : entries.length === 0 ? (
              <EmptyState icon="search-outline" title={t('config_search_empty')} description={t('config_search_hint')} />
            ) : (
              entries.map((entry) => {
                const remote = connections.find(c => c.id === entry.id);
                const assignmentOrigin = entry.assignmentOrigin ?? remote?.assignmentOrigin ?? null;
                const assignmentLabel = assignmentOrigin?.label || remote?.assignedByRole || entry.assignmentOrigin?.role || null;
                const status = entry.status ?? remote?.status;
                const isUnusable = status === 'revoked' || status === 'deleted' || status === 'suspended';
                const hasNotice = isUnusable || status === 'expired' || status === 'exhausted';
                const isActive = entry.id === activeConfigId;
                const isDeleting = deletingId === entry.id;
                const teinteProtocole = protocolTone(colors, entry.protocol || remote?.technicalProtocol);
                const tone = isUnusable ? colors.accents.corail : isActive ? colors.accents.emeraude : teinteProtocole;
                const assignmentTone = assignmentOrigin ? {
                  superadmin: colors.accents.violet,
                  admin: colors.accents.cyan,
                  reseller: colors.accents.emeraude,
                  support: colors.accents.ambre,
                  default: colors.accents.indigo,
                }[assignmentOrigin.tone] || colors.accents.indigo : undefined;
                // Le profil actif partage exactement le quota de l'accueil,
                // y compris les octets mesurés en attente de synchronisation.
                const currentQuota = isActive ? activeQuota : undefined;
                const volumeTotal = currentQuota?.totalBytes ?? (remote
                  ? (remote.quota.totalBytes ?? remote.quota.totalGB * 1024 ** 3)
                  : 0);
                const volumeUtilise = currentQuota?.usedBytes ?? (remote
                  ? (remote.quota.usedBytes ?? remote.quota.usedGB * 1024 ** 3)
                  : 0);
                const volumeRestant = Math.max(0, volumeTotal - volumeUtilise);
                const partConsommee = volumeTotal > 0 ? volumeUtilise / volumeTotal : 0;
                const expiresAt = currentQuota ? currentQuota.expiryDate : remote?.expiresAt;

                return (
                  <View
                    key={entry.id}
                      style={[
                        styles.row,
                        {
                          borderColor: isActive ? colors.accents.emeraude + alpha.f40 : colors.border,
                          backgroundColor: isActive ? colors.accents.emeraude + alpha.f08 : colors.bgCard2,
                        },
                      ]}
                  >
                    <Pressable
                      style={styles.rowMain}
                      disabled={switching || isUnusable || isActive || isDeleting}
                      onPress={() => onSelect(entry.id)}
                      accessibilityRole="button"
                      accessibilityLabel={entry.name}
                      accessibilityState={{ selected: isActive, disabled: switching || isUnusable || isActive || isDeleting }}
                      aria-selected={isActive}
                      aria-disabled={switching || isUnusable || isActive || isDeleting}
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
                        <Text style={[type.h3, { color: colors.textPrimary }]} numberOfLines={2}>
                          {entry.name}
                        </Text>
                        <View style={styles.rowMeta}>
                          {/* Le protocole n'est plus nommé : il décrit la
                              technique de transport, donc la configuration que
                              l'exploitant vend. La teinte de la ligne continue
                              de distinguer les familles, sans les révéler. */}
                          {assignmentOrigin && assignmentLabel && (
                            <Pill label={assignmentLabel} tone={assignmentTone ?? colors.accents.indigo} dot />
                          )}
                          {isActive && <Pill label={t('config_active')} tone={colors.accents.emeraude} dot />}
                          {entry.enAttente && !hasNotice && (
                            <Pill label={t('config_pending_device')} tone={colors.accents.ambre} />
                          )}
                          {hasNotice && <Pill label={t(status === 'suspended' ? 'connection_suspended' :
                            status === 'expired' ? 'expired' : status === 'exhausted' ? 'quota_exhausted' : 'connection_revoked')} tone={colors.accents.corail} />}
                        </View>

                        {/* Le quota de CETTE connexion. Il ne figurait nulle
                            part dans le sélecteur : on choisissait donc un
                            profil sans savoir ce qu'il lui restait, et il
                            fallait basculer dessus pour l'apprendre. */}
                        {volumeTotal > 0 && (
                          <View style={styles.rowQuota}>
                            <View style={styles.rowQuotaLine}>
                              <Text style={[type.captionMedium, { color: colors.textSecondary }]}>
                                {formatBytes(volumeRestant)} {t('quota_remaining')}
                              </Text>
                              <Text style={[type.caption, { color: colors.textSecondary }]}>
                                / {formatBytes(volumeTotal)}
                              </Text>
                            </View>
                            <ProgressBar
                              progress={partConsommee}
                              tone={teinteProtocole}
                              warnTone={colors.accents.corail}
                              height={4}
                            />
                          </View>
                        )}

                        {expiresAt && (
                          <Text style={[type.caption, { color: colors.textSecondary }]}>
                            {t('expires_on')} {new Date(expiresAt).toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'medium' })}
                          </Text>
                        )}
                      </View>
                    </Pressable>

                    {/* Rien à supprimer tant que l'appareil ne détient pas la
                        configuration : proposer le geste donnerait un bouton
                        qui échoue, ou effacerait côté appareil la trace d'un
                        accès que le serveur accorde toujours. */}
                    {!entry.enAttente && (
                    <Pressable
                      onPress={() => confirmDelete(entry)}
                      disabled={isDeleting || switching}
                      accessibilityRole="button"
                      accessibilityLabel={`${t('delete')} ${entry.name}`}
                      accessibilityState={{ disabled: isDeleting || switching, busy: isDeleting }}
                      aria-disabled={isDeleting || switching}
                      aria-busy={isDeleting}
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
                    )}
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
    maxHeight: '90%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  handle: { width: 40, height: 4, borderRadius: radius.full, alignSelf: 'center', marginBottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingBottom: spacing.lg },
  closeButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, paddingLeft: spacing.md, marginBottom: spacing.lg },
  searchInput: { flex: 1, minWidth: 0, minHeight: 48, paddingVertical: spacing.md },

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
  rowCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  rowQuota: { gap: spacing.xs, marginTop: spacing.xs },
  rowQuotaLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs },
  deleteBtn: {
    width: 44,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

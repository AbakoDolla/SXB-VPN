/**
 * Bascule FR/EN.
 *
 * POURQUOI ici : la langue ne se changeait que depuis les Réglages, écran
 * inaccessible tant que le compte n'est pas activé. Quelqu'un qui reçoit
 * l'application en anglais et ne lit que le français — ou l'inverse — devait
 * donc traverser en aveugle l'activation ou la demande d'essai, c'est-à-dire
 * précisément les deux écrans où une erreur de saisie coûte un appel au
 * support.
 *
 * Elle écrit dans le `LanguageContext` existant, qui persiste déjà le choix
 * dans `@sxb_language` : aucun second mécanisme, et le réglage survit à la
 * suite du parcours.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useLanguageContext } from '@/contexts/LanguageContext';
import { alpha, radius, spacing, type } from '@/constants/theme';
import type { Language } from '@/localization';

const LANGUES: Language[] = ['fr', 'en'];

export default function LanguageToggle({ tone }: { tone?: string }) {
  const colors = useColors();
  const { language, setLanguage } = useLanguageContext();
  const teinte = tone ?? colors.accents.cyan;

  return (
    <View
      style={[styles.wrap, { borderColor: colors.border2, backgroundColor: colors.bgCard }]}
      accessibilityRole="radiogroup"
    >
      {LANGUES.map(code => {
        const actif = language === code;
        return (
          <Pressable
            key={code}
            onPress={() => {
              if (actif) return;
              if (Platform.OS !== 'web') void Haptics.selectionAsync();
              setLanguage(code);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: actif }}
            // Le libellé reste le code de langue lui-même : « FR » et « EN » se
            // comprennent sans traduction, ce qui est précisément la propriété
            // recherchée par quelqu'un qui ne lit pas la langue affichée.
            accessibilityLabel={code.toUpperCase()}
            hitSlop={6}
            style={({ pressed }) => [
              styles.item,
              actif && { backgroundColor: teinte + alpha.f16 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[type.micro, { color: actif ? teinte : colors.textMuted, fontFamily: 'Inter_700Bold' }]}>
              {code.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: radius.full,
    overflow: 'hidden',
  },
  item: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    minWidth: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

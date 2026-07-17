import React, { useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/localization';

interface TokenInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  prefix?: string; // e.g. 'SXB-USER-'
  error?: string;
}

export default function TokenInput({ value, onChange, placeholder, prefix, error }: TokenInputProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const inputRef = useRef<TextInput>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Paste is handled natively via long-press on the TextInput

  const borderColor = error
    ? colors.destructive
    : isFocused
    ? colors.primary
    : colors.border;

  return (
    <View style={styles.container}>
      <Pressable
        style={[styles.inputRow, { backgroundColor: colors.input, borderColor }]}
        onPress={() => inputRef.current?.focus()}
      >
        <Ionicons
          name="key-outline"
          size={20}
          color={isFocused ? colors.primary : colors.mutedForeground}
          style={styles.icon}
        />
        <TextInput
          ref={inputRef}
          style={[styles.input, { color: colors.foreground }]}
          value={value}
          onChangeText={(v) => onChange(v.toUpperCase())}
          placeholder={placeholder ?? 'SXB-XXXX-XXXX-XXXX'}
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
        />
        <Ionicons name="clipboard-outline" size={18} color={colors.mutedForeground} />
      </Pressable>

      {error ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle-outline" size={14} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 10,
  },
  icon: {},
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
    letterSpacing: 1,
  },
  pasteBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pasteText: {
    fontSize: 13,
    fontWeight: '600' as const,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
  },
  errorText: {
    fontSize: 13,
  },
});

// src/ui/ConsentCheckbox.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../lib/theme';

export default function ConsentCheckbox({
  checked,
  onToggle,
  error,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <View>
      <TouchableOpacity
        style={styles.row}
        onPress={onToggle}
        activeOpacity={0.7}
        // Галочка без подписи недоступна для программ экранного доступа:
        // TalkBack прочитал бы только «переключатель» без того, что именно
        // согласуется. Поэтому роль и состояние заданы явно.
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
      >
        <View
          style={[styles.box, checked && styles.boxChecked, !!error && styles.boxError]}
        >
          {checked ? <Text style={styles.mark}>✓</Text> : null}
        </View>
        <Text style={styles.label}>{children}</Text>
      </TouchableOpacity>

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  box: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    borderRadius: 4,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  boxError: { borderColor: colors.danger },
  mark: { color: colors.white, fontSize: 14, fontWeight: '700' },
  // Метка может занимать несколько строк, поэтому верхняя граница галочки
  // выровнена по первой строке текста, а не по центру блока.
  label: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    lineHeight: 18,
    marginTop: 1,
  },
  error: { color: colors.danger, fontSize: 13, marginTop: 8, marginLeft: 32 },
});

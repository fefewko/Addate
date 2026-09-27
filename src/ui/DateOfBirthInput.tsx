// src/ui/DateOfBirthInput.tsx
import React, { useRef } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { colors } from '../lib/theme';
import { sanitizeParts, type BirthDateParts } from '../lib/date';

// Ввод даты рождения тремя отдельными полями: день, месяц, год.
//
// Почему не одно поле с маской: маска прячет от пользователя, что именно он
// сейчас вводит, и на телефоне приходится гадать. Три узких поля с
// автопереходом между ними читаются однозначно, и в каждом сразу видно, где
// опечатка — например, в месяце невозможно ввести 31.
export default function DateOfBirthInput({
  value,
  onChange,
  error,
}: {
  value: BirthDateParts;
  onChange: (next: BirthDateParts) => void;
  error?: string | null;
}) {
  const dayRef = useRef<TextInputType>(null);
  const monthRef = useRef<TextInputType>(null);
  const yearRef = useRef<TextInputType>(null);

  const hasError = !!error;

  function setPart(part: keyof BirthDateParts, raw: string) {
    onChange(sanitizeParts({ ...value, [part]: raw }));
  }

  // Переход на следующее поле, когда текущее заполнено до конца.
  function maybeAdvance(part: keyof BirthDateParts, len: number) {
    if (value[part].length < len) return;
    if (part === 'day') monthRef.current?.focus();
    else if (part === 'month') yearRef.current?.focus();
  }

  // Возврат на предыдущее поле по Backspace, когда текущее уже пустое:
  // иначе пришлось бы тянуться к курсору мышью.
  function maybeGoBack(
    part: keyof BirthDateParts,
    e: { nativeEvent: { key: string } }
  ) {
    if (e.nativeEvent.key !== 'Backspace' || value[part] !== '') return;
    if (part === 'month') dayRef.current?.focus();
    else if (part === 'year') monthRef.current?.focus();
  }

  const shared = {
    keyboardType: 'number-pad' as const,
    maxLength: 2,
    placeholderTextColor: colors.textFaint,
    selectionColor: colors.accent,
  };

  return (
    <View>
      <View style={styles.row}>
        <View style={styles.cell}>
          <TextInput
            {...shared}
            ref={dayRef}
            value={value.day}
            onChangeText={(t) => setPart('day', t)}
            onKeyPress={(e) => maybeGoBack('day', e)}
            placeholder="ДД"
            style={[styles.input, hasError && styles.inputError]}
            accessibilityLabel="День рождения"
          />
        </View>

        <Text style={styles.sep}>/</Text>

        <View style={styles.cell}>
          <TextInput
            {...shared}
            ref={monthRef}
            value={value.month}
            onChangeText={(t) => setPart('month', t)}
            onKeyPress={(e) => maybeGoBack('month', e)}
            placeholder="ММ"
            style={[styles.input, hasError && styles.inputError]}
            accessibilityLabel="Месяц рождения"
          />
        </View>

        <Text style={styles.sep}>/</Text>

        <View style={[styles.cell, styles.cellYear]}>
          <TextInput
            {...shared}
            ref={yearRef}
            value={value.year}
            maxLength={4}
            onChangeText={(t) => setPart('year', t)}
            onKeyPress={(e) => maybeGoBack('year', e)}
            placeholder="ГГГГ"
            style={[styles.input, hasError && styles.inputError]}
            accessibilityLabel="Год рождения"
          />
        </View>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cell: { flex: 1 },
  cellYear: { flex: 1.4 },
  input: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 14,
    textAlign: 'center',
    fontSize: 17,
  },
  inputError: { borderColor: colors.danger },
  sep: { color: colors.textFaint, fontSize: 17 },
  error: { color: colors.danger, fontSize: 13, marginTop: 8 },
});

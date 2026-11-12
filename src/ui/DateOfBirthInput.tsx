// src/ui/DateOfBirthInput.tsx
import React from 'react';
import DatePartsInput from './DatePartsInput';
import type { BirthDateParts } from '../lib/date';

// Ввод даты рождения тремя отдельными полями: день, месяц, год.
// Сам ввод живёт в DatePartsInput — он же используется для других дат.
export default function DateOfBirthInput({
  value,
  onChange,
  error,
}: {
  value: BirthDateParts;
  onChange: (next: BirthDateParts) => void;
  error?: string | null;
}) {
  return (
    <DatePartsInput
      value={value}
      onChange={onChange}
      error={error}
      labels={{
        day: 'День рождения',
        month: 'Месяц рождения',
        year: 'Год рождения',
      }}
    />
  );
}

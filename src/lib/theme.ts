// src/lib/theme.ts
// Единая цветовая палитра приложения. Раньше HEX-коды были расписаны буквально
// в каждом экране по отдельности — при любой правке темы пришлось бы искать
// вхождения по всем файлам. Теперь один источник истины.

export const colors = {
  bg: '#121212',
  surface: '#1c1c1e',
  border: '#2a2a2a',

  textPrimary: '#f0f0f0',
  textSecondary: '#a0a0a5',
  textFaint: '#8a8a8e',
  textMuted: '#9a9a9e',
  textLight: '#c7c7cc',
  white: '#fff',

  accent: '#3b82f6',
  success: '#4ade80',
  danger: '#f87171',
  dangerLight: '#fca5a5',
  dangerBg: '#3a1d1d',
  offline: '#5a5a5e',
} as const;

// src/ui/LoadError.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../lib/theme';

// Единый экран для сбоя загрузки.
//
// Почему он нужен: почти в каждом загрузчике стояло
//
//   const { data: { user } } = await supabase.auth.getUser();
//   if (!user) return;
//
// без сброса loading. Любой сбой сессии или сети поэтому оставлял экран
// на бесконечном спиннере — без сообщения и без кнопки повтора. Хуже всего
// это было в App.tsx: приложение не стартовало вообще.
export default function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Не удалось загрузить</Text>
      <Text style={styles.body}>{message}</Text>
      {onRetry && (
        <TouchableOpacity style={styles.button} onPress={onRetry}>
          <Text style={styles.buttonText}>Повторить</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: colors.bg,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 16,
    textAlign: 'center',
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: { color: colors.white, fontWeight: '600' },
});

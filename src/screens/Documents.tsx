// src/screens/Documents.tsx
//
// Документы и согласия вынесены из настроек отдельным экраном: пять ссылок
// подряд занимали пол-экрана и отодвигали настройки аккаунта. Теперь в
// настройках одна строка, а список открывается здесь.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking } from 'react-native';
import { appAlert } from '../lib/alert';
import { colors } from '../lib/theme';

const DOCS = [
  ['Пользовательское соглашение', 'https://addate.ru/terms.html'],
  ['Правила сообщества', 'https://addate.ru/rules.html'],
  ['Политика конфиденциальности', 'https://addate.ru/privacy.html'],
  ['Согласие на обработку персональных данных', 'https://addate.ru/personal-data-consent.html'],
  ['Удаление аккаунта', 'https://addate.ru/delete-account.html'],
] as const;

export default function Documents() {
  function openDoc(url: string) {
    Linking.openURL(url).catch(() => appAlert.alert('Ошибка', 'Не удалось открыть документ.'));
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.hint}>
        Правила и документы, которые вы принимаете при регистрации. Открываются в браузере.
      </Text>

      {DOCS.map(([label, url]) => (
        <TouchableOpacity key={url} style={styles.actionRow} onPress={() => openDoc(url)}>
          <Text style={styles.actionText}>{label}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  hint: { color: colors.textFaint, fontSize: 12, marginBottom: 14, lineHeight: 16 },
  actionRow: { backgroundColor: colors.surface, borderRadius: 10, padding: 14, marginBottom: 8 },
  actionText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
});

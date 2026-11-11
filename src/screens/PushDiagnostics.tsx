// src/screens/PushDiagnostics.tsx
//
// Пошаговая проверка push-уведомлений. Показывает, где рвётся цепочка:
// разрешение ОС, Expo push-токен, запись в push_tokens, отправка через Expo и
// доставка на телефон. Последний шаг — самопроверка: приложение отправляет
// уведомление самому себе и ждёт квитанцию.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { runPushDiagnostics, type PushCheck } from '../lib/pushNotifications';
import { colors } from '../lib/theme';

const STATUS_COLORS: Record<PushCheck['status'], string> = {
  ok: '#22c55e',
  fail: colors.danger,
  skip: colors.textFaint,
};

export default function PushDiagnostics() {
  const [checks, setChecks] = useState<PushCheck[]>([]);
  const [running, setRunning] = useState(true);

  const run = useCallback(async () => {
    setRunning(true);
    setChecks([]);
    try {
      setChecks(await runPushDiagnostics());
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.paragraph}>
        Проверяем, доходят ли уведомления до этого телефона. Занимает до 10 секунд:
        последний шаг отправляет тестовое уведомление и ждёт ответа сервиса.
      </Text>

      {running && (
        <View style={styles.running}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.runningText}>Проверяем…</Text>
        </View>
      )}

      {checks.map((check) => (
        <View key={check.title} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: STATUS_COLORS[check.status] }]} />
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>{check.title}</Text>
            {!!check.detail && <Text style={styles.rowDetail}>{check.detail}</Text>}
          </View>
        </View>
      ))}

      {!running && (
        <>
          <TouchableOpacity style={styles.button} onPress={run}>
            <Text style={styles.buttonText}>Проверить ещё раз</Text>
          </TouchableOpacity>

          <Text style={styles.hint}>
            Если все шаги зелёные и тестовое уведомление пришло, а сообщения от собеседника
            уведомлениями не сопровождаются — проблема на стороне сервера: не срабатывает
            триггер на новые сообщения или Edge Function send-message-push.
          </Text>
          <Text style={styles.hint}>
            Ошибка с пометкой InvalidCredentials или MismatchSenderId значит, что в проекте
            Expo не загружены ключи Firebase (FCM) для Android.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  paragraph: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  running: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  runningText: { color: colors.textSecondary, fontSize: 14, marginLeft: 10 },
  row: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, marginRight: 10 },
  rowBody: { flex: 1 },
  rowTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  rowDetail: { color: colors.textSecondary, fontSize: 13, marginTop: 4, lineHeight: 18 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  buttonText: { color: colors.white, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.textFaint, fontSize: 12, lineHeight: 17, marginTop: 12 },
});

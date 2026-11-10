// src/screens/KeyBackup.tsx
//
// Резервная копия ключа шифрования переписки.
//
// Экран нужен, чтобы копию можно было создать в любой момент, не выходя из
// аккаунта: при входе она создаётся автоматически, но если человек уже был
// авторизован (например, обновился с версии без копий), пароль ему вводить
// негде. Здесь он вводит пароль один раз, и копия сохраняется.
//
// Пароль проверяется настоящим входом в Supabase: копия шифруется именно
// паролем, и опечатка сделала бы её бесполезной при восстановлении.

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { appAlert } from '../lib/alert';
import { supabase } from '../lib/supabase';
import { hasKeyBackup, syncKeyBackup, type BackupSyncResult } from '../lib/keyBackup';
import { colors } from '../lib/theme';

type Status = 'loading' | 'exists' | 'missing' | 'unknown';

const RESULT_MESSAGES: Record<BackupSyncResult, { title: string; message: string }> = {
  created: {
    title: 'Копия сохранена',
    message:
      'После переустановки приложения войдите с этим паролем — ключ восстановится, и история переписки снова станет доступна.',
  },
  active: {
    title: 'Копия актуальна',
    message: 'Резервная копия уже сохранена и соответствует ключу на этом устройстве.',
  },
  restored: {
    title: 'Ключ восстановлен',
    message: 'Ключ из резервной копии установлен на устройстве, история переписки снова доступна.',
  },
  conflict: {
    title: 'Сначала замените ключ',
    message:
      'В профиле сохранён ключ другого устройства, а копии этого ключа нет. Отправьте сообщение в чате и подтвердите замену ключа, затем вернитесь сюда.',
  },
  failed: {
    title: 'Не удалось',
    message:
      'Не получилось прочитать или сохранить копию. Проверьте пароль и подключение к интернету. Если ошибка повторяется, напишите в поддержку.',
  },
};

export default function KeyBackup() {
  const [status, setStatus] = useState<Status>('loading');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!active) return;
        const exists = user ? await hasKeyBackup(user.id) : null;
        if (!active) return;
        setStatus(exists === null ? 'unknown' : exists ? 'exists' : 'missing');
      })();
      return () => {
        active = false;
      };
    }, [])
  );

  async function handleSave() {
    if (!password) {
      appAlert.alert('Введите пароль', 'Копия шифруется паролем аккаунта — без него её не восстановить.');
      return;
    }

    setBusy(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.email) {
        appAlert.alert('Ошибка', 'Не удалось определить аккаунт. Войдите заново.');
        return;
      }

      // Проверка пароля настоящим входом: иначе опечатка зашифровала бы копию
      // неизвестным паролем, и восстановить её было бы невозможно.
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if (verifyError) {
        appAlert.alert('Неверный пароль', 'Проверьте пароль и попробуйте ещё раз.');
        return;
      }

      const result = await syncKeyBackup(user.id, password);
      const text = RESULT_MESSAGES[result];
      appAlert.alert(text.title, text.message);
      setPassword('');

      const exists = await hasKeyBackup(user.id);
      setStatus(exists === null ? 'unknown' : exists ? 'exists' : 'missing');
    } catch (e: any) {
      appAlert.alert('Ошибка', e?.message ?? 'Не удалось сохранить резервную копию.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.paragraph}>
          Переписка шифруется на устройстве. Ключ хранится только на телефоне, поэтому после
          переустановки приложения без резервной копии старые сообщения прочитать нельзя.
        </Text>
        <Text style={styles.paragraph}>
          Копия ключа шифруется вашим паролем и хранится на сервере в зашифрованном виде — без
          пароля её не может прочитать никто, включая администрацию.
        </Text>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Резервная копия</Text>
          <Text style={styles.rowValue}>
            {status === 'loading'
              ? 'Проверяем…'
              : status === 'exists'
                ? 'Сохранена'
                : status === 'missing'
                  ? 'Не создана'
                  : 'Не удалось проверить'}
          </Text>
        </View>

        <Text style={styles.label}>Пароль аккаунта</Text>
        <TextInput
          style={styles.input}
          placeholder="Введите пароль"
          placeholderTextColor={colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
          value={password}
          onChangeText={setPassword}
        />

        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={handleSave}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.buttonText}>
              {status === 'exists' ? 'Обновить копию' : 'Сохранить копию'}
            </Text>
          )}
        </TouchableOpacity>

        <Text style={styles.hint}>
          Если вы поменяете пароль, сохраните копию заново — старая останется зашифрованной прежним
          паролем.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  paragraph: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    marginTop: 6,
    marginBottom: 18,
  },
  rowLabel: { color: colors.textPrimary, fontSize: 14, flex: 1, marginRight: 12 },
  rowValue: { color: colors.textSecondary, fontSize: 14 },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, marginLeft: 2 },
  input: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
  hint: { color: colors.textFaint, fontSize: 12, marginTop: 16, lineHeight: 16 },
});

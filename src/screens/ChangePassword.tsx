// src/screens/ChangePassword.tsx
//
// Смена пароля учётной записи.
//
// Важная деталь: резервная копия ключа E2EE зашифрована паролем. Если просто
// вызвать updateUser, копия осталась бы зашифрованной старым паролем и после
// переустановки приложения не открылась бы. Поэтому после смены пароля копия
// перешифровывается новым — здесь же, пока он ещё есть в памяти.
//
// Текущий пароль проверяем настоящим входом: Supabase не даёт другого способа
// подтвердить, что пароль знает владелец сессии.

import React, { useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
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
import { useNavigation } from '@react-navigation/native';
import { appAlert } from '../lib/alert';
import { log } from '../lib/log';
import { supabase } from '../lib/supabase';
import { reencryptKeyBackup } from '../lib/keyBackup';
import { colors } from '../lib/theme';

const MIN_PASSWORD_LENGTH = 6;

export default function ChangePassword() {
  const navigation = useNavigation<RootNavigation>();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);

    if (!currentPassword) {
      setError('Введите текущий пароль.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Новый пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`);
      return;
    }
    if (newPassword !== repeatPassword) {
      setError('Новый пароль и повтор не совпадают.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Новый пароль совпадает с текущим.');
      return;
    }

    setBusy(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.email) {
        setError('Не удалось определить аккаунт. Войдите заново.');
        return;
      }

      // Проверка текущего пароля: signInWithPassword обновит сессию, что
      // безопасно, зато даёт достоверный ответ от сервера.
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (verifyError) {
        setError('Текущий пароль неверен.');
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setError('Не удалось изменить пароль: ' + updateError.message);
        return;
      }

      // Ключ перешифровываем новым паролем. Ошибка здесь не отменяет смену
      // пароля — сообщаем отдельно.
      let backupOk = true;
      try {
        backupOk = await reencryptKeyBackup(user.id, newPassword);
      } catch (e) {
        backupOk = false;
        log.warn('Не удалось перешифровать резервную копию ключа:', e);
      }

      appAlert.alert(
        'Пароль изменён',
        backupOk
          ? 'Новый пароль сохранён. Резервная копия ключа перешифрована им же, так что после переустановки вход с новым паролем восстановит переписку.'
          : 'Новый пароль сохранён, но резервную копию ключа обновить не удалось. Попробуйте войти в аккаунт заново, чтобы копия пересоздалась.'
      );
      navigation.goBack();
    } catch (e: any) {
      setError(e?.message ?? 'Не удалось изменить пароль.');
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
          Пароль защищает вход в аккаунт и резервную копию ключа переписки. После смены копия
          автоматически перешифровывается новым паролем.
        </Text>

        <Text style={styles.label}>Текущий пароль</Text>
        <TextInput
          style={styles.input}
          placeholder="Введите текущий пароль"
          placeholderTextColor={colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
          value={currentPassword}
          onChangeText={setCurrentPassword}
        />

        <Text style={styles.label}>Новый пароль</Text>
        <TextInput
          style={styles.input}
          placeholder={`Не короче ${MIN_PASSWORD_LENGTH} символов`}
          placeholderTextColor={colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
          value={newPassword}
          onChangeText={setNewPassword}
        />

        <Text style={styles.label}>Повторите новый пароль</Text>
        <TextInput
          style={styles.input}
          placeholder="Ещё раз"
          placeholderTextColor={colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
          value={repeatPassword}
          onChangeText={setRepeatPassword}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.buttonText}>Изменить пароль</Text>
          )}
        </TouchableOpacity>
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
    marginBottom: 18,
  },
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
  error: { color: colors.danger, marginBottom: 12, fontSize: 14 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
});

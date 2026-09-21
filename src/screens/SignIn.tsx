// src/screens/SignIn.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { loginWithTelegram } from '../lib/telegramAuth';
import { colors } from '../lib/theme';

// Вход через Telegram временно скрыт из интерфейса — код и серверная часть
// остаются рабочими, доделаем и включим позже. Чтобы вернуть кнопку — просто true.
const TELEGRAM_LOGIN_ENABLED = false;

function mapAuthError(message: string): string {
  if (message.includes('Invalid login credentials')) {
    return 'Неверный email или пароль.';
  }
  if (message.includes('Email not confirmed')) {
    return 'Email ещё не подтверждён. Проверьте почту.';
  }
  return 'Не удалось войти. Попробуйте ещё раз.';
}

export default function SignIn() {
  const navigation = useNavigation<any>();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Общая логика для email- и Telegram-входа: смотрим, заполнена ли анкета
  // и прошла ли она модерацию, и ведём на нужный экран.
  async function routeAfterLogin(userId: string) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('moderation_status, display_name')
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      setError('Не удалось загрузить профиль. Попробуйте ещё раз.');
      return;
    }

    if (!profile || !profile.display_name) {
      navigation.reset({ index: 0, routes: [{ name: 'ProfileSetup' }] });
      return;
    }

    if (profile.moderation_status === 'approved') {
      navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
    } else {
      navigation.reset({ index: 0, routes: [{ name: 'ModerationPending' }] });
    }
  }

  async function handleSignIn() {
    setError(null);

    if (!email.trim() || !password) {
      setError('Заполните email и пароль.');
      return;
    }

    setLoading(true);

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setError(mapAuthError(signInError.message));
      setLoading(false);
      return;
    }

    const userId = data.user?.id;
    if (!userId) {
      setError('Не удалось получить данные пользователя.');
      setLoading(false);
      return;
    }

    await routeAfterLogin(userId);
    setLoading(false);
  }

  async function handleTelegramLogin() {
    setError(null);
    setTelegramLoading(true);

    const result = await loginWithTelegram();

    if (result.status === 'error') {
      setTelegramLoading(false);
      Alert.alert('Не получилось', result.message);
      return;
    }

    if (result.status === 'timeout') {
      setTelegramLoading(false);
      Alert.alert(
        'Время вышло',
        'Не увидели подтверждение от Telegram. Если вы нажали Start в боте, просто попробуйте ещё раз.'
      );
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    setTelegramLoading(false);

    if (!user) {
      Alert.alert('Ошибка', 'Не удалось получить данные пользователя после входа.');
      return;
    }

    await routeAfterLogin(user.id);
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      setError('Сначала введите email в поле выше, затем нажмите "Забыли пароль?"');
      return;
    }

    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim());

    if (resetError) {
      Alert.alert('Ошибка', 'Не удалось отправить письмо. Проверьте email и попробуйте ещё раз.');
      return;
    }

    Alert.alert(
      'Письмо отправлено',
      'Проверьте почту — там будет ссылка для сброса пароля. Если письма нет, загляните в папку "Спам".'
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Вход</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textFaint}
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />

      <Text style={styles.label}>Пароль</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textFaint}
        placeholder="Ваш пароль"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleSignIn}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text style={styles.buttonText}>Войти</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={handleForgotPassword}>
        <Text style={styles.link}>Забыли пароль?</Text>
      </TouchableOpacity>

      {TELEGRAM_LOGIN_ENABLED && (
        <>
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>или</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={[styles.telegramButton, telegramLoading && styles.buttonDisabled]}
            onPress={handleTelegramLogin}
            disabled={telegramLoading || loading}
          >
            {telegramLoading ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.buttonText}>Войти через Telegram</Text>
            )}
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity onPress={() => navigation.navigate('SignUp')}>
        <Text style={styles.link}>Нет аккаунта? Зарегистрироваться</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.bg },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 24, textAlign: 'center', color: colors.textPrimary },
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
  link: { textAlign: 'center', marginTop: 16, color: colors.accent, fontSize: 14 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textFaint, fontSize: 13, marginHorizontal: 12 },
  telegramButton: {
    backgroundColor: '#229ED9',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
});

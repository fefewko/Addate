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

  function handleForgotPassword() {
    // Заглушка — восстановление пароля реализуем отдельным шагом
    Alert.alert('Скоро', 'Восстановление пароля будет добавлено позже.');
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
        placeholderTextColor="#8a8a8e"
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />

      <Text style={styles.label}>Пароль</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor="#8a8a8e"
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
          <ActivityIndicator color="#fff" />
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
              <ActivityIndicator color="#fff" />
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
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#121212' },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 24, textAlign: 'center', color: '#f0f0f0' },
  label: { fontSize: 13, fontWeight: '600', color: '#a0a0a5', marginBottom: 6, marginLeft: 2 },
  input: {
    backgroundColor: '#1c1c1e',
    color: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    fontSize: 16,
  },
  error: { color: '#f87171', marginBottom: 12, fontSize: 14 },
  button: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { textAlign: 'center', marginTop: 16, color: '#3b82f6', fontSize: 14 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#2a2a2a' },
  dividerText: { color: '#8a8a8e', fontSize: 13, marginHorizontal: 12 },
  telegramButton: {
    backgroundColor: '#229ED9',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
  },
});

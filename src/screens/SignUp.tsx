// src/screens/SignUp.tsx
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
import { colors } from '../lib/theme';

// Переводит частые ошибки Supabase в понятный пользователю текст.
// Дополняй по мере того, как будут встречаться новые коды ошибок.
function mapAuthError(message: string): string {
  if (message.includes('User already registered')) {
    return 'Этот email уже зарегистрирован. Попробуйте войти.';
  }
  if (message.includes('Password should be at least')) {
    return 'Пароль должен быть не короче 6 символов.';
  }
  if (message.includes('Unable to validate email')) {
    return 'Проверьте правильность email.';
  }
  return 'Не удалось зарегистрироваться. Попробуйте ещё раз.';
}

export default function SignUp() {
  const navigation = useNavigation<any>();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignUp() {
    setError(null);

    if (!email.trim() || !password) {
      setError('Заполните email и пароль.');
      return;
    }
    if (!agreed) {
      setError('Нужно подтвердить возраст 18+ и согласие с правилами.');
      return;
    }

    setLoading(true);

const { data, error: signUpError } = await supabase.auth.signUp({
  email: email.trim(),
  password,
  options: {
    emailRedirectTo: 'addate://auth/callback',
  },
});

    if (signUpError) {
      setError(mapAuthError(signUpError.message));
      setLoading(false);
      return;
    }

    // Если в проекте включено подтверждение email, сессии ещё не будет —
    // Supabase создаст пользователя, но авторизует только после клика по ссылке в письме.
    if (!data.session) {
      setLoading(false);
      Alert.alert(
        'Проверьте почту',
        'Мы отправили письмо для подтверждения регистрации. После подтверждения войдите через экран входа.'
      );
      navigation.navigate('SignIn');
      return;
    }

    const userId = data.user?.id;
    if (!userId) {
      setError('Не удалось получить данные пользователя. Попробуйте войти вручную.');
      setLoading(false);
      return;
    }

    // Создаём пустую запись профиля. moderation_status='pending' проставится
    // автоматически по умолчанию (см. schema.sql), поля анкеты заполнятся на ProfileSetup.
    const { error: profileError } = await supabase.from('profiles').insert({ id: userId });

    setLoading(false);

    if (profileError) {
      // Пользователь в auth уже создан, профиль — нет. Не блокируем его тут,
      // отправляем на ProfileSetup — там можно повторить insert/upsert.
      console.warn('Ошибка создания профиля:', profileError.message);
    }

    navigation.reset({ index: 0, routes: [{ name: 'ProfileSetup' }] });
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Регистрация</Text>

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
        placeholder="Не короче 6 символов"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      <TouchableOpacity
        style={styles.checkboxRow}
        onPress={() => setAgreed(!agreed)}
        activeOpacity={0.7}
      >
        <View style={[styles.checkbox, agreed && styles.checkboxChecked]}>
          {agreed && <Text style={styles.checkboxMark}>✓</Text>}
        </View>
        <Text style={styles.checkboxLabel}>
          Мне есть 18 лет, я согласен(на) с правилами сообщества
        </Text>
      </TouchableOpacity>

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleSignUp}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text style={styles.buttonText}>Зарегистрироваться</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate('SignIn')}>
        <Text style={styles.link}>Уже есть аккаунт? Войти</Text>
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
  checkboxRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 12 },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    borderRadius: 4,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkboxMark: { color: colors.white, fontSize: 14, fontWeight: '700' },
  checkboxLabel: { flex: 1, fontSize: 13, color: colors.textPrimary },
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
});

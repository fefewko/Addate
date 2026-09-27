// src/screens/SignUp.tsx
import React, { useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
import { log } from '../lib/log';
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
  ScrollView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';
import DateOfBirthInput from '../ui/DateOfBirthInput';
import ConsentCheckbox from '../ui/ConsentCheckbox';
import {
  EMPTY_PARTS,
  partsToIso,
  validateBirthDateParts,
  type BirthDateParts,
} from '../lib/date';

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
  const navigation = useNavigation<RootNavigation>();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [birth, setBirth] = useState<BirthDateParts>(EMPTY_PARTS);
  const [birthError, setBirthError] = useState<string | null>(null);
  // Согласие с правилами — отдельный факт, а не следствие даты рождения,
  // поэтому и галочка отдельная, и состояние отдельное.
  const [accepted, setAccepted] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignUp() {
    setError(null);

    if (!email.trim() || !password) {
      setError('Заполните email и пароль.');
      return;
    }

    if (!accepted) {
      setConsentError(
        'Без согласия с правилами пользоваться сервисом нельзя. Прочитайте правила и отметьте согласие.'
      );
      return;
    }
    setConsentError(null);

    // Галочки «мне есть 18 лет» больше нет: вместо неё спрашивается сама
    // дата рождения, и её нельзя поставить не глядя. Проверка 18+ дублируется
    // на сервере триггером check_profile_age, поэтому обойти её нельзя.
    const birthProblem = validateBirthDateParts(birth);
    setBirthError(birthProblem);
    if (birthProblem) return;

    const birthDate = partsToIso(birth);
    if (!birthDate) {
      setBirthError('Не удалось разобрать дату. Проверьте день, месяц и год.');
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

    // Запись профиля сразу с датой рождения. moderation_status='pending'
    // проставится автоматически по умолчанию, остальные поля анкеты
    // заполняются на ProfileSetup.
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({ id: userId, birth_date: birthDate });

    setLoading(false);

    if (profileError) {
      // Пользователь в auth уже создан, профиль — нет. Не блокируем его тут,
      // отправляем на ProfileSetup — там можно повторить insert/upsert.
      // Триггер check_profile_age отклонит некорректную дату, но клиент уже
      // проверил её выше, поэтому сюда попадает только ошибка прав.
      log.warn('Ошибка создания профиля:', profileError.message);
    }

    navigation.reset({ index: 0, routes: [{ name: 'ProfileSetup' }] });
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Форма перестала помещаться в экран после добавления даты рождения и
          согласия: на невысоком экране кнопка уходила под клавиатуру и была
          недоступна. flexGrow с justifyContent 'center' сохраняет прежнее
          центрирование на больших экранах и даёт прокрутку на маленьких. */}
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
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

        <Text style={styles.label}>Дата рождения</Text>
        <DateOfBirthInput
          value={birth}
          onChange={(next) => {
            setBirth(next);
            if (birthError) setBirthError(null);
          }}
          error={birthError}
        />
        <Text style={styles.hint}>
          Регистрация только для людей старше 18 лет. Дата рождения видна в
          анкете как возраст, но не показывается полностью.
        </Text>

        <ConsentCheckbox
          checked={accepted}
          onToggle={() => {
            setAccepted(!accepted);
            if (consentError) setConsentError(null);
          }}
          error={consentError}
        >
          Я принимаю правила пользования сервисом и обязуюсь их соблюдать
        </ConsentCheckbox>

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
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24 },
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
  hint: {
    color: colors.textFaint,
    fontSize: 12,
    marginTop: 8,
    marginBottom: 16,
    lineHeight: 16,
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
});

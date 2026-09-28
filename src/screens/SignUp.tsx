// src/screens/SignUp.tsx
import React, { useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
import { log } from '../lib/log';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet, Alert, KeyboardAvoidingView, Platform, ScrollView, Linking } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';
import DateOfBirthInput from '../ui/DateOfBirthInput';
import ConsentCheckbox from '../ui/ConsentCheckbox';
import { EMPTY_PARTS, partsToIso, validateBirthDateParts, type BirthDateParts } from '../lib/date';

const TERMS_VERSION = '1.0';
const PRIVACY_VERSION = '1.0';
const SPECIAL_DATA_VERSION = '1.0';
const DOCS = {
  terms: 'https://addate.ru/terms.html',
  rules: 'https://addate.ru/rules.html',
  privacy: 'https://addate.ru/privacy.html',
  consent: 'https://addate.ru/personal-data-consent.html',
} as const;

function mapAuthError(message: string): string {
  if (message.includes('User already registered')) return 'Этот email уже зарегистрирован. Попробуйте войти.';
  if (message.includes('Password should be at least')) return 'Пароль должен быть не короче 6 символов.';
  if (message.includes('Unable to validate email')) return 'Проверьте правильность email.';
  return 'Не удалось зарегистрироваться. Попробуйте ещё раз.';
}

export default function SignUp() {
  const navigation = useNavigation<RootNavigation>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [birth, setBirth] = useState<BirthDateParts>(EMPTY_PARTS);
  const [birthError, setBirthError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [specialDataAccepted, setSpecialDataAccepted] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignUp() {
    setError(null);
    if (!email.trim() || !password) { setError('Заполните email и пароль.'); return; }
    if (!termsAccepted || !privacyAccepted || !specialDataAccepted) {
      setConsentError('Подтвердите все три согласия. Документы доступны по ссылкам ниже.');
      return;
    }
    setConsentError(null);
    const birthProblem = validateBirthDateParts(birth);
    setBirthError(birthProblem);
    if (birthProblem) return;
    const birthDate = partsToIso(birth);
    if (!birthDate) { setBirthError('Не удалось разобрать дату. Проверьте день, месяц и год.'); return; }
    setLoading(true);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: {
        emailRedirectTo: 'addate://auth/callback',
        data: {
          terms_accepted: true,
          terms_version: TERMS_VERSION,
          privacy_accepted: true,
          privacy_version: PRIVACY_VERSION,
          special_data_consent_accepted: true,
          special_data_consent_version: SPECIAL_DATA_VERSION,
        },
      },
    });
    if (signUpError) { setError(mapAuthError(signUpError.message)); setLoading(false); return; }

    if (!data.session) {
      setLoading(false);
      Alert.alert('Проверьте почту', 'Мы отправили письмо для подтверждения регистрации. После подтверждения войдите через экран входа.');
      navigation.navigate('SignIn');
      return;
    }

    const userId = data.user?.id;
    if (!userId) { setError('Не удалось получить данные пользователя. Попробуйте войти вручную.'); setLoading(false); return; }

    const { error: profileError } = await supabase.from('profiles').update({
      birth_date: birthDate,
      terms_accepted_at: new Date().toISOString(),
      terms_version: TERMS_VERSION,
      privacy_accepted_at: new Date().toISOString(),
      privacy_version: PRIVACY_VERSION,
      special_data_consent_at: new Date().toISOString(),
      special_data_consent_version: SPECIAL_DATA_VERSION,
    }).eq('id', userId);

    setLoading(false);
    if (profileError) log.warn('Ошибка сохранения профиля/согласий:', profileError.message);
    navigation.reset({ index: 0, routes: [{ name: 'ProfileSetup' }] });
  }

  const openDoc = (url: string) => Linking.openURL(url).catch(() => Alert.alert('Ошибка', 'Не удалось открыть документ.'));

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Регистрация</Text>
        <Text style={styles.label}>Email</Text>
        <TextInput style={styles.input} placeholderTextColor={colors.textFaint} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <Text style={styles.label}>Пароль</Text>
        <TextInput style={styles.input} placeholderTextColor={colors.textFaint} placeholder="Не короче 6 символов" secureTextEntry value={password} onChangeText={setPassword} />
        <Text style={styles.label}>Дата рождения</Text>
        <DateOfBirthInput value={birth} onChange={(next) => { setBirth(next); if (birthError) setBirthError(null); }} error={birthError} />
        <Text style={styles.hint}>Регистрация только для людей старше 18 лет. Дата рождения видна в анкете как возраст, но не показывается полностью.</Text>

        <ConsentCheckbox checked={termsAccepted} onToggle={() => setTermsAccepted(!termsAccepted)} error={consentError}>
          Я принимаю <Text style={styles.inlineLink} onPress={() => openDoc(DOCS.terms)}>Пользовательское соглашение</Text> и <Text style={styles.inlineLink} onPress={() => openDoc(DOCS.rules)}>Правила сообщества</Text>.
        </ConsentCheckbox>
        <View style={styles.gap} />
        <ConsentCheckbox checked={privacyAccepted} onToggle={() => setPrivacyAccepted(!privacyAccepted)}>
          Я согласен на обработку персональных данных в соответствии с <Text style={styles.inlineLink} onPress={() => openDoc(DOCS.privacy)}>Политикой конфиденциальности</Text>.
        </ConsentCheckbox>
        <View style={styles.gap} />
        <ConsentCheckbox checked={specialDataAccepted} onToggle={() => setSpecialDataAccepted(!specialDataAccepted)}>
          Я отдельно согласен на обработку предоставляемых мной сведений, относящихся к специальным категориям персональных данных. <Text style={styles.inlineLink} onPress={() => openDoc(DOCS.consent)}>Подробнее</Text>
        </ConsentCheckbox>

        {error && <Text style={styles.error}>{error}</Text>}
        <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleSignUp} disabled={loading}>
          {loading ? <ActivityIndicator color={colors.white} /> : <Text style={styles.buttonText}>Зарегистрироваться</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('SignIn')}><Text style={styles.link}>Уже есть аккаунт? Войти</Text></TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 24, textAlign: 'center', color: colors.textPrimary },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, marginLeft: 2 },
  input: { backgroundColor: colors.surface, color: colors.textPrimary, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 14, marginBottom: 12, fontSize: 16 },
  hint: { color: colors.textFaint, fontSize: 12, marginTop: 8, marginBottom: 16, lineHeight: 16 },
  inlineLink: { color: colors.accent, textDecorationLine: 'underline' },
  gap: { height: 12 },
  error: { color: colors.danger, marginBottom: 12, fontSize: 14 },
  button: { backgroundColor: colors.accent, borderRadius: 8, padding: 16, alignItems: 'center', marginTop: 16 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
  link: { textAlign: 'center', marginTop: 16, color: colors.accent, fontSize: 14 },
});

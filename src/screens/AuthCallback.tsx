// src/screens/AuthCallback.tsx
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { resolveInitialRoute } from '../lib/initialRoute';
import { colors } from '../lib/theme';

// Экран подтверждения email. Раньше он вообще не существовал: SignUp
// отправлял письмо со ссылкой addate://auth/callback, но обработчика ссылки
// не было ни в одном месте — ни у NavigationContainer не было параметра
// linking, ни экрана, который обменял бы код на сессию. В итоге письмо
// приходило, пользователь по нему переходил, ничего не происходило, и
// единственный способ войти оставался ручной ввод пароля.
export default function AuthCallback() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const code = route.params?.code as string | undefined;

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function completeSignIn() {
      // Ссылка может прийти и без кода — например, старой, с токенами в
      // хеше, либо если пользователь открыл её в браузере.
      if (!code) {
        setError(
          'В ссылке нет кода подтверждения. Откройте приложение и войдите по email и паролю.'
        );
        return;
      }

      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (cancelled) return;

      if (exchangeError) {
        setError('Не удалось подтвердить адрес: ' + exchangeError.message);
        return;
      }

      try {
        const target = await resolveInitialRoute();
        if (cancelled) return;
        navigation.reset({ index: 0, routes: [{ name: target }] });
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    }

    completeSignIn();
    return () => {
      cancelled = true;
    };
  }, [code, navigation]);

  const goToSignIn = useCallback(() => {
    navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
  }, [navigation]);

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Не удалось подтвердить адрес</Text>
        <Text style={styles.body}>{error}</Text>
        <TouchableOpacity style={styles.button} onPress={goToSignIn}>
          <Text style={styles.buttonText}>На экран входа</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.accent} />
      <Text style={styles.body}>Подтверждаем адрес…</Text>
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
    marginTop: 12,
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

// src/ui/ErrorBoundary.tsx
//
// Ловит ошибки рендера и показывает сообщение вместо пустого экрана.
//
// Зачем: без предохранителя любая ошибка в компоненте (например, в новом
// экране, куда пользователь только что перешёл) размонтирует всё дерево
// React, и в браузере остаётся пустая страница без единой подсказки. Именно
// так выглядел переход «анкета → написать сообщение»: экран не рисовался, а
// причину увидеть было нельзя.
//
// Теперь на месте сломанного экрана видно сообщение об ошибке и кнопки
// «На главную» / «Обновить страницу».
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../lib/theme';
import { log } from '../lib/log';
import { isWeb, webUrl } from '../lib/webLinks';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // componentStack показывает, какой именно экран упал: без него в консоли
    // остаётся только текст ошибки.
    log.error('Ошибка интерфейса:', error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  private goHome = () => {
    if (typeof window !== 'undefined') {
      window.location.assign(webUrl());
    }
  };

  private reload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const onWeb = isWeb();

    return (
      <View style={styles.container}>
        <Text style={styles.title}>Что-то пошло не так</Text>
        <Text style={styles.body}>
          Экран не удалось показать. Попробуйте вернуться на главную — переписка и анкета останутся
          на месте.
        </Text>
        {!!error.message && <Text style={styles.detail}>{error.message}</Text>}

        <TouchableOpacity style={styles.button} onPress={onWeb ? this.goHome : this.retry}>
          <Text style={styles.buttonText}>{onWeb ? 'На главную' : 'Попробовать снова'}</Text>
        </TouchableOpacity>

        {onWeb && (
          <TouchableOpacity style={styles.secondaryButton} onPress={this.reload}>
            <Text style={styles.secondaryText}>Обновить страницу</Text>
          </TouchableOpacity>
        )}

        {Platform.OS === 'web' && (
          <Text style={styles.hint}>
            Если ошибка повторяется, пришлите этот текст разработчику.
          </Text>
        )}
      </View>
    );
  }
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
    marginBottom: 16,
    textAlign: 'center',
  },
  detail: {
    fontSize: 12,
    color: colors.textFaint,
    marginBottom: 20,
    textAlign: 'center',
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: { color: colors.white, fontWeight: '600' },
  secondaryButton: { paddingVertical: 12, paddingHorizontal: 24 },
  secondaryText: { color: colors.textSecondary, fontWeight: '600' },
  hint: { fontSize: 12, color: colors.textFaint, marginTop: 12, textAlign: 'center' },
});

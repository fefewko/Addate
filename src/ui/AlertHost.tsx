// src/ui/AlertHost.tsx
//
// Отрисовка диалогов на вебе. На нативе этим занимается системный Alert,
// здесь — обычный Modal, который react-native-web поддерживает полностью.
//
// Модальность нужна по трём причинам, а не ради единообразия:
//   * без неё «Удалить анкету» на вебе подтверждения не спросила бы и удалила;
//   * window.confirm не умеет стилизовать кнопки под тему и переносит
//     асинхронный onPress на перезагрузку страницы;
//   * часть вызовов передаёт две кнопки с разным смыслом («Написать
//     сообщение» / «Продолжить смотреть анкеты»), и им нужны настоящие
//     обработчики, а не один вызов confirm.
//
// Запросы выстраиваются в очередь, а не затирают друг друга: два диалога
// подряд из одного обработчика (показать ошибку и сразу предложить повтор)
// иначе приводили бы к потере первого.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { setAlertPresenter, type AlertButton, type AlertRequest } from '../lib/alert';
import { colors } from '../lib/theme';

const DEFAULT_BUTTON: AlertButton = { text: 'ОК' };

export default function AlertHost() {
  // null — диалогов нет. В очереди храним всё, что ещё не показано.
  const [current, setCurrent] = useState<AlertRequest | null>(null);
  const queue = useRef<AlertRequest[]>([]);

  const present = useCallback((request: AlertRequest) => {
    // Пока диалог открыт, следующий запрос встаёт в очередь, а не заменяет
    // открытый: иначе действие, выполняемое из onPress первого диалога,
    // могло бы потеряться вместе с ним.
    setCurrent((open) => {
      if (open) {
        queue.current.push(request);
        return open;
      }
      return request;
    });
  }, []);

  useEffect(() => {
    setAlertPresenter(present);
    return () => setAlertPresenter(null);
  }, [present]);

  const close = useCallback(() => {
    setCurrent(queue.current.shift() ?? null);
  }, []);

  const cancel = useCallback(
    (buttons: AlertButton[]) => {
      buttons.find((b) => b.style === 'cancel')?.onPress?.();
      close();
    },
    [close]
  );

  // Escape закрывает диалог. На нативе этим занимается системный Alert,
  // так что слушатель нужен только в браузере.
  useEffect(() => {
    if (Platform.OS !== 'web' || !current) return;

    const buttons = current.buttons && current.buttons.length > 0 ? current.buttons : [DEFAULT_BUTTON];
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel(buttons);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current, cancel]);

  if (!current) return null;

  const buttons: AlertButton[] =
    current.buttons && current.buttons.length > 0 ? current.buttons : [DEFAULT_BUTTON];

  // На iOS кнопки идут справа налево, на остальных платформах — слева направо.
  // Порядок в разметке нативного Alert задаёт платформа, и повторять его
  // пришлось бы, чтобы веб не отличался от телефона.
  const ordered = Platform.OS === 'ios' ? [...buttons].reverse() : buttons;

  const handlePress = (button: AlertButton) => {
    close();
    button.onPress?.();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close} accessibilityViewIsModal>
      <View style={styles.backdrop}>
        {/* Слой нажатия мимо диалога — отдельный элемент ПОД карточкой, а не
            её родитель. Если сделать его родителем, то в react-native-web
            нажатие по самому диалогу всплывало бы вверх и закрывало его,
            то есть нажатие «Удалить» закрывало бы окно до выполнения
            действия, а нажатие «Отмена» работало бы дважды. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => cancel(buttons)}
          accessibilityRole="button"
          accessibilityLabel="Закрыть"
        />

        <View style={styles.card} accessibilityRole="alert">
          {current.title ? <Text style={styles.title}>{current.title}</Text> : null}
          {current.message ? <Text style={styles.message}>{current.message}</Text> : null}

          <View style={styles.buttons}>
            {ordered.map((button, index) => {
              const destructive = button.style === 'destructive';
              const isCancel = button.style === 'cancel';
              return (
                <Pressable
                  key={`${button.text}-${index}`}
                  style={[
                    styles.button,
                    destructive && styles.buttonDestructive,
                    isCancel && styles.buttonCancel,
                  ]}
                  onPress={() => handlePress(button)}
                  accessibilityRole="button"
                >
                  <Text
                    style={[
                      styles.buttonText,
                      destructive && styles.buttonTextDestructive,
                      isCancel && styles.buttonTextCancel,
                    ]}
                  >
                    {button.text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
  },
  // Отступ под заголовком задаётся на тексте, а не на заголовке, чтобы он
  // не появлялся, когда сообщения нет: у одиночного «Готово» пустой отступ
  // выглядит как ошибка вёрстки.
  title: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  message: { fontSize: 14, lineHeight: 20, color: colors.textSecondary, marginBottom: 20 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' },
  button: {
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDestructive: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  buttonCancel: { backgroundColor: 'transparent' },
  buttonText: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  buttonTextDestructive: { color: colors.danger },
  buttonTextCancel: { color: colors.textSecondary },
});

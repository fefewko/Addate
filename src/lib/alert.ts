// src/lib/alert.ts
//
// Диалоги вместо Alert.alert из react-native.
//
// Зачем: в react-native-web класс Alert объявлен как
//     class Alert { static alert() {} }
// то есть на вебе он не показывает ничего. Из-за этого все 41 вызов
// Alert.alert в приложении на вебе молча исчезали: пользователь нажимал
// «Удалить анкету» и не видел ни подтверждения, ни ошибки, ни сообщения
// о совпадении. Кнопка «Удалить анкету» на вебе просто ничего не делала.
//
// Решение: тот же вызов appAlert.alert(...) на обеих платформах. На нативе
// это штатный системный диалог, на вебе — собственный модальный, который
// рисует AlertHost. Сигнатура намеренно повторяет Alert.alert, чтобы экраны
// не пришлось переписывать, а новые вызовы выглядели привычно.

import { Alert, Platform } from 'react-native';

export type AlertButton = {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
};

export type AlertRequest = {
  title?: string;
  message?: string;
  buttons?: AlertButton[];
};

type Presenter = (request: AlertRequest) => void;

// Обработчик, который рисует диалог. Устанавливается AlertHost при монтировании
// и снимается при размонтировании: без этой пары на вебе запросы уходили бы
// в никуда.
let presenter: Presenter | null = null;

export function setAlertPresenter(next: Presenter | null): void {
  presenter = next;
}

function showWeb(request: AlertRequest): void {
  if (presenter) {
    presenter(request);
    return;
  }

  // AlertHost ещё не смонтирован: экран вызвал диалог в своём же useEffect
  // при первом рендере. Молча проглотить запрос нельзя — пользователь не
  // поймёт, что произошло, поэтому показываем хотя бы системный диалог.
  const fallback = request.buttons?.find((b) => b.style === 'destructive')
    ?? request.buttons?.find((b) => b.style === 'default');
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    const ok = window.confirm([request.title, request.message].filter(Boolean).join('\n\n'));
    if (ok) fallback?.onPress?.();
    return;
  }
  fallback?.onPress?.();
}

export const appAlert = {
  // Сигнатура повторяет Alert.alert, включая обязательный title, чтобы
  // замена вызова была механической: иначе понадобилось бы править каждый
  // экран, а расхождение в подписях всплыло бы уже в вёрстке.
  alert(title: string, message?: string, buttons?: AlertButton[]): void {
    if (Platform.OS === 'web') {
      showWeb({ title, message, buttons });
      return;
    }

    Alert.alert(title, message, buttons);
  },
};

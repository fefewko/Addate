// src/lib/telegramAuth.ts
import { Linking } from 'react-native';
import { supabase } from './supabase';

export type TelegramLoginResult =
  | { status: 'success' }
  | { status: 'error'; message: string }
  | { status: 'timeout' };

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 60; // 60 * 2с = 2 минуты на подтверждение в Telegram

// Открывает диалог с ботом и ждёт, пока пользователь нажмёт Start.
// Реального deep-link обратно в приложение не требуется — как только
// telegram-exchange увидит статус 'confirmed', сессия создаётся тут же.
export async function loginWithTelegram(): Promise<TelegramLoginResult> {
  const { data: startData, error: startError } = await supabase.functions.invoke('telegram-start', {
    method: 'POST',
  });

  if (startError || !startData?.token || !startData?.deep_link) {
    return { status: 'error', message: startError?.message || 'Не удалось начать вход через Telegram.' };
  }

  const canOpen = await Linking.canOpenURL(startData.deep_link);
  if (!canOpen) {
    return { status: 'error', message: 'Не удалось открыть Telegram. Убедитесь, что приложение установлено.' };
  }
  await Linking.openURL(startData.deep_link);

  const token = startData.token;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const { data: exchangeData, error: exchangeError } = await supabase.functions.invoke('telegram-exchange', {
      method: 'POST',
      body: { token },
    });

    if (exchangeError) continue; // временный сбой сети — пробуем ещё раз на следующем тике

    if (exchangeData?.status === 'confirmed' && exchangeData.access_token) {
      const { error: setError } = await supabase.auth.setSession({
        access_token: exchangeData.access_token,
        refresh_token: exchangeData.refresh_token,
      });
      if (setError) return { status: 'error', message: setError.message };
      return { status: 'success' };
    }

    if (exchangeData?.status === 'expired') {
      return { status: 'error', message: 'Время на подтверждение истекло. Попробуйте снова.' };
    }
    // status === 'pending' — пользователь ещё не нажал Start, продолжаем ждать
  }

  return { status: 'timeout' };
}

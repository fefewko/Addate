// src/lib/pushNotifications.ts
import * as Notifications from 'expo-notifications';
import { log } from './log';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// В браузере push-уведомлений нет. Важно: Device.isDevice на вебе возвращает
// true, поэтому проверять только его нельзя — раньше регистрация токена
// запускалась при каждом открытии страницы, уходила в expo-notifications без
// веб-реализации, падала там и молча проглатывалась catch. Проверка именно
// платформы, а не устройства, закрывает и все остальные вызовы отсюда.
const SUPPORTED = Platform.OS !== 'web';

// Показывать уведомление баннером, даже если приложение открыто на переднем плане —
// иначе по умолчанию Expo молчит, пока пользователь смотрит в экран.
//
// shouldShowBanner — всплывающий баннер поверх экрана (Android и iOS 14+),
// shouldShowList — запись в шторке уведомлений / Центре уведомлений.
// Это два разных поля начиная с Expo SDK 54: старое shouldShowAlert больше
// не влияет на поведение, его заменили именно этими двумя.
//
// На вебе обработчик не нужен и только добавляет предупреждение в консоль,
// поэтому не устанавливается вовсе.
if (SUPPORTED) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export async function registerForPushNotifications(): Promise<void> {
  if (!SUPPORTED) return;

  try {
    if (!Device.isDevice) {
      return; // пуши не работают в симуляторе/эмуляторе без реального устройства
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      return; // пользователь не разрешил — молча пропускаем, не блокируем работу приложения
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
      });
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) {
      log.warn('Не найден projectId в app.json — push-токен не получить.');
      return;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    await supabase
      .from('push_tokens')
      .upsert({ user_id: user.id, expo_push_token: token, updated_at: new Date().toISOString() }, {
        onConflict: 'user_id,expo_push_token',
      });
  } catch (e) {
    log.warn('Не удалось зарегистрировать push-токен:', e);
  }
}

// Текущий push-токен устройства или null, если получить не удалось.
async function getCurrentToken(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return null;

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    return tokenData.data;
  } catch {
    return null;
  }
}

// Снимает токен именно этого устройства. Вызывать ДО supabase.auth.signOut():
// после выхода сессии нет, и удалить запись уже нечем.
//
// Удаляем только токен текущего устройства, а не все строки пользователя:
// иначе выход на телефоне A отключил бы уведомления на телефоне B, где
// пользователь всё ещё в аккаунте.
export async function unregisterPushToken(): Promise<void> {
  if (!SUPPORTED) return;

  try {
    const token = await getCurrentToken();
    if (!token) return;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase
      .from('push_tokens')
      .delete()
      .eq('user_id', user.id)
      .eq('expo_push_token', token);

    if (error) {
      log.warn('Не удалось снять push-токен:', error.message);
    }
  } catch (e) {
    log.warn('Не удалось снять push-токен:', e);
  }
}

// На iOS детализация разрешения живёт в ios.status, а не в корневом status:
// начиная с SDK 54 опираться нужно именно на неё. PROVISIONAL означает
// «показывать тихо», то есть уведомления приходят, — считаем, что доступ есть.
function isAllowed(perms: Notifications.NotificationPermissionsStatus): boolean {
  if (perms.granted) return true;
  return (
    Platform.OS === 'ios' &&
    perms.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  );
}

// Состояние разрешения на уведомления. Раньше тумблер в настройках был
// обычным локальным useState и не делал вообще ничего.
export async function getNotificationsEnabled(): Promise<boolean> {
  if (!SUPPORTED) return false;
  if (!Device.isDevice) return false;

  return isAllowed(await Notifications.getPermissionsAsync());
}

// Включение: спрашиваем системное разрешение и перерегистрировываем токен.
export async function enableNotifications(): Promise<boolean> {
  if (!SUPPORTED) return false;
  if (!Device.isDevice) return false;

  const existing = await Notifications.getPermissionsAsync();
  const perms = isAllowed(existing) ? existing : await Notifications.requestPermissionsAsync();

  if (!isAllowed(perms)) return false;

  await registerForPushNotifications();
  return true;
}

// Выключение: снимаем токен, чтобы сервер перестал слать уведомления на это
// устройство. Системное разрешение не отзываем: на iOS это всё равно делается
// только вручную через Настройки, а на Android отзыв лишил бы приложения
// локальных уведомлений вообще.
export async function disableNotifications(): Promise<void> {
  await unregisterPushToken();
}

// ---------------------------------------------------------------------------
// Диагностика push-уведомлений
// ---------------------------------------------------------------------------
//
// Пользователь сообщает «уведомления не приходят», а увидеть, на каком шаге
// цепочка рвётся, изнутри приложения до сих пор было нельзя. Цепочка длинная:
// разрешение ОС → Expo push-токен → строка в push_tokens → триггер в базе →
// Edge Function → Expo Push API → FCM → телефон. Здесь проверяется всё, что
// видно с клиента, включая самопроверку доставки (приложение отправляет push
// самому себе и смотрит квитанцию).
//
// Это не «тестовое уведомление» в обычном смысле: по результату видно, где
// именно проблема. «Отправка через Expo» с ошибкой InvalidCredentials /
// MismatchSenderId означает, что в проекте Expo не настроены FCM-ключи;
// успешная доставка при отсутствии уведомлений от собеседника означает, что
// дело в триггере/Edge Function на сервере.

export type PushCheckStatus = 'ok' | 'fail' | 'skip';

export type PushCheck = {
  title: string;
  status: PushCheckStatus;
  detail?: string;
};

const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

function shortenToken(token: string): string {
  return token.length > 20 ? `${token.slice(0, 12)}…${token.slice(-6)}` : token;
}

function describePushError(value: any): string {
  if (!value) return 'Пустой ответ сервиса Expo.';
  const code = value.details?.error ? ` (${value.details.error})` : '';
  return `${value.message ?? 'Неизвестная ошибка'}${code}`;
}

// Квитанция появляется не сразу: Expo передаёт push в FCM асинхронно.
async function waitForReceipt(id: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const res = await fetch(EXPO_PUSH_RECEIPTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      const json = await res.json();
      const receipt = json?.data?.[id];
      if (receipt) return receipt;
    } catch {
      // Сеть моргнула — пробуем ещё раз.
    }
  }
  return null;
}

export async function runPushDiagnostics(): Promise<PushCheck[]> {
  const checks: PushCheck[] = [];

  if (!SUPPORTED) {
    return [{ title: 'Платформа', status: 'skip', detail: 'В браузере push-уведомлений нет.' }];
  }

  checks.push({
    title: 'Платформа',
    status: 'ok',
    detail: Platform.OS === 'android' ? 'Android' : 'iOS',
  });

  if (!Device.isDevice) {
    checks.push({
      title: 'Устройство',
      status: 'fail',
      detail: 'Это эмулятор или симулятор: push приходят только на реальный телефон.',
    });
    return checks;
  }
  checks.push({ title: 'Устройство', status: 'ok', detail: 'Реальное устройство' });

  const perms = await Notifications.getPermissionsAsync();
  if (!isAllowed(perms)) {
    checks.push({
      title: 'Разрешение на уведомления',
      status: 'fail',
      detail: `Статус: ${perms.status}. Разрешите уведомления в системных настройках телефона.`,
    });
    return checks;
  }
  checks.push({ title: 'Разрешение на уведомления', status: 'ok' });

  if (Platform.OS === 'android') {
    const channel = await Notifications.getNotificationChannelAsync('default');
    checks.push({
      title: 'Канал уведомлений',
      status: channel ? 'ok' : 'fail',
      detail: channel
        ? `Важность: ${channel.importance}`
        : 'Канал default не создан — уведомление может не показаться.',
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    checks.push({
      title: 'Проект Expo',
      status: 'fail',
      detail: 'В app.json нет extra.eas.projectId — токен получить нельзя.',
    });
    return checks;
  }
  checks.push({ title: 'Проект Expo', status: 'ok', detail: projectId });

  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (e: any) {
    checks.push({ title: 'Push-токен', status: 'fail', detail: e?.message ?? String(e) });
    return checks;
  }
  checks.push({ title: 'Push-токен', status: 'ok', detail: shortenToken(token) });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    checks.push({ title: 'Аккаунт', status: 'fail', detail: 'Нет активной сессии.' });
    return checks;
  }

  const { data: rows, error: rowsError } = await supabase
    .from('push_tokens')
    .select('expo_push_token')
    .eq('user_id', user.id);

  if (rowsError) {
    checks.push({ title: 'Токен в базе', status: 'fail', detail: rowsError.message });
    return checks;
  }

  let tokens = (rows || []).map((row) => row.expo_push_token);
  let saved = tokens.includes(token);

  if (!saved) {
    // Токен не сохранён — обычно именно этого и не хватало. Сохраняем сейчас
    // и перечитываем, чтобы проверка была не только диагностикой, но и
    // починкой.
    await registerForPushNotifications();
    const { data: retried } = await supabase
      .from('push_tokens')
      .select('expo_push_token')
      .eq('user_id', user.id);
    tokens = (retried || []).map((row) => row.expo_push_token);
    saved = tokens.includes(token);
  }

  checks.push({
    title: 'Токен в базе',
    status: saved ? 'ok' : 'fail',
    detail: saved
      ? `Устройств в аккаунте: ${tokens.length}`
      : 'Не удалось сохранить токен в push_tokens — уведомления некуда отправлять.',
  });

  // Самопроверка: отправляем push самому себе через Expo Push API и смотрим,
  // что ответит сервис и что будет в квитанции о доставке.
  try {
    const res = await fetch(EXPO_PUSH_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        to: token,
        title: 'ADDate',
        body: 'Проверка уведомлений',
        sound: 'default',
        channelId: 'default',
        data: { diagnostics: true },
      }),
    });
    const json = await res.json();
    const ticket = Array.isArray(json?.data) ? json.data[0] : json?.data;

    if (!ticket || ticket.status !== 'ok') {
      checks.push({
        title: 'Отправка через Expo',
        status: 'fail',
        detail: describePushError(ticket),
      });
      return checks;
    }

    checks.push({
      title: 'Отправка через Expo',
      status: 'ok',
      detail: 'Сервис Expo принял запрос.',
    });

    const receipt = await waitForReceipt(ticket.id);
    if (!receipt) {
      checks.push({
        title: 'Доставка на телефон',
        status: 'skip',
        detail: 'Квитанция ещё не пришла. Если уведомление не появилось, повторите проверку.',
      });
    } else if (receipt.status === 'ok') {
      checks.push({
        title: 'Доставка на телефон',
        status: 'ok',
        detail: 'Уведомление передано в FCM.',
      });
    } else {
      checks.push({
        title: 'Доставка на телефон',
        status: 'fail',
        detail: describePushError(receipt),
      });
    }
  } catch (e: any) {
    checks.push({
      title: 'Отправка через Expo',
      status: 'fail',
      detail: e?.message ?? String(e),
    });
  }

  return checks;
}

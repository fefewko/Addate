// src/lib/pushNotifications.ts
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// Показывать уведомление баннером, даже если приложение открыто на переднем плане —
// иначе по умолчанию Expo молчит, пока пользователь смотрит в экран.
//
// shouldShowBanner — всплывающий баннер поверх экрана (Android и iOS 14+),
// shouldShowList — запись в шторке уведомлений / Центре уведомлений.
// Это два разных поля начиная с Expo SDK 54: старое shouldShowAlert больше
// не влияет на поведение, его заменили именно этими двумя.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotifications(): Promise<void> {
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
      console.warn('Не найден projectId в app.json — push-токен не получить.');
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
    console.warn('Не удалось зарегистрировать push-токен:', e);
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
      console.warn('Не удалось снять push-токен:', error.message);
    }
  } catch (e) {
    console.warn('Не удалось снять push-токен:', e);
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
  if (!Device.isDevice) return false;

  return isAllowed(await Notifications.getPermissionsAsync());
}

// Включение: спрашиваем системное разрешение и перерегистрировываем токен.
export async function enableNotifications(): Promise<boolean> {
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

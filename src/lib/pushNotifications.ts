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

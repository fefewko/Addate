// App.tsx
import 'react-native-url-polyfill/auto';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, AppState } from 'react-native';
import {
  NavigationContainer,
  DarkTheme,
  useNavigation,
  createNavigationContainerRef,
  type LinkingOptions,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Notifications from 'expo-notifications';

import { supabase } from './src/lib/supabase';
import { registerForPushNotifications } from './src/lib/pushNotifications';

import SignIn from './src/screens/SignIn';
import SignUp from './src/screens/SignUp';
import ProfileSetup from './src/screens/ProfileSetup';
import ModerationPending from './src/screens/ModerationPending';
import Feed from './src/screens/Feed';
import AllUsers from './src/screens/AllUsers';
import ChatList from './src/screens/ChatList';
import Chat from './src/screens/Chat';
import Profile from './src/screens/Profile';
import Settings from './src/screens/Settings';
import BlockedUsers from './src/screens/BlockedUsers';
import IncomingLikes from './src/screens/IncomingLikes';
import ProfileDetail from './src/screens/ProfileDetail';
import AuthCallback from './src/screens/AuthCallback';
import LoadError from './src/ui/LoadError';
import { resolveInitialRoute, type InitialRoute } from './src/lib/initialRoute';
import { log } from './src/lib/log';
import type { RootNavigation, RootParamList } from './src/lib/navigation';
import { colors } from './src/lib/theme';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// Обработка входящих ссылок. Без этого параметра ссылка из письма
// (addate://auth/callback?code=...) не доходила до приложения, и подтверждение
// email было невозможно завершить.
//
// Вложенные пути вкладок получили имена 'all', 'chats' и 'me' — намеренно.
// Схема 'profile' занята полной анкетой (profile/:profileId), и если бы
// вкладка профиля называлась так же, пути стали бы неоднозначными.
const linking: LinkingOptions<any> = {
  prefixes: ['addate://'],
  config: {
    screens: {
      AuthCallback: 'auth/callback',
      Tabs: {
        screens: {
          Feed: '',
          AllUsers: 'all',
          ChatList: 'chats',
          Profile: 'me',
        },
      },
      ProfileDetail: 'profile/:profileId',
      Chat: 'chat/:matchId',
      Settings: 'settings',
      BlockedUsers: 'blocked',
      IncomingLikes: 'likes',
    },
  },
};
const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Feed: 'flame',
  AllUsers: 'people',
  ChatList: 'chatbubbles',
  Profile: 'person-circle',
};

const HEARTBEAT_INTERVAL_MS = 45_000;

// Навигация вне дерева компонентов. Нужна для двух случаев, которых не
// покрывает useNavigation:
//   * переход по нажатию на push, когда приложение запускается с нуля;
//   * переход после того, как навигатор смонтирован (onReady).
const navigationRef = createNavigationContainerRef<RootParamList>();

type PushPayload = {
  matchId?: string;
  otherUserId?: string;
  otherName?: string;
  otherAge?: number | null;
};

// Защита от повторной обработки. Нажатие на push при живом приложении
// обрабатывается подпиской, а при холодном старте — getLastNotificationResponse.
// Оба пути иногда срабатывают для одного и того же касания.
let lastHandledNotificationId: string | null = null;

function handleNotificationResponse(response: Notifications.NotificationResponse) {
  const id = response.notification.request.identifier;
  if (id && id === lastHandledNotificationId) return;
  lastHandledNotificationId = id ?? null;

  const data = response.notification.request.content.data as PushPayload | undefined;

  // В разработке полезно видеть, что именно пришло в уведомлении: если
  // push собирается без otherUserId, диалог не откроется и сработает
  // запасной переход в список чатов.
  log.debug('Нажатие на push, payload:', JSON.stringify(data));

  if (!data?.matchId) {
    log.debug('Нажатие на push без matchId в данных');
    return;
  }

  if (!navigationRef.isReady()) {
    // Навигатор ещё не смонтирован. Ответ не теряем: его доберёт
    // getLastNotificationResponse в onReady.
    log.debug('Навигатор не готов, переход отложен до onReady');
    return;
  }

  if (data.otherUserId) {
    navigationRef.navigate('Chat', {
      matchId: data.matchId,
      otherUserId: data.otherUserId,
      otherName: data.otherName,
      otherAge: data.otherAge ?? undefined,
    });
  } else {
    // В старых уведомлениях полных данных о собеседнике нет — открываем
    // список чатов. ChatList является вкладкой нижней навигации, а не экраном
    // корневого стека, поэтому идём через Tabs.
    navigationRef.navigate('Tabs', { screen: 'ChatList' });
  }

  // Ответ обработан: сбрасываем, иначе следующий холодный старт снова
  // откроет этот диалог.
  Notifications.clearLastNotificationResponseAsync().catch(() => {});
}

// Приложение могло быть убито, и нажатие на уведомление запустило его с нуля.
// В этом случае подписка addNotificationResponseReceivedListener не срабатывает
// никогда — она регистрируется только в живом процессе. Ответ нужно забрать
// отдельно, и только когда навигатор готов.
async function handlePendingNotificationResponse() {
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    if (response) handleNotificationResponse(response);
  } catch (e) {
    log.warn('Не удалось прочитать последнее нажатие на уведомление:', e);
  }
}

function Tabs() {
  const navigation = useNavigation<RootNavigation>();
  const [unreadCount, setUnreadCount] = useState(0);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendHeartbeat = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', user.id);
  }, []);

  const refreshUnreadCount = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    // RLS уже ограничивает видимые сообщения только моими совпадениями,
    // так что достаточно отфильтровать непрочитанные не от меня.
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null)
      .neq('sender_id', user.id);

    setUnreadCount(count || 0);
  }, []);

  useEffect(() => {
    sendHeartbeat();
    refreshUnreadCount();
    registerForPushNotifications();

    heartbeatTimer.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        sendHeartbeat();
        refreshUnreadCount();
      }
    });

    // Realtime: обновляем счётчик сразу при новом сообщении или отметке "прочитано".
    // Перезагрузка отложена: событие приходит на каждое сообщение, а счётчик
    // требует запроса с count. При серии сообщений без паузы получим серию
    // одинаковых запросов — бейдж не изменится между ними.
    let unreadTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel('unread-messages-watcher')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
        if (unreadTimer) clearTimeout(unreadTimer);
        unreadTimer = setTimeout(() => {
          unreadTimer = null;
          refreshUnreadCount();
        }, 800);
      })
      .subscribe();

    // Тап по push-уведомлению, когда приложение уже в памяти.
    // Холодный старт обрабатывается отдельно, в onReady.
    const notificationSub = Notifications.addNotificationResponseReceivedListener(
      handleNotificationResponse
    );

    return () => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (unreadTimer) clearTimeout(unreadTimer);
      appStateSub.remove();
      supabase.removeChannel(channel);
      notificationSub.remove();
    };
  }, [sendHeartbeat, refreshUnreadCount, navigation]);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons
            name={
              (focused
                ? TAB_ICONS[route.name]
                : (`${TAB_ICONS[route.name]}-outline` as keyof typeof Ionicons.glyphMap)) ||
              'ellipse'
            }
            size={size}
            color={color}
          />
        ),
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.textPrimary,
      })}
    >
      <Tab.Screen name="Feed" component={Feed} options={{ title: 'Анкеты' }} />
      <Tab.Screen name="AllUsers" component={AllUsers} options={{ title: 'Все' }} />
      <Tab.Screen
        name="ChatList"
        component={ChatList}
        options={{ title: 'Сообщения', tabBarBadge: unreadCount > 0 ? unreadCount : undefined }}
      />
      <Tab.Screen name="Profile" component={Profile} options={{ title: 'Профиль' }} />
    </Tab.Navigator>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [initialRoute, setInitialRoute] = useState<InitialRoute>('SignIn');

  useEffect(() => {
    determineInitialRoute();
  }, []);

  // Реакция на потерю сессии. Раньше подписки на auth не было вовсе: если
  // refresh-токен истёк или был отозван, приложение оставалось «внутри»,
  // и все запросы молча падали. Теперь такого пользователь возвращается
  // на экран входа.
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // TOKEN_REFRESHED намеренно не трогаем: он приходит каждые ~50 минут,
      // и пересборка начального маршрута на каждом обновлении токена
      // выбрасывала бы пользователя с текущего экрана.
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN' && !session)) {
        setInitialRoute('SignIn');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Перепроверка анкеты при возвращении в приложение. Если модератор
  // отклонил анкету, пока пользователь им пользовался, он узнавал об этом
  // только после переустановки.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        determineInitialRoute();
      }
    });
    return () => sub.remove();
  }, []);

  async function determineInitialRoute() {
    // Раньше здесь стоял голый `return` при отсутствии пользователя, из-за
    // чего loading навсегда оставался true и приложение не стартовало:
    // пользователь видел только вечный спиннер, без входа и без сообщения.
    try {
      setInitialRoute(await resolveInitialRoute());
    } catch (e: any) {
      setFatalError(e.message);
    }
    setLoading(false);
  }

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (fatalError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <LoadError message={fatalError} onRetry={() => {
          setFatalError(null);
          setLoading(true);
          determineInitialRoute();
        }} />
      </View>
    );
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={DarkTheme}
      linking={linking}
      onReady={() => {
        // Приложение могло быть убито, и нажатие на push запустило его с нуля.
        // В этом случае подписка не сработала никогда, и переход в диалог
        // нужно выполнить здесь — навигатор к этому моменту уже готов.
        handlePendingNotificationResponse();
      }}
    >
      {/* key={initialRoute} — начальный маршрут навигатора применяется только
          при первом монтировании, поэтому смена статуса модерации сама по себе
          ни к чему бы не привела. Ключ заставляет стек пересобраться, когда
          маршрут действительно изменился, и не трогает его, когда остался
          прежним: тогда пользователя не выбрасывает с текущего экрана. */}
      <Stack.Navigator key={initialRoute} initialRouteName={initialRoute}>
        <Stack.Screen name="SignIn" component={SignIn} options={{ headerShown: false }} />
        <Stack.Screen name="SignUp" component={SignUp} options={{ headerShown: false }} />
        <Stack.Screen name="AuthCallback" component={AuthCallback} options={{ headerShown: false }} />
        <Stack.Screen
          name="ProfileSetup"
          component={ProfileSetup}
          options={{ title: 'Анкета' }}
        />
        <Stack.Screen
          name="ModerationPending"
          component={ModerationPending}
          options={{ headerShown: false }}
        />
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen
          name="ProfileDetail"
          component={ProfileDetail}
          options={{ title: 'Анкета', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.textPrimary }}
        />
        <Stack.Screen name="Chat" component={Chat} options={{ title: 'Чат' }} />
        <Stack.Screen
          name="Settings"
          component={Settings}
          options={{ title: 'Настройки', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.textPrimary }}
        />
        <Stack.Screen
          name="BlockedUsers"
          component={BlockedUsers}
          options={{ title: 'Заблокированные', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.textPrimary }}
        />
        <Stack.Screen
          name="IncomingLikes"
          component={IncomingLikes}
          options={{ title: 'Вы понравились', headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.textPrimary }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

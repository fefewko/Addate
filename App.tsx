// App.tsx
import 'react-native-url-polyfill/auto';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ActivityIndicator, AppState } from 'react-native';
import { NavigationContainer, DarkTheme, useNavigation } from '@react-navigation/native';
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
import LoadError from './src/ui/LoadError';
import { colors } from './src/lib/theme';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Feed: 'flame',
  AllUsers: 'people',
  ChatList: 'chatbubbles',
  Profile: 'person-circle',
};

const HEARTBEAT_INTERVAL_MS = 45_000;

function Tabs() {
  const navigation = useNavigation<any>();
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

    // Realtime: обновляем счётчик сразу при новом сообщении или отметке "прочитано"
    const channel = supabase
      .channel('unread-messages-watcher')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
        refreshUnreadCount();
      })
      .subscribe();

    // Тап по push-уведомлению о новом сообщении — сразу открываем список чатов
    // (полные данные о собеседнике подтянутся уже там, у нас есть только matchId)
    const notificationSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        | { matchId?: string; otherUserId?: string; otherName?: string; otherAge?: number | null }
        | undefined;

      if (data?.matchId && data?.otherUserId) {
        navigation.navigate('Chat', {
          matchId: data.matchId,
          otherUserId: data.otherUserId,
          otherName: data.otherName,
          otherAge: data.otherAge ?? undefined,
        });
      } else if (data?.matchId) {
        // На случай старых уведомлений без полных данных — хотя бы список чатов
        navigation.navigate('ChatList');
      }
    });

    return () => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
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

type InitialRoute = 'SignIn' | 'ProfileSetup' | 'ModerationPending' | 'Tabs';

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
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) {
      setFatalError('Не удалось проверить сессию: ' + sessionError.message);
      setLoading(false);
      return;
    }

    if (!session) {
      setInitialRoute('SignIn');
      setLoading(false);
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('moderation_status, display_name')
      .eq('id', session.user.id)
      .maybeSingle();

    if (profileError) {
      setFatalError('Не удалось загрузить анкету: ' + profileError.message);
      setLoading(false);
      return;
    }

    if (!profile || !profile.display_name) {
      setInitialRoute('ProfileSetup');
    } else if (profile.moderation_status === 'approved') {
      setInitialRoute('Tabs');
    } else {
      setInitialRoute('ModerationPending');
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
    <NavigationContainer theme={DarkTheme}>
      {/* key={initialRoute} — начальный маршрут навигатора применяется только
          при первом монтировании, поэтому смена статуса модерации сама по себе
          ни к чему бы не привела. Ключ заставляет стек пересобраться, когда
          маршрут действительно изменился, и не трогает его, когда остался
          прежним: тогда пользователя не выбрасывает с текущего экрана. */}
      <Stack.Navigator key={initialRoute} initialRouteName={initialRoute}>
        <Stack.Screen name="SignIn" component={SignIn} options={{ headerShown: false }} />
        <Stack.Screen name="SignUp" component={SignUp} options={{ headerShown: false }} />
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

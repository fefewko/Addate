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
import ProfileDetail from './src/screens/ProfileDetail';

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
      const matchId = response.notification.request.content.data?.matchId;
      if (matchId) {
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
        tabBarActiveTintColor: '#3b82f6',
        tabBarInactiveTintColor: '#8a8a8e',
        tabBarStyle: { backgroundColor: '#121212', borderTopColor: '#2a2a2a' },
        headerStyle: { backgroundColor: '#121212' },
        headerTintColor: '#f0f0f0',
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
  const [initialRoute, setInitialRoute] = useState<InitialRoute>('SignIn');

  useEffect(() => {
    determineInitialRoute();
  }, []);

  async function determineInitialRoute() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      setInitialRoute('SignIn');
      setLoading(false);
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('moderation_status, display_name')
      .eq('id', session.user.id)
      .maybeSingle();

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
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#121212' }}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={DarkTheme}>
      <Stack.Navigator initialRouteName={initialRoute}>
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
          options={{ title: 'Анкета', headerStyle: { backgroundColor: '#121212' }, headerTintColor: '#f0f0f0' }}
        />
        <Stack.Screen name="Chat" component={Chat} options={{ title: 'Чат' }} />
        <Stack.Screen
          name="Settings"
          component={Settings}
          options={{ title: 'Настройки', headerStyle: { backgroundColor: '#121212' }, headerTintColor: '#f0f0f0' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

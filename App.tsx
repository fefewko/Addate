// App.tsx
import 'react-native-url-polyfill/auto';
import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { supabase } from './src/lib/supabase';

import SignIn from './src/screens/SignIn';
import SignUp from './src/screens/SignUp';
import ProfileSetup from './src/screens/ProfileSetup';
import ModerationPending from './src/screens/ModerationPending';
import Feed from './src/screens/Feed';
import AllUsers from './src/screens/AllUsers';
import ChatList from './src/screens/ChatList';
import Chat from './src/screens/Chat';
import Profile from './src/screens/Profile';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function Tabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: true }}>
      <Tab.Screen name="Feed" component={Feed} options={{ title: 'Анкеты' }} />
      <Tab.Screen name="AllUsers" component={AllUsers} options={{ title: 'Все' }} />
      <Tab.Screen name="ChatList" component={ChatList} options={{ title: 'Сообщения' }} />
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
        <Stack.Screen name="Chat" component={Chat} options={{ title: 'Чат' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

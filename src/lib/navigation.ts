// src/lib/navigation.ts
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

// Вкладки нижней навигации вынесены отдельным списком: до них нельзя дойти
// напрямую из корневого стека, только через Tabs с указанием вложенного экрана.
// Раньше это не было выражено в типах, и navigation.navigate('ChatList')
// из корневого стека молча проходил, хотя такого маршрута там нет.
export type TabParamList = {
  Feed: undefined;
  AllUsers: undefined;
  ChatList: undefined;
  Profile: undefined;
};

// Типы маршрутов и их параметров. Раньше навигация была везде
// useNavigation<any>(), и это не давало ничего: и опечатку в имени экрана, и
// забытый обязательный параметр компилятор пропускал. Именно так в приложение
// пробрался вызов .eq('id', undefined) — Chat получали без otherUserId при
// входе по ссылке chat/:matchId, и PostgREST отклонял запрос.
export type RootParamList = {
  SignIn: undefined;
  SignUp: undefined;
  AuthCallback: { code?: string } | undefined;
  ProfileSetup: undefined;
  ModerationPending: undefined;
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  ProfileDetail: { profileId: string };
  // Поля nullable, потому что приходят прямо из базы: display_name и дата
  // рождения у собеседника могут быть null.
  Chat: {
    matchId: string;
    otherUserId?: string;
    otherName?: string | null;
    otherAge?: number | null;
  };
  Settings: undefined;
  BlockedUsers: undefined;
  IncomingLikes: undefined;
};

export type RootNavigation = NativeStackNavigationProp<RootParamList>;

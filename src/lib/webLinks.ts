// src/lib/webLinks.ts
//
// Адреса веб-версии и маршрутизация под /web.
//
// Зачем: их используют несколько независимых мест — конфиг навигации, ссылка
// подтверждения email из письма и заголовок страницы. Если каждое соберёт
// адрес самостоятельно, они рано или поздно разойдутся.
//
// Путь /web повторяет experiments.baseUrl в app.json. Expo читает его оттуда
// при сборке, а из кода он недоступен, поэтому значение повторяется здесь
// вручную — с проверкой в scripts/verify-web.js, которая падает, если
// конфиг и этот файл разошлись.

import { Platform } from 'react-native';
import {
  getPathFromState as getPathFromStateDefault,
  getStateFromPath as getStateFromPathDefault,
} from '@react-navigation/native';
import type { LinkingOptions } from '@react-navigation/native';
import { buildWebPath, stripWebBase, WEB_BASE_PATH } from './webPaths';

export { WEB_BASE_PATH };

export function isWeb(): boolean {
  return Platform.OS === 'web';
}

// Реальный origin берём из браузера, а не из константы: тогда development-сборка
// на localhost и production на addate.ru используют один и тот же код.
// Запасной вариант нужен на случай вызова до инициализации окна (тесты, SSR).
function webOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'https://addate.ru';
}

// Полный адрес экрана на вебе: origin + /web + путь.
export function webUrl(path = ''): string {
  const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `${webOrigin()}${WEB_BASE_PATH}${suffix}`;
}

// Адрес, на который Supabase отправит письмо с подтверждением.
//
// На нативе это схема addate:// — её открывает установленное приложение.
// На вебе схему браузер не понимает, и письмо ушло бы в никуда: ссылка
// должна вести на https://addate.ru/web/auth/callback. Этот адрес ещё нужно
// внести в раздел Redirect URLs в панели Supabase, иначе Supabase отклонит
// его и вернёт на сайт по умолчанию.
export function emailRedirectUrl(): string {
  return isWeb() ? webUrl('auth/callback') : 'addate://auth/callback';
}

// Пути экранов на вебе. Имена маршрутов пришлось бы ставить строчными и
// без префикса /web — но React Navigation всё равно отдаёт путь без ведущего
// слеша, и браузер разрешает его относительно текущего адреса. Из /web/
// строка 'SignIn' превращается в /SignIn — то есть теряет и префикс, и
// смысл. Поэтому пути собраны вручную и всегда абсолютные.
const WEB_PATHS = {
  signIn: 'signin',
  signUp: 'signup',
  authCallback: 'auth/callback',
  feed: 'feed',
  allUsers: 'all',
  chatList: 'chats',
  profile: 'me',
  profileSetup: 'setup',
  moderationPending: 'moderation',
  profileDetail: 'profile/:profileId',
  chat: 'chat/:matchId',
  settings: 'settings',
  privacy: 'privacy',
  documents: 'documents',
  changePassword: 'change-password',
  blockedUsers: 'blocked',
  incomingLikes: 'likes',
} as const;

// Конфиг экранов общий для обеих платформ, кроме пути ленты: на нативе он
// пустой, на вебе корень подкаталога намеренно не соответствует ни одному
// экрану, иначе '/web/' открывал бы защищённый экран мимо проверки сессии.
function screensForWeb() {
  return {
    SignIn: WEB_PATHS.signIn,
    SignUp: WEB_PATHS.signUp,
    AuthCallback: WEB_PATHS.authCallback,
    ProfileSetup: WEB_PATHS.profileSetup,
    ModerationPending: WEB_PATHS.moderationPending,
    ProfileDetail: WEB_PATHS.profileDetail,
    Chat: WEB_PATHS.chat,
    Settings: WEB_PATHS.settings,
    Privacy: WEB_PATHS.privacy,
    Documents: WEB_PATHS.documents,
    ChangePassword: WEB_PATHS.changePassword,
    BlockedUsers: WEB_PATHS.blockedUsers,
    IncomingLikes: WEB_PATHS.incomingLikes,
    Tabs: {
      screens: {
        Feed: WEB_PATHS.feed,
        AllUsers: WEB_PATHS.allUsers,
        ChatList: WEB_PATHS.chatList,
        Profile: WEB_PATHS.profile,
      },
    },
  };
}

function screensForNative() {
  return {
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
  };
}

export function buildLinking(): LinkingOptions<any> {
  if (!isWeb()) {
    return { prefixes: ['addate://'], config: { screens: screensForNative() } };
  }

  return {
    prefixes: [`${webOrigin()}${WEB_BASE_PATH}`],
    config: { screens: screensForWeb() },

    // Состояние -> адрес. Разбор путей живёт в webPaths.ts, здесь только
    // подстановка стандартной функции React Navigation.
    getPathFromState: (state, config) =>
      buildWebPath(getPathFromStateDefault(state, config)),

    // Адрес -> состояние: убрать префикс, разобрать, и вернуть префикс в поле
    // path листового экрана. Последнее обязательно: useLinking при записи
    // адреса доверяет этому полю больше, чем getPathFromState, чтобы не ломать
    // маршруты с параметрами, — и без префикса адресная строка теряла '/web'.
    getStateFromPath: (path, config) => {
      const normalized = stripWebBase(path);
      const state = getStateFromPathDefault(normalized, config);

      if (state) {
        const leaf = findLeafRoute(state);
        if (leaf) leaf.path = buildWebPath(normalized);
      }

      return state;
    },
  };
}

// Лист состояния — самый глубокий экран. Именно ему getStateFromPath
// проставляет поле path, и именно его useLinking потом записывает в адресную
// строку как есть, мимо getPathFromState. Поэтому префикс добавляется здесь:
// иначе путь 'all' разрешается относительно '/web/all' и превращается в
// '/web/all' при одном раскладе и в '/all' при другом — адрес получался
// случайным.
function findLeafRoute(state: any): any {
  if (!state?.routes?.length) return null;
  const last = state.routes[state.routes.length - 1];
  return last?.state ? findLeafRoute(last.state) : last;
}

// Заголовок вкладки. По умолчанию React Navigation подставляет имя маршрута,
// и вкладка называлась бы «SignIn» или «Feed» — на публичном сайте это
// выглядит как ошибка, особенно в истории браузера.
export function documentTitleFormatter(options: any, route: any): string {
  const base = 'ADDate';
  const title = options?.title ?? route?.name;
  if (!title || title === route?.name) return base;
  return `${title} — ${base}`;
}

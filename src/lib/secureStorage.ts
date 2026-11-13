// src/lib/secureStorage.ts
//
// Секреты (приватный ключ E2EE и выведенный из пароля ключ резервной копии)
// хранятся в защищённом хранилище ОС: Android Keystore / iOS Keychain через
// expo-secure-store. Раньше они лежали в AsyncStorage — обычном файле в песочнице
// приложения, который попадает в резервные копии и читается на рутованном
// устройстве без дополнительных усилий.
//
// На вебе защищённого хранилища нет: expo-secure-store там не работает. Для веба
// оставляем AsyncStorage (localStorage), потому что другого варианта нет, и
// честно пишем это в отчёте. На мобильных ключи в AsyncStorage больше не пишутся.
//
// Миграция: при первом чтении секрет ищется в SecureStore, а если его там нет —
// в старом месте (AsyncStorage). Найденное переносится в SecureStore, из
// AsyncStorage удаляется. Так обновление приложения не теряет уже выданные ключи
// и не ломает историю переписки.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { log } from './log';

const NATIVE = Platform.OS !== 'web';

// SecureStore принимает только буквы, цифры, точку, дефис и подчёркивание.
// Наши ключи содержат двоеточия (`e2ee:privateKey:<uuid>`), поэтому для
// хранилища ОС они кодируются, а в AsyncStorage остаются в прежнем виде —
// иначе миграция не найдёт старые значения.
function nativeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  // Ключ доступен только после разблокировки устройства и не синхронизируется
  // через облачную резервную копию: на новом устройстве он должен
  // восстанавливаться из e2ee_key_backups по паролю, а не переезжать молча.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function secureStoreAvailable(): Promise<boolean> {
  if (!NATIVE) return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function readLegacy(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch (e) {
    log.warn('Защищённое хранилище: не удалось прочитать старое значение:', e);
    return null;
  }
}

// Читает секрет. Порядок: SecureStore → старое место → null.
export async function getSecret(key: string): Promise<string | null> {
  if (NATIVE) {
    try {
      const value = await SecureStore.getItemAsync(nativeKey(key), OPTIONS);
      if (value !== null) return value;
    } catch (e) {
      // Keystore может быть недоступен (сбой OEM, сброс блокировки экрана).
      // Падать из-за этого нельзя: иначе приложение не откроет чат вообще.
      log.warn('Защищённое хранилище: чтение не удалось, пробуем старое место:', e);
    }
  }

  const legacy = await readLegacy(key);
  if (legacy !== null && NATIVE) {
    // Переносим в защищённое хранилище и убираем открытую копию.
    try {
      await SecureStore.setItemAsync(nativeKey(key), legacy, OPTIONS);
      await AsyncStorage.removeItem(key);
    } catch (e) {
      log.warn('Защищённое хранилище: не удалось перенести старое значение:', e);
    }
  }
  return legacy;
}

// Записывает секрет. Если SecureStore недоступен — откатывается на AsyncStorage,
// чтобы приложение осталось работоспособным, а не блокировало переписку.
export async function setSecret(key: string, value: string): Promise<void> {
  if (NATIVE) {
    try {
      await SecureStore.setItemAsync(nativeKey(key), value, OPTIONS);
      // Старая открытая копия больше не нужна.
      await AsyncStorage.removeItem(key).catch(() => undefined);
      return;
    } catch (e) {
      log.warn('Защищённое хранилище: запись не удалась, используем AsyncStorage:', e);
    }
  }

  await AsyncStorage.setItem(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  if (NATIVE) {
    try {
      await SecureStore.deleteItemAsync(nativeKey(key), OPTIONS);
    } catch (e) {
      log.warn('Защищённое хранилище: удаление не удалось:', e);
    }
  }
  await AsyncStorage.removeItem(key).catch(() => undefined);
}

// Только для диагностики в отчёте/настройках: где реально лежит секрет.
export async function secureStorageKind(): Promise<'keychain' | 'async-storage'> {
  return (await secureStoreAvailable()) ? 'keychain' : 'async-storage';
}

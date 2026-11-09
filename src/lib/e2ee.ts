// src/lib/e2ee.ts
//
// End-to-end шифрование переписки (E2EE) между пользователями.
//
// Модель:
//   - У каждого пользователя есть долгосрочный keypair (X25519). Публичный ключ
//     хранится в таблице profiles.public_key, приватный — локально на устройстве
//     (AsyncStorage, ключ `e2ee:privateKey:<userId>`).
//   - Для каждого сообщения создаётся одноразовый nonce и шифруется через
//     crypto_box (ECDH + SecretBox: sender → recipient).
//   - В БД (messages.content) сохраняется только ciphertext (JSON: {v, nonce, ct}).
//   - Сервер видит только ciphertext; доступ к plaintext — только у участников.
//
// Крипто-ядро — tweetnacl (чистый JS: X25519 + XSalsa20-Poly1305). Раньше здесь
// был libsodium-wrappers, но его WASM/asm.js-сборка инициализировалась при
// загрузке модуля и роняла приложение при холодном старте в Hermes. TweetNaCl
// не использует WebAssembly и не выполняет тяжёлой работы при импорте.
//
// Формат ciphertext совместим с прежним (libsodium crypto_box_easy): MAC (16
// байт) + ciphertext, nonce — 24 байта. Ключи и уже сохранённые сообщения
// остаются читаемыми.

import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import * as Crypto from 'expo-crypto';
import { supabase } from './supabase';
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from './encoding';

export type E2EEPayload = {
  v: 1;
  nonce: string;
  ct: string;
};

const privateKeyKey = (userId: string) => `e2ee:privateKey:${userId}`;

// TweetNaCl берёт случайные байты из crypto.getRandomValues, которого в React
// Native нет. Подставляем нативный генератор expo-crypto. Функция вызывается
// лениво: PRNG нужен только в момент реальной крипто-операции.
let prngConfigured = false;

function getNacl(): typeof nacl {
  if (!prngConfigured) {
    nacl.setPRNG((target: Uint8Array, length: number) => {
      // expo-crypto отдаёт не больше 1024 байт за вызов.
      let offset = 0;
      while (offset < length) {
        const chunkSize = Math.min(1024, length - offset);
        target.set(Crypto.getRandomBytes(chunkSize), offset);
        offset += chunkSize;
      }
    });
    prngConfigured = true;
  }
  return nacl;
}

export async function getLocalPrivateKey(userId: string): Promise<Uint8Array | null> {
  const stored = await AsyncStorage.getItem(privateKeyKey(userId));
  if (!stored) {
    return null;
  }
  return base64ToBytes(stored);
}

export type EnsureIdentityResult = {
  /** Локальный приватный ключ (null — если создать/прочитать не удалось). */
  privateKey: Uint8Array | null;
  /** Публичный ключ, соответствующий локальному приватному (base64). */
  publicKeyB64: string | null;
  /** true — в profiles.public_key лежит именно наш ключ. */
  ownPublicKeyPublished: boolean;
  /** true — в профиле сохранён ключ другого устройства. */
  keyConflict: boolean;
  /** Ошибка чтения/записи profiles.public_key (например, нет гранта). */
  publicKeyError: unknown;
  /** Ошибка локального хранилища ключей. */
  localKeyError: unknown;
};

// Создаёт (или находит) локальную пару ключей и публикует публичный ключ в
// профиле. Возвращает не только ключ, но и состояние публикации: без него
// невозможно понять, почему собеседник не видит наш ключ.
export async function ensureIdentity(userId: string): Promise<EnsureIdentityResult> {
  const result: EnsureIdentityResult = {
    privateKey: null,
    publicKeyB64: null,
    ownPublicKeyPublished: false,
    keyConflict: false,
    publicKeyError: null,
    localKeyError: null,
  };

  // 1. Локальный приватный ключ. Создаём при первом входе и сохраняем сразу,
  //    не дожидаясь сети: приватный ключ не должен зависеть от доступности БД.
  try {
    let privateKey = await getLocalPrivateKey(userId);
    if (!privateKey) {
      privateKey = getNacl().box.keyPair().secretKey;
      await AsyncStorage.setItem(privateKeyKey(userId), bytesToBase64(privateKey));
    }
    result.privateKey = privateKey;
    result.publicKeyB64 = bytesToBase64(
      getNacl().box.keyPair.fromSecretKey(privateKey).publicKey
    );
  } catch (e) {
    result.localKeyError = e;
    return result;
  }

  // 2. Публичный ключ в профиле.
  try {
    const published = await getPublicKey(userId);
    if (published && bytesToBase64(published) === result.publicKeyB64) {
      result.ownPublicKeyPublished = true;
      return result;
    }
    if (published) {
      // В профиле ключ другого устройства. Перезаписывать нельзя: иначе
      // переписка на том устройстве станет нечитаемой.
      result.keyConflict = true;
      return result;
    }
    await savePublicKey(userId, result.publicKeyB64);
    result.ownPublicKeyPublished = true;
  } catch (e) {
    result.publicKeyError = e;
  }

  return result;
}

// Возвращает keypair текущего пользователя, создавая его при первом входе.
// null — если ключ уже создан на другом устройстве: перезаписывать публичный
// ключ нельзя, иначе переписка на том устройстве станет нечитаемой.
export async function getOrCreateIdentity(
  userId: string
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | null> {
  const identity = await ensureIdentity(userId);
  if (identity.localKeyError) {
    throw identity.localKeyError;
  }
  if (identity.publicKeyError) {
    throw identity.publicKeyError;
  }
  if (!identity.privateKey || !identity.publicKeyB64 || identity.keyConflict) {
    return null;
  }
  return {
    publicKey: base64ToBytes(identity.publicKeyB64),
    privateKey: identity.privateKey,
  };
}

export async function getPublicKey(userId: string): Promise<Uint8Array | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data?.public_key) {
    return null;
  }
  return base64ToBytes(data.public_key);
}

// Сохраняет публичный ключ и проверяет, что строка действительно обновилась.
// PostgREST при RLS или отсутствии гранта может ответить успехом, не изменив
// ни одной строки — без проверки ключ молча остаётся пустым в профиле.
export async function savePublicKey(userId: string, publicKeyB64: string): Promise<void> {
  const { data, error } = await supabase
    .from('profiles')
    .update({ public_key: publicKeyB64 })
    .eq('id', userId)
    .select('id');
  if (error) {
    throw error;
  }
  if (!data || data.length === 0) {
    throw new Error(
      'профиль не обновился: нет прав на profiles.public_key или строка профиля недоступна'
    );
  }
}

export async function publicKeyToBase64(publicKey: Uint8Array): Promise<string> {
  return bytesToBase64(publicKey);
}

export type PreparedSession =
  | { ok: true; privateKey: Uint8Array; peerPublicKeyB64: string }
  | { ok: false; title: string; message: string; cause?: unknown };

// Готовит всё необходимое для отправки сообщения и, если что-то не так,
// возвращает точную причину. Порядок проверок важен: сначала свой ключ, потом
// ключ собеседника — иначе при отсутствии гранта на profiles.public_key
// пользователь видит ложное «у собеседника нет ключа».
export async function prepareSendSession(
  myId: string,
  peerId: string | null
): Promise<PreparedSession> {
  const identity = await ensureIdentity(myId);

  if (!identity.privateKey) {
    return {
      ok: false,
      title: 'Ошибка шифрования',
      message:
        'Не удалось создать ключ шифрования на этом устройстве. Попробуйте выйти из аккаунта и войти снова.',
      cause: identity.localKeyError,
    };
  }

  if (identity.keyConflict) {
    return {
      ok: false,
      title: 'Ключ другого устройства',
      message:
        'В профиле сохранён ключ шифрования другого устройства. Отправка с этого устройства невозможна: войдите в аккаунт на том устройстве.',
    };
  }

  if (identity.publicKeyError || !identity.ownPublicKeyPublished || !identity.publicKeyB64) {
    return {
      ok: false,
      title: 'Сервер не принял ваш ключ',
      message:
        'Не удалось сохранить ваш публичный ключ в профиле: сервер не даёт доступ к profiles.public_key. Проверьте, что применена миграция 20261111000000_e2ee_public_key_grant.sql.',
      cause: identity.publicKeyError,
    };
  }

  if (!peerId) {
    return {
      ok: false,
      title: 'Собеседник не определён',
      message: 'Не удалось определить участника переписки. Откройте чат из списка сообщений.',
    };
  }

  let peerPublicKey: Uint8Array | null = null;
  try {
    peerPublicKey = await getPublicKey(peerId);
  } catch (e) {
    return {
      ok: false,
      title: 'Сервер не отдаёт ключ собеседника',
      message:
        'Не удалось прочитать публичный ключ собеседника. Проверьте, что на сервере применены миграции E2EE.',
      cause: e,
    };
  }

  if (!peerPublicKey) {
    return {
      ok: false,
      title: 'Собеседник ещё не готов',
      message:
        'У собеседника пока нет ключа шифрования. Ему нужно открыть приложение версии 0.0.18 или новее и войти в аккаунт.',
    };
  }

  return {
    ok: true,
    privateKey: identity.privateKey,
    peerPublicKeyB64: bytesToBase64(peerPublicKey),
  };
}

// Шифрует plaintext для получателя (peerPublicKeyB64) своим privateKey.
// Возвращает payload, который сохраняем в messages.content.
export async function encryptText(
  privateKey: Uint8Array,
  peerPublicKeyB64: string,
  plaintext: string
): Promise<E2EEPayload> {
  const lib = getNacl();
  const peerPublicKey = base64ToBytes(peerPublicKeyB64);
  const nonce = lib.randomBytes(24);
  const ciphertext = lib.box(utf8ToBytes(plaintext), nonce, peerPublicKey, privateKey);
  return {
    v: 1,
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ciphertext),
  };
}

// Дешифровывает ciphertext из payload для получателя (peerPublicKeyB64) своим privateKey.
export async function decryptText(
  privateKey: Uint8Array,
  peerPublicKeyB64: string,
  payload: string
): Promise<string> {
  const lib = getNacl();
  const parsed = JSON.parse(payload) as E2EEPayload;
  const nonce = base64ToBytes(parsed.nonce);
  const ciphertext = base64ToBytes(parsed.ct);
  const plaintext = lib.box.open(ciphertext, nonce, base64ToBytes(peerPublicKeyB64), privateKey);
  if (!plaintext) {
    throw new Error('E2EE: не удалось расшифровать сообщение');
  }
  return bytesToUtf8(plaintext);
}

// Шифрует байты (например, изображение) тем же крипто-блоком, что и текст:
// crypto_box (ECDH + SecretBox). Независимо от типа контента — общий формат
// {v, nonce, ct} и общий путь encrypt → store → decrypt.
export async function encryptBytes(
  privateKey: Uint8Array,
  peerPublicKeyB64: string,
  bytes: Uint8Array
): Promise<E2EEPayload> {
  const lib = getNacl();
  const peerPublicKey = base64ToBytes(peerPublicKeyB64);
  const nonce = lib.randomBytes(24);
  const ciphertext = lib.box(bytes, nonce, peerPublicKey, privateKey);
  return {
    v: 1,
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ciphertext),
  };
}

// Дешифровывает payload (байты или текст) для получателя (peerPublicKeyB64) своим privateKey.
export async function decryptBytes(privateKey: Uint8Array, peerPublicKeyB64: string, payload: E2EEPayload): Promise<Uint8Array> {
  const lib = getNacl();
  const nonce = base64ToBytes(payload.nonce);
  const ciphertext = base64ToBytes(payload.ct);
  const plaintext = lib.box.open(ciphertext, nonce, base64ToBytes(peerPublicKeyB64), privateKey);
  if (!plaintext) {
    throw new Error('E2EE: не удалось расшифровать данные');
  }
  return plaintext;
}

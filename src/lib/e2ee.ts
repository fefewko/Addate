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

// Возвращает keypair текущего пользователя, создавая его при первом входе.
// null — если ключ уже создан на другом устройстве: перезаписывать публичный
// ключ нельзя, иначе переписка на том устройстве станет нечитаемой.
export async function getOrCreateIdentity(
  userId: string
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | null> {
  const lib = getNacl();
  const stored = await AsyncStorage.getItem(privateKeyKey(userId));
  const existingPublicKey = await getPublicKey(userId);

  if (stored) {
    const privateKey = base64ToBytes(stored);
    if (existingPublicKey) {
      return { publicKey: existingPublicKey, privateKey };
    }
    // Публичный ключ потерян — восстанавливаем из приватного.
    const publicKey = lib.box.keyPair.fromSecretKey(privateKey).publicKey;
    await savePublicKey(userId, bytesToBase64(publicKey));
    return { publicKey, privateKey };
  }

  if (existingPublicKey) {
    return null;
  }

  const keypair = lib.box.keyPair();
  const privateKey = keypair.secretKey;
  const publicKey = keypair.publicKey;
  await AsyncStorage.setItem(privateKeyKey(userId), bytesToBase64(privateKey));
  await savePublicKey(userId, bytesToBase64(publicKey));
  return { publicKey, privateKey };
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

export async function savePublicKey(userId: string, publicKeyB64: string): Promise<void> {
  const { error } = await supabase.from('profiles').update({ public_key: publicKeyB64 }).eq('id', userId);
  if (error) {
    throw error;
  }
}

export async function publicKeyToBase64(publicKey: Uint8Array): Promise<string> {
  return bytesToBase64(publicKey);
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

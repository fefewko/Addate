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
// Используем libsodium-wrappers — чистая JS-реализация libsodium (X25519 + XSalsa20-Poly1305).
// Работает на web и нативном React Native без нативной сборки JSI/C++ (устойчиво к новому стэку RN).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import {
  crypto_box_easy,
  crypto_box_open_easy,
  crypto_box_keypair,
  randombytes_buf,
  to_base64,
  from_base64,
} from 'libsodium-wrappers';

export type E2EEPayload = {
  v: 1;
  nonce: string;
  ct: string;
};

const privateKeyStorageKey = (userId: string) => `e2ee:privateKey:${userId}`;

export async function getLocalPrivateKey(userId: string): Promise<Uint8Array | null> {
  const stored = await AsyncStorage.getItem(privateKeyStorageKey(userId));
  if (!stored) {
    return null;
  }
  return from_base64(stored) as Uint8Array;
}

export async function getOrCreateIdentity(userId: string): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const stored = await AsyncStorage.getItem(privateKeyStorageKey(userId));
  if (stored) {
    const privateKey = from_base64(stored) as Uint8Array;
    const publicKey = await getPublicKey(userId);
    if (publicKey) {
      return { publicKey, privateKey };
    }
  }

  const keypair = crypto_box_keypair();
  const privateKey = keypair.privateKey as Uint8Array;
  const publicKey = keypair.publicKey as Uint8Array;
  await AsyncStorage.setItem(privateKeyStorageKey(userId), to_base64(privateKey) as string);
  await savePublicKey(userId, to_base64(publicKey) as string);
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
  return from_base64(data.public_key) as Uint8Array;
}

export async function savePublicKey(userId: string, publicKeyB64: string): Promise<void> {
  const { error } = await supabase.from('profiles').update({ public_key: publicKeyB64 }).eq('id', userId);
  if (error) {
    throw error;
  }
}

export function publicKeyToBase64(publicKey: Uint8Array): string {
  return to_base64(publicKey) as string;
}

// Шифрует plaintext для получателя (peerPublicKeyB64) своим privateKey.
// Возвращает payload, который сохраняем в messages.content.
export async function encryptText(
  privateKey: Uint8Array,
  peerPublicKeyB64: string,
  plaintext: string
): Promise<E2EEPayload> {
  const peerPublicKey = from_base64(peerPublicKeyB64) as Uint8Array;
  const nonce = randombytes_buf(24);
  const ciphertext = crypto_box_easy(plaintext, nonce, peerPublicKey, privateKey);
  return {
    v: 1,
    nonce: to_base64(nonce) as string,
    ct: to_base64(ciphertext) as string,
  };
}

// Дешифровывает ciphertext из payload для получателя (peerPublicKeyB64) своим privateKey.
export async function decryptText(
  privateKey: Uint8Array,
  peerPublicKeyB64: string,
  payload: string
): Promise<string> {
  const parsed = JSON.parse(payload) as E2EEPayload;
  const nonce = from_base64(parsed.nonce) as Uint8Array;
  const ciphertext = from_base64(parsed.ct) as Uint8Array;
  const plaintext = crypto_box_open_easy(ciphertext, nonce, from_base64(peerPublicKeyB64) as Uint8Array, privateKey);
  return new TextDecoder().decode(plaintext);
}

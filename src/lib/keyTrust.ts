// src/lib/keyTrust.ts
//
// Доверие к публичному ключу собеседника.
//
// E2EE сам по себе не защищает от подмены ключа: если сервер (или тот, кто
// получил доступ к profiles.public_key) подменит ключ собеседника, новые
// сообщения будут зашифрованы уже на чужой ключ. Поэтому клиент запоминает
// первый увиденный ключ каждого собеседника (trust on first use) и при
// изменении показывает предупреждение с отпечатком.
//
// Отпечаток — первые 8 байт SHA-512 публичного ключа в hex, группами по 4
// символа. Это не секрет: его можно продиктовать вслух и сверить по другому
// каналу связи.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getNacl } from './e2ee';
import { base64ToBytes } from './encoding';
import { log } from './log';

export type PeerKeyStatus = 'new' | 'same' | 'changed';

export type PeerKeyCheck = {
  status: PeerKeyStatus;
  /** Отпечаток текущего ключа из профиля. */
  fingerprint: string;
  /** Отпечаток ранее сохранённого ключа (null — ключ видим впервые). */
  previousFingerprint: string | null;
};

const storageKey = (myId: string, peerId: string) => `e2ee:peerKey:${myId}:${peerId}`;

// 64 бита (8 байт) достаточно, чтобы заметить подмену, и коротко для сверки.
export function publicKeyFingerprint(publicKeyB64: string): string {
  const hash = getNacl().hash(base64ToBytes(publicKeyB64));
  const hex = Array.from(hash.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return (hex.match(/.{1,4}/g) ?? [hex]).join(' ');
}

export async function getPeerKeyStatus(
  myId: string,
  peerId: string,
  publicKeyB64: string
): Promise<PeerKeyCheck> {
  const fingerprint = publicKeyFingerprint(publicKeyB64);

  try {
    const raw = await AsyncStorage.getItem(storageKey(myId, peerId));
    if (!raw) {
      return { status: 'new', fingerprint, previousFingerprint: null };
    }
    const saved = JSON.parse(raw) as { key?: string };
    if (!saved?.key) {
      return { status: 'new', fingerprint, previousFingerprint: null };
    }
    if (saved.key === publicKeyB64) {
      return { status: 'same', fingerprint, previousFingerprint: fingerprint };
    }
    return {
      status: 'changed',
      fingerprint,
      previousFingerprint: publicKeyFingerprint(saved.key),
    };
  } catch (e) {
    // Повреждённая запись — считаем, что ключ новый: иначе пользователь
    // навсегда застрянет на предупреждении без возможности его закрыть.
    log.warn('Доверие к ключу: не удалось прочитать сохранённый ключ:', e);
    return { status: 'new', fingerprint, previousFingerprint: null };
  }
}

// Запоминает ключ как доверенный. Вызывается автоматически при первом контакте
// и вручную, когда пользователь подтвердил смену ключа.
export async function rememberPeerKey(
  myId: string,
  peerId: string,
  publicKeyB64: string
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      storageKey(myId, peerId),
      JSON.stringify({
        key: publicKeyB64,
        fingerprint: publicKeyFingerprint(publicKeyB64),
        updatedAt: new Date().toISOString(),
      })
    );
  } catch (e) {
    log.warn('Доверие к ключу: не удалось сохранить ключ собеседника:', e);
  }
}

// Полный сброс доверия (например, при выходе из аккаунта на чужом устройстве).
export async function forgetPeerKeys(myId: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith(`e2ee:peerKey:${myId}:`));
    if (mine.length > 0) {
      await AsyncStorage.multiRemove(mine);
    }
  } catch (e) {
    log.warn('Доверие к ключу: не удалось очистить сохранённые ключи:', e);
  }
}

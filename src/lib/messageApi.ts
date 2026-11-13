// src/lib/messageApi.ts
//
// Отправка, удаление и защита от повторной доставки сообщений.
//
// Здесь собрано то, что раньше было продублировано в Chat.tsx и
// AllUsers.tsx (QuickChatModal) двумя почти одинаковыми insert-ами:
//
//   * client_message_id — идентификатор отправки. При двойном тапе или ретрае
//     после обрыва сети уходит один и тот же id, и уникальный индекс в базе
//     (миграция 20261119000000) не даёт создать дубль.
//   * Удаление у себя и у обоих — через RPC delete_message(); прямой UPDATE
//     content с клиента запрещён шагом 10 миграции 20261117000000.
//   * Список nonce, которые уже видели в этой переписке. Повторно пришедший
//     конверт с тем же nonce — это replay: тот же шифртекст, вставленный второй
//     раз. Такой конверт отбрасывается.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { supabase } from './supabase';
import { log } from './log';

export type SendResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: string };

/** Новый идентификатор отправки. UUID v4 из нативного генератора. */
export function newClientMessageId(): string {
  return Crypto.randomUUID();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  if (error.code && error.code !== '') return false; // ошибка базы, повтор не поможет
  return /network|fetch|timeout|timed out/i.test(error.message ?? '');
}

/**
 * Идемпотентная отправка. Повтор с тем же clientMessageId не создаёт дубль:
 * либо запись уже есть (код 23505), либо ответ потерялся по сети и запрос
 * повторяется с тем же id.
 */
export async function sendEncryptedMessage(params: {
  matchId: string;
  senderId: string;
  payload: unknown;
  imagePath?: string | null;
  clientMessageId?: string;
}): Promise<SendResult> {
  const clientMessageId = params.clientMessageId ?? newClientMessageId();

  const row: Record<string, unknown> = {
    match_id: params.matchId,
    sender_id: params.senderId,
    content: JSON.stringify(params.payload),
    client_message_id: clientMessageId,
  };
  if (params.imagePath) {
    row.image_path = params.imagePath;
  }

  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase.from('messages').insert(row);

    if (!error) {
      return { ok: true, duplicate: false };
    }

    // Уникальный индекс (sender_id, client_message_id): сообщение уже записано.
    if (error.code === '23505') {
      return { ok: true, duplicate: true };
    }

    lastError = error.message;

    if (attempt === 0 && isNetworkError(error)) {
      await delay(700);
      continue;
    }

    break;
  }

  return { ok: false, error: lastError || 'неизвестная ошибка отправки' };
}

/** Какие из сообщений пользователь скрыл у себя. */
export async function fetchHiddenMessageIds(
  userId: string,
  messageIds: string[]
): Promise<Set<string>> {
  const hidden = new Set<string>();
  if (messageIds.length === 0) return hidden;

  // Пачками по 100: PostgREST передаёт список в URL, и тысяча uuid не
  // помещается в лимит длины запроса.
  const CHUNK = 100;
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('message_deletions')
      .select('message_id')
      .eq('user_id', userId)
      .in('message_id', chunk);

    if (error) {
      // Не блокируем чат: в худшем случае скрытые сообщения покажутся снова.
      log.warn('Не удалось прочитать список удалённых сообщений:', error.message);
      return hidden;
    }

    for (const row of data || []) {
      hidden.add((row as { message_id: string }).message_id);
    }
  }

  return hidden;
}

export async function deleteMessageForMe(messageId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_message', {
    p_message_id: messageId,
    p_for_everyone: false,
  });
  if (error) throw new Error(error.message);
}

/**
 * Удаление у обоих. Доступно только автору (проверяется на сервере).
 * Объект в storage удаляем best-effort: если политика ещё не применена или
 * файла уже нет, сообщение всё равно останется удалённым.
 */
export async function deleteMessageForEveryone(
  messageId: string,
  imagePath: string | null
): Promise<void> {
  const { error } = await supabase.rpc('delete_message', {
    p_message_id: messageId,
    p_for_everyone: true,
  });
  if (error) throw new Error(error.message);

  if (imagePath) {
    const { error: storageError } = await supabase.storage
      .from('chat-images')
      .remove([imagePath]);
    if (storageError) {
      log.warn('Удалённое сообщение: не удалось удалить файл из storage:', storageError.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Защита от повторной доставки (replay)
// ---------------------------------------------------------------------------

const MAX_SEEN_NONCES = 500;
const seenNoncesKey = (myId: string, peerId: string) => `e2ee:seenNonces:${myId}:${peerId}`;

/** Достаёт nonce из E2EE-конверта. Для legacy-plaintext возвращает null. */
export function envelopeNonce(content: string | null | undefined): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { nonce?: unknown };
    return typeof parsed?.nonce === 'string' ? parsed.nonce : null;
  } catch {
    return null;
  }
}

export async function loadSeenNonces(myId: string, peerId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(seenNoncesKey(myId, peerId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch (e) {
    log.warn('Защита от повторов: не удалось прочитать список nonce:', e);
    return new Set();
  }
}

export async function rememberSeenNonces(
  myId: string,
  peerId: string,
  nonces: string[]
): Promise<void> {
  if (nonces.length === 0) return;
  try {
    const existing = await loadSeenNonces(myId, peerId);
    const merged = Array.from(existing);
    for (const nonce of nonces) {
      if (!existing.has(nonce)) {
        existing.add(nonce);
        merged.push(nonce);
      }
    }
    const trimmed = merged.slice(-MAX_SEEN_NONCES);
    await AsyncStorage.setItem(seenNoncesKey(myId, peerId), JSON.stringify(trimmed));
  } catch (e) {
    log.warn('Защита от повторов: не удалось сохранить nonce:', e);
  }
}

/**
 * Убирает из загруженной истории строки с повторяющимся nonce. Оставляем самое
 * раннее сообщение: именно оно было доставлено первым, остальные — вставленные
 * повторно копии того же шифртекста.
 */
export function dedupeByNonce<T extends { id: string; content: string | null; created_at?: string }>(
  rows: T[]
): T[] {
  const seen = new Map<string, string>(); // nonce -> id выбранной строки
  const result: T[] = [];

  for (const row of rows) {
    const nonce = envelopeNonce(row.content);
    if (!nonce) {
      result.push(row);
      continue;
    }
    if (seen.has(nonce)) {
      log.warn('Защита от повторов: пропущено дублирующее сообщение', row.id);
      continue;
    }
    seen.set(nonce, row.id);
    result.push(row);
  }

  return result;
}

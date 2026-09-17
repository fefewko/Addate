// src/lib/chatImages.ts
import { supabase } from './supabase';

const SIGNED_URL_TTL_SECONDS = 60 * 60; // час — достаточно на время открытого чата

// Загружает фото в приватный бакет chat-images по пути {matchId}/{timestamp}.ext
// и возвращает путь к файлу (не URL — URL для приватного бакета нужно подписывать отдельно).
export async function uploadChatImage(matchId: string, uri: string): Promise<string> {
  const response = await fetch(uri);
  const arrayBuffer = await response.arrayBuffer();
  const fileExt = uri.split('.').pop() || 'jpg';
  const path = `${matchId}/${Date.now()}.${fileExt}`;

  const { error } = await supabase.storage
    .from('chat-images')
    .upload(path, arrayBuffer, { contentType: `image/${fileExt}` });

  if (error) throw new Error(error.message);

  return path;
}

// Пакетно получает временные подписанные ссылки для списка путей —
// дешевле одного вызова на каждое фото при загрузке истории переписки.
export async function getSignedChatImageUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};

  const { data, error } = await supabase.storage
    .from('chat-images')
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

  if (error || !data) return {};

  const map: Record<string, string> = {};
  data.forEach((item) => {
    if (item.path && item.signedUrl) map[item.path] = item.signedUrl;
  });
  return map;
}

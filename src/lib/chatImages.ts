// src/lib/chatImages.ts
import { supabase } from './supabase';
import { imageFormatForUpload } from './imageBytes';

const SIGNED_URL_TTL_SECONDS = 60 * 60; // час

// Комментарий к TTL: час выбран из соображений безопасности — подписанная
// ссылка работает как bearer-доступ, и чем короче её жизнь, тем меньше окно
// утечки. Поэтому ссылка НЕ продлевается заранее: вместо этого чаты
// перезапрашивают её по требованию, когда картинка не загрузилась (см.
// refreshImage в Chat.tsx и QuickChatModal в AllUsers.tsx). Так старые
// сообщения не превращаются в битые картинки, а окно утечки не растёт.

// Загружает фото в приватный бакет chat-images по пути {matchId}/{timestamp}.ext
// и возвращает путь к файлу (не URL — URL для приватного бакета нужно подписывать отдельно).
export async function uploadChatImage(matchId: string, uri: string): Promise<string> {
  const response = await fetch(uri);
  const arrayBuffer = await response.arrayBuffer();

  // Формат определяется по байтам: на вебе URI вида blob:https://... не
  // содержит расширения, и старый разбор ссылки писал в путь мусор.
  const { ext, mimeType } = imageFormatForUpload(arrayBuffer);
  const path = `${matchId}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('chat-images')
    .upload(path, arrayBuffer, { contentType: mimeType });

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

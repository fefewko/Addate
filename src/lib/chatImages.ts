// src/lib/chatImages.ts
import { Platform } from 'react-native';
import { supabase } from './supabase';
import { imageFormatForUpload, type ImageFormat } from './imageBytes';
import { decryptBytes, encryptBytes, type E2EEPayload } from './e2ee';
import { base64ToBytes, bytesToBase64 } from './encoding';

// eslint-disable-next-line @typescript-eslint/no-var-requires
declare const require: (id: string) => any;

const SIGNED_URL_TTL_SECONDS = 60 * 60; // час

// Комментарий к TTL: час выбран из соображений безопасности — подписанная
// ссылка работает как bearer-доступ, и чем короче её жизнь, тем меньше окно
// утечки. Поэтому ссылка НЕ продлевается заранее: вместо этого чаты
// перезапрашивают её по требованию, когда картинка не загрузилась (см.
// refreshImage в Chat.tsx и QuickChatModal в AllUsers.tsx). Так старые
// сообщения не превращаются в битые картинки, а окно утечки не растёт.

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

// E2EE: шифрует изображение (как байты) получателем через crypto_box и
// загружает ciphertext в приватный бакет chat-images. Возвращает путь к
// зашифрованному файлу (это будет image_path в messages) и сам envelope
// {v, nonce, ct} для записи в content.
export async function uploadEncryptedChatImage(
  matchId: string,
  uri: string,
  privateKey: Uint8Array,
  peerPublicKeyB64: string
): Promise<{ path: string; payload: E2EEPayload; bytes: Uint8Array; format: ImageFormat }> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const format = imageFormatForUpload(buffer) ?? { ext: 'jpg', mimeType: 'image/jpeg' };

  const payload = await encryptBytes(privateKey, peerPublicKeyB64, bytes);

  const ctBytes = base64ToBytes(payload.ct);
  const ctArrayBuffer = ctBytes.buffer.slice(ctBytes.byteOffset, ctBytes.byteOffset + ctBytes.byteLength) as ArrayBuffer;

  const path = `${matchId}/${Date.now()}.${format.ext}`;
  const { error } = await supabase.storage
    .from('chat-images')
    .upload(path, ctArrayBuffer, { contentType: format.mimeType });

  if (error) throw new Error(error.message);

  return { path, payload, bytes, format };
}

// E2EE: расшифровывает изображение по envelope из messages.content (тот же
// формат, что и у текстовых сообщений: {v, nonce, ct}).
// Возвращает plaintext-байты и определённый по ним формат.
export async function decryptChatImage(
  privateKey: Uint8Array,
  peerPublicKeyB64: string,
  content: string | null
): Promise<{ bytes: Uint8Array; format: ImageFormat } | null> {
  if (!content) return null;

  let payload: E2EEPayload;
  try {
    payload = JSON.parse(content);
  } catch (e) {
    return null;
  }
  if (!payload || payload.v !== 1 || !payload.nonce || !payload.ct) {
    return null;
  }

  const plaintext = await decryptBytes(privateKey, peerPublicKeyB64, payload);
  const buffer = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer;
  const format = imageFormatForUpload(buffer) ?? { ext: 'jpg', mimeType: 'image/jpeg' };
  return { bytes: plaintext, format };
}

// Превращает расшишифрованные байты в data URI (web) или файл во временном
// каталоге (нативный RN). Рендер изображения получает готовый displayable URI.
export async function writeDecryptedImage(bytes: Uint8Array, mimeType: string, id: string): Promise<string> {
  // На web используем data URI — там проще. На нативе пишем расшифрованные
  // байты во временный файл, чтобы RN Image мог отдать его нативному слою.
  // expo-file-system подключается лениво: не хотим грузить его модуль на
  // холодном старте приложения.
  if (Platform.OS === 'web') {
    return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  }
  const File: any = (require('expo-file-system') as { File: any }).File;
  const documentDirectory: string = (require('expo-file-system/legacy') as { documentDirectory: string }).documentDirectory;
  const filename = id.split('/').pop() ?? 'image';
  const file = new File(`${documentDirectory}${filename}`);
  file.write(bytes);
  return file.uri;
}

export async function bytesToDataUri(bytes: Uint8Array, mimeType: string): Promise<string> {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

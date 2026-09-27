// src/lib/avatarUpload.ts
import { supabase } from './supabase';
import { log } from './log';

// Загружает фото в публичный бакет avatars по пути {userId}/{fileName}.{ext}
// и возвращает публичный URL с меткой времени (чтобы не показывалась закэшированная
// старая версия фото по тому же пути). Общая логика для ProfileSetup и Profile —
// раньше была продублирована в обоих файлах почти без изменений.
export async function uploadAvatarPhoto(userId: string, uri: string, fileName: string): Promise<string> {
  const response = await fetch(uri);
  const arrayBuffer = await response.arrayBuffer();
  const fileExt = uri.split('.').pop() || 'jpg';
  const filePath = `${userId}/${fileName}.${fileExt}`;

  const { error } = await supabase.storage
    .from('avatars')
    .upload(filePath, arrayBuffer, { contentType: `image/${fileExt}`, upsert: true });

  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
  return `${data.publicUrl}?t=${Date.now()}`;
}

// Публичный URL вида
//   https://<проект>.supabase.co/storage/v1/object/public/avatars/<путь>?t=...
//_storage.remove() просит именно путь внутри бакета, без префикса и query.
function storagePathFromPublicUrl(publicUrl: string): string | null {
  if (!publicUrl) return null;

  const withoutQuery = publicUrl.split('?')[0];
  const marker = '/storage/v1/object/public/';
  const at = withoutQuery.indexOf(marker);
  if (at === -1) return null;

  const afterBucket = withoutQuery.slice(at + marker.length);
  const slash = afterBucket.indexOf('/');
  if (slash === -1) return null;

  return afterBucket.slice(slash + 1);
}

// Удаляет файл из бакета. Раньше фото убиралось только из массива
// additional_photos, а сам файл оставался в бакете навсегда и продолжал
// занимать место. Удаление разрешено политикой «Удаление своих файлов».
export async function deleteAvatarPhoto(publicUrl: string): Promise<void> {
  const path = storagePathFromPublicUrl(publicUrl);
  if (!path) return;

  const { error } = await supabase.storage.from('avatars').remove([path]);
  if (error) {
    // Не роняем интерфейс: ссылка из профиля уже убрана, осталось только
    // недоудалённый файл в бакете.
    log.warn('Не удалось удалить файл из хранилища:', error.message);
  }
}

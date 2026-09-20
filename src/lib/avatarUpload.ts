// src/lib/avatarUpload.ts
import { supabase } from './supabase';

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

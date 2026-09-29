// src/lib/imageBytes.ts
//
// Определение формата картинки по содержимому, а не по ссылке.
//
// Зачем: расширение раньше бралось так
//     const fileExt = uri.split('.').pop() || 'jpg';
// На нативе это работает: URI там вида file:///data/.../avatar.jpg. На вебе
// expo-image-picker отдаёт результат через URL.createObjectURL, то есть
// blob:https://addate.ru/web/1f0c... — и последняя точка в такой строке
// принадлежит домену. Из-за этого fileExt становился «0:8081/1f0c...», а путь
// в бакете и contentType — мусором: аватар и фото в чате не загружались.
//
// Почему по байтам, а не по имени файла из пикера: на вебе пикер отдаёт
// исходный файл пользователя (PNG, HEIC с телефона, WebP), и имя unreliable.
// Сигнатура файла — единственный источник, который одинаково честен на всех
// платформах, и он уже в руках: файл всё равно скачивается целиком перед
// загрузкой в хранилище.

export type ImageFormat = {
  ext: string;
  mimeType: string;
};

const JPEG: ImageFormat = { ext: 'jpg', mimeType: 'image/jpeg' };
const PNG: ImageFormat = { ext: 'png', mimeType: 'image/png' };
const GIF: ImageFormat = { ext: 'gif', mimeType: 'image/gif' };
const WEBP: ImageFormat = { ext: 'webp', mimeType: 'image/webp' };
const BMP: ImageFormat = { ext: 'bmp', mimeType: 'image/bmp' };
const HEIC: ImageFormat = { ext: 'heic', mimeType: 'image/heic' };
const AVIF: ImageFormat = { ext: 'avif', mimeType: 'image/avif' };

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

// Возвращает null, если формат не распознан: вызывающий код решает сам, чем
// заменить неизвестное, и не должен получать выдуманное расширение.
export function detectImageFormat(buffer: ArrayBuffer): ImageFormat | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return null;

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return JPEG;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;

  if (ascii(bytes, 0, 4) === 'GIF8') return GIF;

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return WEBP;

  if (ascii(bytes, 0, 2) === 'BM') return BMP;

  // HEIC и AVIF начинаются с контейнера ftyp, а различаются брендом в байтах
  // 8..12. Список брендов неполный, но покрывает то, что отдают iOS и
  // современные Android-галереи.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return AVIF;
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return HEIC;
  }

  return null;
}

// Формат для загрузки. Неизвестное содержимое трактуется как JPEG: пикер
// сжимает фотографии сам, и JPEG — единственный формат, который гарантированно
// покажется в анкете.
export function imageFormatForUpload(buffer: ArrayBuffer): ImageFormat {
  return detectImageFormat(buffer) ?? JPEG;
}

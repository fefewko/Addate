// src/lib/encoding.ts
//
// Кодирование байтов в base64 и UTF-8 без внешних зависимостей и без
// нативных/эмуляторных модулей. Нужно для E2EE: payload в БД хранится как
// base64, а текст сообщения перед шифрованием превращается в байты UTF-8.
//
// Почему свой код: раньше base64 брался из libsodium-wrappers, но его
// WASM/asm.js-ядро падало на холодном старте в Hermes. Здесь — только чистые
// вычисления над Uint8Array.

// Формат намеренно совпадает с прежним libsodium `to_base64` по умолчанию:
// URL-safe алфавит (- и _) без padding. Так уже сохранённые ключи и
// ciphertext (если они есть) читаются без миграции. Декодер принимает и
// обычный алфавит (+ и /), и padding.
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Обратная таблица: код символа -> значение 0..63, -1 для всего остального.
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    table[BASE64_CHARS.charCodeAt(i)] = i;
  }
  // Принимаем и стандартный алфавит: данные могли быть сохранены так.
  table['+'.charCodeAt(0)] = 62;
  table['/'.charCodeAt(0)] = 63;
  return table;
})();

const CHUNK_SIZE = 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  if (len === 0) return '';

  const chunks: string[] = [];
  let chunk = '';

  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < len;
    const hasB2 = i + 2 < len;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;

    chunk += BASE64_CHARS[b0 >> 2] + BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];

    if (hasB1) {
      chunk += BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    }
    if (hasB2) {
      chunk += BASE64_CHARS[b2 & 0x3f];
    }

    if (chunk.length >= CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = '';
    }
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks.join('');
}

export function base64ToBytes(input: string): Uint8Array {
  // Отбрасываем padding и пробельные символы (например, переводы строк).
  let clean = input.replace(/\s+/g, '');
  let end = clean.length;
  while (end > 0 && clean.charCodeAt(end - 1) === 61 /* '=' */) end--;
  if (end !== clean.length) clean = clean.slice(0, end);

  if (clean.length === 0) return new Uint8Array(0);

  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean.charCodeAt(i)] ?? -1;
    const c1 = i + 1 < clean.length ? BASE64_LOOKUP[clean.charCodeAt(i + 1)] ?? -1 : -1;
    const c2 = i + 2 < clean.length ? BASE64_LOOKUP[clean.charCodeAt(i + 2)] ?? -1 : -1;
    const c3 = i + 3 < clean.length ? BASE64_LOOKUP[clean.charCodeAt(i + 3)] ?? -1 : -1;

    if (c0 < 0 || c1 < 0) {
      throw new Error('Некорректная строка base64');
    }

    const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
    out[p++] = (n >> 16) & 0xff;
    if (c2 >= 0) out[p++] = (n >> 8) & 0xff;
    if (c3 >= 0) out[p++] = n & 0xff;
  }

  return p === out.length ? out : out.subarray(0, p);
}

// Строка -> байты UTF-8. Ручная реализация: TextEncoder в Hermes есть не во
// всех сборках, а зависеть от него в крипто-пути не хочется.
export function utf8ToBytes(str: string): Uint8Array {
  const out: number[] = [];

  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);

    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      // Суррогатная пара — символ вне BMP.
      const next = str.charCodeAt(++i);
      const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }

  return new Uint8Array(out);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';

  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++];

    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
    } else if (b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    } else {
      cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
    }

    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }

  return out;
}

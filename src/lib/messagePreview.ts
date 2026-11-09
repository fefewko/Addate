// src/lib/messagePreview.ts
//
// Превью последнего сообщения в списке диалогов хранится в
// matches.last_message_preview. Для E2EE-переписки сервер не может положить
// туда текст: он видит только конверт {"v":1,"nonce":"...","ct":"..."}.
//
// Триггер touch_match_last_message (миграция 20261110000000) подставляет
// читаемый плейсхолдер, но если миграция ещё не применена — в списке
// оказывается ciphertext, причём обрезанный старым триггером до 80 символов,
// поэтому JSON.parse здесь не поможет. Определяем конверт по началу строки.
export const ENCRYPTED_PREVIEW = '🔒 Сообщение';

// Возвращает безопасный текст для превью: вместо шифртекста — плейсхолдер.
// Обычный текст (включая старые незашифрованные сообщения) не трогаем.
export function readableMessagePreview(preview: string | null | undefined): string | null {
  if (!preview) return null;

  const compact = preview.replace(/\s+/g, '');
  // Полный конверт или его обрезок: {"v":1,"nonce":"... (дальше могло не влезть)
  if (compact.startsWith('{"v":1') && compact.includes('"nonce"')) {
    return ENCRYPTED_PREVIEW;
  }

  return preview;
}

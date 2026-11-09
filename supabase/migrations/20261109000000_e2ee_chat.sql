-- E2EE: публичный ключ пользователя для шифрования переписки.
-- Приватный ключ хранится локально на устройстве (SecureStore/AsyncStorage),
-- общий секрет сообщений получается через ECDH (X25519) между ключами участников.
-- Сервер хранит ciphertext, доступ имеет только админский контур.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS public_key text;

COMMENT ON COLUMN public.profiles.public_key IS
  'X25519 public key (base64) для E2EE шифрования сообщений. Секрет не хранится в БД.';

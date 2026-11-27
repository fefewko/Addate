-- Исправление: триггерная функция согласия ссылалась к колонке terms_accept_at
-- вместо terms_accepted_at, из-за чего любое обновление profiles (в том числе
-- сохранение нового публичного ключа при замене шифрования) падало с ошибкой:
--   record "new" has no field "terms_accept_at"
--
-- Столбок в схеме называется terms_accepted_at (миграция
-- 20260926000008_terms_consent.sql). Эта миграция исправляет работающую базу:
-- пересоздаёт функцию protect_profile_service_fields и триггер stamp_terms_accepted
-- из эталонного текста миграций.
--
-- Идемпотентно. Шаг 1 из двух: функция защиты полей профиля.

BEGIN;

CREATE OR REPLACE FUNCTION public.protect_profile_service_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.is_admin() THEN
    IF tg_op = 'INSERT' THEN
      -- Клиент не может назначить себе права, модерацию или дату согласия.
      new.is_admin := false;
      new.moderation_status := 'pending';
      new.moderation_note := null;
      new.terms_accepted_at := null;  -- проставит stamp_terms_accepted
    ELSE
      IF new.is_admin IS DISTINCT FROM old.is_admin
         OR new.moderation_status IS DISTINCT FROM old.moderation_status
         OR new.moderation_note IS DISTINCT FROM old.moderation_note
         OR new.terms_accepted_at IS DISTINCT FROM old.terms_accepted_at THEN
        RAISE EXCEPTION 'Служебные поля анкеты (модерация, права и согласие с правилами) изменяются только модератором'
          USING errcode = '42501';
      END IF;
    END IF;
  END IF;

  new.updated_at := now();
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_service_fields ON public.profiles;

CREATE TRIGGER protect_profile_service_fields
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_service_fields();

COMMIT;

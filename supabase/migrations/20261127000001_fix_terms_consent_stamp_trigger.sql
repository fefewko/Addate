-- Исправление: триггерная функция согласия ссылалась к колонке terms_accept_at
-- вместо terms_accepted_at, из-за чего любое обновление profiles (в том числе
-- сохранение нового публичного ключа при замене шифрования) падало с ошибкой:
--   record "new" has no field "terms_accept_at"
--
-- Столбок в схеме называется terms_accepted_at (миграция
-- 20260926000008_terms_consent.sql). Эта миграция исправляет работающую базу:
-- пересоздаёт функцию stamp_terms_accepted и триггер.
--
-- Идемпотентно. Шаг 2 из двух.

BEGIN;

CREATE OR REPLACE FUNCTION public.stamp_terms_accepted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF new.terms_accepted_at IS NULL THEN
    new.terms_accepted_at := now();
  END IF;

  RETURN new;
END;
$$;

COMMENT ON FUNCTION public.stamp_terms_accepted() IS
  'Проставляет дату согласия с правилами в момент создания анкеты, если '
  'клиент её не прислал. Клиент эту колонку не заполняет и не должен: '
  'иначе он смог бы указать произвольную дату.';

DROP TRIGGER IF EXISTS stamp_terms_accepted ON public.profiles;

CREATE TRIGGER stamp_terms_accepted
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_terms_accepted();

COMMIT;

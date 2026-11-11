-- Email/поддержка: автоматическая проставка is_support на matches.
--
-- Зачем:
--
-- is_support проставляет клиент приложения при создании чата с поддержкой
-- (src/lib/support.ts, insert { user_a, user_b, status, matched_at, is_support }).
-- Но колонки matches.is_support нет в грантах UPDATE для authenticated
-- (GRANT UPDATE (status, matched_at)), поэтому существующая пара, по которой
-- пользователь написал в поддержку, проставить флаг из клиента не получится:
-- выполняется лишь UPDATE статуса, и пара остаётся с is_support = false.
-- Веб-оболочка модерации (moderation.html) выбирает обращения из matches по
-- is_support = true, поэтому такие диалоги молча не попадают в список
-- обращений модератора.
--
-- Решение: проставлять флаг в базе, а не клиенте. Триггер BEFORE INSERT OR
-- UPDATE: пара, в которой второй участник (относительно инициировавшего
-- UPDATE/INSERT пользователя) — администратор, автоматически считается
-- обращением в поддержку. Юзер не может подделать флаг: триггер срабатывает
-- только для пар с администратором, остальные пары не трогает.
--
-- Идемпотентно: можно применять повторно.

BEGIN;

DROP TRIGGER IF EXISTS guard_support_flag ON public.matches;
DROP FUNCTION IF EXISTS public.guard_support_flag();

CREATE OR REPLACE FUNCTION public.set_support_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_other_id uuid;
BEGIN
  v_other_id := CASE WHEN new.user_a = auth.uid() THEN new.user_b ELSE new.user_a END;

  IF EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = v_other_id
      AND p.is_admin = true
  ) THEN
    new.is_support := true;
  END IF;

  RETURN new;
END;
$$;

CREATE TRIGGER set_support_flag
BEFORE INSERT OR UPDATE ON public.matches
FOR EACH ROW EXECUTE FUNCTION public.set_support_flag();

COMMIT;

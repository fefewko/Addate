-- Поддержка: признак is_support на matches
--
-- Зачем:
--
-- Веб-оболочка модерации (moderation.html) выгружает вкладку «Поддержка»
-- запросом
--     select ... from matches
--       where (user_a = <admin> or user_b = <admin>) and is_support = true
-- То есть она показывает только пары, у которых выставлен is_support.
--
-- Но колонки is_support в matches не было, и приложение её не проставляло:
-- src/lib/support.ts создавал пару как { user_a, user_b, status, matched_at }.
-- Фильтр оболочки не мог сработать никогда — вкладка была пустой.
--
-- Что делаем:
--   1. Добавляем колонку с безопасным значением по умолчанию.
--   2. Помечаем уже существующие чаты поддержки.
--   3. Запрещаем помечать пару как поддержку, если второй участник
--      не администратор — иначе любой пользователь мог бы своими руками
--      подкладывать фальшивые обращения в очередь модерации.
--
-- Идемпотентно: можно применять повторно.

BEGIN;

-- 1. Колонка ---------------------------------------------------------------

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS is_support boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.matches.is_support IS
  'Чат ведётся через аккаунт поддержки, а не как обычное совпадение. '
  'По этому признаку веб-оболочка модерации отбирает обращения.';

-- 2. Расставить признак по существующим чатам --------------------------------
--
-- Отмечаем все подтверждённые пары с аккаунтом администратора. Аккаунт
-- поддержки служебный (openSupportChat прямо запрещает писать самому себе),
-- поэтому подтверждённая пара с ним — это обращение в поддержку, а не
-- романтическое совпадение.
--
-- Если в вашей базе такие пары есть и они НЕ должны попасть в очередь
-- модерации, добавьте условие исключения ниже.

UPDATE public.matches m
   SET is_support = true
  WHERE m.status = 'matched'
    AND NOT m.is_support
    AND (
      m.user_a IN (SELECT id FROM public.profiles WHERE is_admin)
      OR m.user_b IN (SELECT id FROM public.profiles WHERE is_admin)
    );

-- 3. Защита от подделки ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_support_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
declare
  v_other_id uuid;
begin
  if new.is_support is not true then
    return new;
  end if;

  -- Второй участник относительно того, кто создаёт пару.
  v_other_id := case when new.user_a = auth.uid() then new.user_b else new.user_a end;

  if not exists (
    select 1
    from public.profiles p
    where p.id = v_other_id
      and p.is_admin
  ) then
    raise exception 'Чат поддержки можно создать только с аккаунтом администратора'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

COMMENT ON FUNCTION public.guard_support_flag() IS
  'Запрещает помечать пару как support, если второй участник не админ. '
  'SECURITY DEFINER, чтобы проверка не зависела от RLS: иначе при неодобренной '
  'анкете администратора проверка молча не нашла бы строку и заблокировала бы '
  'нормальную переписку с поддержкой.';

DROP TRIGGER IF EXISTS guard_support_flag ON public.matches;

CREATE TRIGGER guard_support_flag
  BEFORE INSERT ON public.matches
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_support_flag();

COMMIT;

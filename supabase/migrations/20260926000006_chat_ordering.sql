-- Порядок диалогов и превью последнего сообщения
--
-- Зачем:
--
-- ChatList сортировал переписки по matched_at, то есть по моменту самого
-- совпадения. Из-за этого чат, в котором переписывались сегодня, оказывался
-- НИЖЕ чата, возникшего месяц назад и давно замолчавшего. Для мессенджера
-- это просто неверно: сверху должен быть диалог с самой свежей перепиской.
--
-- Сортировать на клиенте нельзя без выкачивания всей переписки, поэтому
-- последнее сообщение запоминается в самой строке matches и поддерживается
-- триггером. Список диалогов остаётся одним простым SELECT.
--
-- Триггер SECURITY DEFINER, а не INVOKER: он обновляет matches, а политика
-- UPDATE на matches требует участия в паре. При INVOKER вставка сообщения
-- могла бы упереться в RLS — впрочем, отправитель всегда в паре, так что
-- на практике разница не проявится. Но полагаться на это не стоит: правило
-- «обновлять matches может только участник пары» не должно решать, взойдёт
-- ли INSERT в messages. SECURITY DEFINER делает механизм независимым от RLS,
-- а условие where id = new.match_id гарантирует, что затрагивается только
-- пара, к которой относится сообщение.
--
-- Идемпотентно.

BEGIN;

-- 1. Поля ---------------------------------------------------------------------

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS last_message_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_message_preview text;

CREATE INDEX IF NOT EXISTS idx_matches_last_message_at
  ON public.matches (last_message_at DESC NULLS LAST);

COMMENT ON COLUMN public.matches.last_message_at IS
  'Время последнего сообщения в паре. Сортировка списка диалогов идёт по нему, '
  'а не по matched_at: совпадение может быть месячной давности, а переписка — '
  'сегодняшней.';

COMMENT ON COLUMN public.matches.last_message_preview IS
  'Начало текста последнего сообщения для списка диалогов.';


-- 2. Триггер ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_match_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  update public.matches
     set last_message_at = new.created_at,
         last_message_preview = case
           when new.image_path is not null and new.content is null then 'Фото'
           when new.image_path is not null and new.content is not null
             then left(new.content, 80) || ' + фото'
           else left(new.content, 80)
         end
   where id = new.match_id;

  return new;
end;
$$;

COMMENT ON FUNCTION public.touch_match_last_message() IS
  'Обновляет last_message_at и last_message_preview в паре при вставке '
  'сообщения. Нужен, чтобы список диалогов сортировался по свежести '
  'переписки, а не по дате совпадения.';

DROP TRIGGER IF EXISTS touch_match_last_message ON public.messages;

CREATE TRIGGER touch_match_last_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_match_last_message();


-- 3. Заполнить по уже существующим сообщениям --------------------------------
--
-- last_message_at не может быть NULL у пары с перепиской, иначе такие диалоги
-- окажутся в самом низу списка, где по логике должен быть самый свежий диалог.
-- Поэтому NULL-сортировка и не даёт эффекта, но заполняем всё равно.

update public.matches m
   set last_message_at = last.created_at,
       last_message_preview = last.preview
  from (
    select distinct on (msg.match_id)
           msg.match_id,
           msg.created_at,
           case
             when msg.image_path is not null and msg.content is null then 'Фото'
             when msg.image_path is not null and msg.content is not null
               then left(msg.content, 80) || ' + фото'
             else left(msg.content, 80)
           end as preview
      from public.messages msg
     order by msg.match_id, msg.created_at desc
  ) as last
 where last.match_id = m.id
   and m.last_message_at is null;

COMMIT;

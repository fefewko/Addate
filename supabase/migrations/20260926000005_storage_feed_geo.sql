-- Удаление файлов и лента без длинных URL
--
-- 1. На storage.objects нет ни одной DELETE-политики, поэтому удалить файл
--    не может никто: ни пользователь у себя в профиле, ни модератор у вложения
--    жалобы. При включённом RLS remove() отбрасывается молча, без ошибки.
--    Из-за этого удалённые фото навсегда оставались в бакете и продолжали
--    занимать место (и оставаться доступными по старой прямой ссылке).
--
-- 2. Feed и AllUsers исключали уже рассмотренных через
--    .not('id', 'in', '(uuid,uuid,...)'). Список растёт без ограничений, и
--    примерно после 200 записей URL превышает лимит PostgREST и запрос
--    начинает отваливаться. Аргументы RPC уходят в JSON-теле POST, а не в
--    query string, поэтому ограничения на длину там нет.
--
-- Про производительность nearby_profiles заранее: сейчас это полный скан
-- profiles, потому что оператор <@> не использует обычный GIST-индекс
-- (тот работает на && и на KNN-операторе <->). Ускорить можно только
-- переписыванием на earth_box с предварительным отсевом по рамке либо
-- сортировкой по <->. На текущем объёме данных это не нужно, а
-- неэффективный индекс платил бы лишней записью при каждом обновлении
-- анкеты, поэтому здесь его нет.
--
-- Идемпотентно.

BEGIN;

-- 1. Удаление своих файлов ---------------------------------------------------

DROP POLICY IF EXISTS "Удаление своих файлов" ON storage.objects;

CREATE POLICY "Удаление своих файлов"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);

COMMENT ON POLICY "Удаление своих файлов" ON storage.objects IS
  'Позволяет удалить свои фотографии профиля. Без этой политики remove() '
  'молча не удаляет ничего, и файлы накапливаются в бакете навсегда.';


-- 2. Лента и список анкет с исключениями на сервере --------------------------

CREATE OR REPLACE FUNCTION public.feed_profiles(
  excluded_ids uuid[],
  viewer_lat double precision,
  viewer_lng double precision,
  row_limit integer DEFAULT 20,
  row_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  display_name text,
  birth_date date,
  city text,
  bio text,
  sobriety_status text,
  substance_type text[],
  photo_url text,
  last_seen_at timestamp with time zone,
  distance_km double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select
    p.id,
    p.display_name,
    p.birth_date,
    p.city,
    p.bio,
    p.sobriety_status,
    p.substance_type,
    p.photo_url,
    p.last_seen_at,
    case
      when p.latitude is not null
       and p.longitude is not null
       and viewer_lat is not null
       and viewer_lng is not null
      then (point(p.longitude, p.latitude) <@> point(viewer_lng, viewer_lat)) * 1.60934
    end as distance_km
  from public.profiles p
  where p.moderation_status = 'approved'
    -- Уже рассмотренные: свои лайки, скипы и совпадения в любом направлении.
    -- Передаётся аргументом, поэтому длина URL не растёт.
    and not (p.id = any (excluded_ids))
    -- Заблокированные в любую сторону.
    and not exists (
      select 1
      from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = p.id)
         or (b.blocked_id = auth.uid() and b.blocker_id = p.id)
    )
  order by p.created_at desc
  limit greatest(row_limit, 1)
  offset greatest(row_offset, 0);
$$;

COMMENT ON FUNCTION public.feed_profiles(uuid[], double precision, double precision, integer, integer) IS
  'Одобренные анкеты за вычетом рассмотренных и заблокированных, с расстоянием '
  'до каждой. Заменяет длинный .not(''id'', ''in'', ...) из клиента: аргументы '
  'RPC едут в теле POST, поэтому ограничения на длину URL нет. SECURITY DEFINER, '
  'поэтому отбор по статусу модерации и блокировкам вынесен внутрь функции.';

COMMIT;

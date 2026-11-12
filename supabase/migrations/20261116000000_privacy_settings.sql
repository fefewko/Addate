-- Приватность анкеты
--
-- Задача: пользователь сам решает, какие чувствительные поля видят другие.
-- По умолчанию скрыто всё: возраст, город, дата трезвости, тип зависимости,
-- фотографии, онлайн-статус и последняя активность. Пока пользователь явно
-- не включит поле в разделе «Моя приватность», другие его не увидят.
--
-- Почему не хватило клиентского маскирования: profiles читается напрямую
-- через PostgREST, и любой авторизованный пользователь мог бы запросить
-- скрытые колонки в обход интерфейса. Поэтому:
--   1. чувствительные колонки отозваны из SELECT-гранта authenticated;
--   2. чужие анкеты отдаются через view public.profile_cards, где маскирование
--      выполняется на сервере с учётом флагов владельца;
--   3. своя анкета (включая скрытые поля) читается через RPC public.my_profile().
--
-- Идемпотентно.

BEGIN;

-- ===========================================================================
-- 1. Настройки приватности
-- ===========================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS profile_visible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS profile_hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_age boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_city boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_sobriety_since boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_substance_type boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_photos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_online_status boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_last_active boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.profile_visible IS
  'Показывать анкету в ленте и поиске. Выключено — анкета не попадает в выдачу, '
  'но существующие совпадения и переписка сохраняются.';
COMMENT ON COLUMN public.profiles.profile_hidden IS
  'Полностью скрыть анкету от других пользователей. Имеет приоритет над всеми '
  'остальными настройками: чужие видят только факт, что анкета скрыта.';
COMMENT ON COLUMN public.profiles.show_age IS
  'Показывать возраст (дата рождения) другим пользователям. По умолчанию false.';
COMMENT ON COLUMN public.profiles.show_city IS
  'Показывать город другим пользователям. По умолчанию false.';
COMMENT ON COLUMN public.profiles.show_sobriety_since IS
  'Показывать дату начала трезвости другим пользователям. По умолчанию false.';
COMMENT ON COLUMN public.profiles.show_substance_type IS
  'Показывать типы зависимости другим пользователям. По умолчанию false.';
COMMENT ON COLUMN public.profiles.show_photos IS
  'Показывать фотографии анкеты другим пользователям. По умолчанию false.';
COMMENT ON COLUMN public.profiles.show_online_status IS
  'Показывать индикатор «В сети» другим пользователям. По умолчанию false.';
COMMENT ON COLUMN public.profiles.show_last_active IS
  'Показывать время последней активности другим пользователям. По умолчанию false.';

-- ===========================================================================
-- 2. Чужие анкеты с серверным маскированием
-- ===========================================================================
--
-- View принадлежит postgres, поэтому обходит RLS profiles. Фильтр по строкам
-- продублирован явно: свои строки + одобренные анкеты. Это важно, иначе view
-- стал бы способом прочитать анкеты на модерации.

DROP VIEW IF EXISTS public.profile_cards;

CREATE VIEW public.profile_cards AS
SELECT
  p.id,
  (p.id = v.uid) AS is_own,
  p.is_admin,
  p.profile_hidden,

  CASE
    WHEN p.id = v.uid OR NOT p.profile_hidden THEN p.display_name
  END AS display_name,

  CASE
    WHEN p.id = v.uid OR (NOT p.profile_hidden AND p.show_age) THEN p.birth_date
  END AS birth_date,

  CASE
    WHEN p.id = v.uid OR (NOT p.profile_hidden AND p.show_city) THEN p.city
  END AS city,

  CASE
    WHEN p.id = v.uid OR NOT p.profile_hidden THEN p.bio
  END AS bio,

  CASE
    WHEN p.id = v.uid OR NOT p.profile_hidden THEN p.height_cm
  END AS height_cm,

  CASE
    WHEN p.id = v.uid OR NOT p.profile_hidden THEN p.weight_kg
  END AS weight_kg,

  CASE
    WHEN p.id = v.uid OR NOT p.profile_hidden THEN p.sobriety_status
  END AS sobriety_status,

  CASE
    WHEN p.id = v.uid OR (NOT p.profile_hidden AND p.show_sobriety_since) THEN p.sobriety_since
  END AS sobriety_since,

  CASE
    WHEN p.id = v.uid OR (NOT p.profile_hidden AND p.show_substance_type) THEN p.substance_type
  END AS substance_type,

  CASE
    WHEN p.id = v.uid OR (NOT p.profile_hidden AND p.show_photos) THEN p.photo_url
  END AS photo_url,

  CASE
    WHEN p.id = v.uid OR (NOT p.profile_hidden AND p.show_photos) THEN p.additional_photos
  END AS additional_photos,

  CASE
    WHEN p.id = v.uid THEN
      (p.last_seen_at IS NOT NULL AND p.last_seen_at > now() - interval '3 minutes')
    WHEN NOT p.profile_hidden AND p.show_online_status THEN
      (p.last_seen_at IS NOT NULL AND p.last_seen_at > now() - interval '3 minutes')
    ELSE NULL
  END AS is_online,

  CASE
    WHEN p.id = v.uid OR (NOT p.profile_hidden AND p.show_last_active) THEN p.last_seen_at
  END AS last_active_at,

  (p.id = v.uid OR (NOT p.profile_hidden AND p.show_photos)) AS photos_visible

FROM public.profiles p
CROSS JOIN (SELECT auth.uid() AS uid) v
WHERE p.id = v.uid
   OR p.moderation_status = 'approved';

COMMENT ON VIEW public.profile_cards IS
  'Анкеты для показа другим пользователям. Чувствительные поля маскируются '
  'на сервере по флагам владельца (show_*), а полностью скрытая анкета '
  '(profile_hidden) отдаётся без данных. Своя строка возвращается без маскирования.';

REVOKE ALL ON public.profile_cards FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profile_cards TO authenticated;

-- ===========================================================================
-- 3. Своя анкета целиком
-- ===========================================================================
--
-- После отзыва SELECT-гранта на чувствительные колонки своя анкета тоже стала
-- бы недоступна напрямую. my_profile() возвращает ровно одну строку — свою.

DROP FUNCTION IF EXISTS public.my_profile();

CREATE FUNCTION public.my_profile()
RETURNS SETOF public.profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT *
  FROM public.profiles
  WHERE id = (SELECT auth.uid());
$$;

COMMENT ON FUNCTION public.my_profile() IS
  'Своя анкета со всеми полями, включая скрытые настройками приватности. '
  'Нужна для редактирования профиля после отзыва SELECT-гранта на '
  'чувствительные колонки profiles.';

REVOKE ALL ON FUNCTION public.my_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_profile() TO authenticated;

-- ===========================================================================
-- 4. Расстояние до скрытых анкет
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.nearby_profiles(
  viewer_lat double precision,
  viewer_lng double precision
)
RETURNS TABLE (profile_id uuid, distance_km double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select p.id as profile_id,
         (point(p.longitude, p.latitude) <@> point(viewer_lng, viewer_lat)) * 1.60934 as distance_km
  from public.profiles p
  where p.moderation_status = 'approved'
    and not p.profile_hidden
    and p.latitude is not null
    and p.longitude is not null
    and (auth.uid() is null or p.id <> auth.uid());
$$;

-- ===========================================================================
-- 5. Лента с серверным маскированием
-- ===========================================================================
--
-- Сигнатура возвращаемой таблицы меняется (появились is_online, last_active_at,
-- photos_visible), поэтому старую функцию нужно удалить: CREATE OR REPLACE
-- не умеет менять тип возвращаемых колонок.

DROP FUNCTION IF EXISTS public.feed_profiles(uuid[], double precision, double precision, integer, integer);

CREATE FUNCTION public.feed_profiles(
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
  height_cm integer,
  weight_kg integer,
  sobriety_status text,
  sobriety_since date,
  substance_type text[],
  photo_url text,
  additional_photos text[],
  is_online boolean,
  last_active_at timestamp with time zone,
  photos_visible boolean,
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
    case when p.show_age then p.birth_date end,
    case when p.show_city then p.city end,
    p.bio,
    p.height_cm,
    p.weight_kg,
    p.sobriety_status,
    case when p.show_sobriety_since then p.sobriety_since end,
    case when p.show_substance_type then p.substance_type end,
    case when p.show_photos then p.photo_url end,
    case when p.show_photos then p.additional_photos end,
    case
      when p.show_online_status then
        (p.last_seen_at is not null and p.last_seen_at > now() - interval '3 minutes')
      else null
    end,
    case when p.show_last_active then p.last_seen_at end,
    p.show_photos,
    case
      when p.latitude is not null
       and p.longitude is not null
       and viewer_lat is not null
       and viewer_lng is not null
      then (point(p.longitude, p.latitude) <@> point(viewer_lng, viewer_lat)) * 1.60934
    end as distance_km
  from public.profiles p
  where p.moderation_status = 'approved'
    and p.profile_visible
    and not p.profile_hidden
    and not (p.id = any (excluded_ids))
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
  'Одобренные и видимые анкеты за вычетом рассмотренных и заблокированных. '
  'Чувствительные поля маскируются на сервере по настройкам приватности '
  'владельца: скрытый возраст/город/фото/статусы приходят как NULL, а '
  'is_online = NULL означает, что онлайн-статус скрыт.';

REVOKE ALL ON FUNCTION public.feed_profiles(uuid[], double precision, double precision, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feed_profiles(uuid[], double precision, double precision, integer, integer)
  TO authenticated;

-- ===========================================================================
-- 6. Прямой SELECT profiles: только нечувствительные поля
-- ===========================================================================
--
-- Всё, что относится к содержимому анкеты (имя, дата рождения, город, фото,
-- статусы, last_seen_at), теперь доступно только через profile_cards или
-- my_profile(). Прямыми остаются идентификатор, служебные поля модерации,
-- публичный ключ E2EE и сами настройки приватности.

REVOKE SELECT ON public.profiles FROM authenticated;

GRANT SELECT (
  id,
  is_admin,
  moderation_status,
  moderation_note,
  created_at,
  updated_at,
  public_key,
  profile_visible,
  profile_hidden,
  show_age,
  show_city,
  show_sobriety_since,
  show_substance_type,
  show_photos,
  show_online_status,
  show_last_active
) ON public.profiles TO authenticated;

-- PostgREST кеширует схему и права. Без этого новые колонки и view могут
-- остаться невидимыми до перезапуска контейнера.
NOTIFY pgrst, 'reload schema';

COMMIT;

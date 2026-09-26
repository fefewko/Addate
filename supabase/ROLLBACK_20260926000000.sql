-- ОТКАТ миграции 20260926000000_lock_down_profiles.sql
--
-- ВАЖНО: этот файл лежит вне supabase/migrations/ намеренно —
-- `supabase db reset` не должен его выполнять. Запускать вручную,
-- только если нужно вернуть состояние «до ужесточения».
--
-- Что произойдёт после отката:
--   * latitude/longitude снова отдаются всем (утечка вернётся);
--   * любой пользователь снова сможет выставить себе is_admin = true
--     и подтвердить свою же анкету (эскалация вернётся);
--   * сообщения собеседников снова можно будет править;
--   * updated_at перестанет проставляться автоматически.
-- То есть откат возвращает известные дыры. Применять только осознанно.

BEGIN;

-- --- 1. profiles: вернуть обычный SELECT на все колонки -------------------

REVOKE SELECT (
  id,
  display_name,
  birth_date,
  gender,
  looking_for,
  city,
  bio,
  sobriety_status,
  sobriety_since,
  substance_type,
  photo_url,
  moderation_status,
  moderation_note,
  created_at,
  updated_at,
  height_cm,
  weight_kg,
  additional_photos,
  last_seen_at,
  is_admin
) ON public.profiles FROM authenticated;

GRANT SELECT ON public.profiles TO authenticated;


-- --- 2. profiles: убрать триггер служебных полей --------------------------

DROP TRIGGER IF EXISTS protect_profile_service_fields ON public.profiles;
DROP FUNCTION IF EXISTS public.protect_profile_service_fields();


-- --- 3. profiles: вернуть исходный вид nearby_profiles --------------------
-- Именно то, что было в baseline: invoker, без SECURITY DEFINER,
-- поэтому расстояние снова считается под RLS от имени пользователя.

CREATE OR REPLACE FUNCTION public.nearby_profiles(
  viewer_lat double precision,
  viewer_lng double precision
)
RETURNS TABLE (profile_id uuid, distance_km double precision)
LANGUAGE sql
STABLE
AS $$
  select p.id as profile_id,
         (point(p.longitude, p.latitude) <@> point(viewer_lng, viewer_lat)) * 1.60934 as distance_km
  from public.profiles p
  where p.moderation_status = 'approved'
    and p.latitude is not null
    and p.longitude is not null;
$$;


-- --- 4. убрать my_location() ----------------------------------------------

DROP FUNCTION IF EXISTS public.my_location();


-- --- 5. messages / matches: вернуть UPDATE на уровне таблицы ---------------

GRANT UPDATE ON public.messages TO authenticated;
GRANT UPDATE ON public.matches TO authenticated;

REVOKE UPDATE (read_at) ON public.messages FROM authenticated;
REVOKE UPDATE (status, matched_at) ON public.matches FROM authenticated;


-- --- 6. matches: убрать запрет лайка самому себе ---------------------------

DROP TRIGGER IF EXISTS no_self_match ON public.matches;
DROP FUNCTION IF EXISTS public.prevent_self_match();


-- --- 7. messages: вернуть прежнюю политику чтения ------------------------
-- Без проверки статуса совпадения — как было в baseline.

DROP POLICY IF EXISTS "Сообщения своего совпадения" ON public.messages;

CREATE POLICY "Сообщения своего совпадения"
  ON public.messages
  FOR SELECT
  USING (
    exists (
      select 1
      from public.matches m
      where m.id = messages.match_id
        and (auth.uid() = m.user_a or auth.uid() = m.user_b)
    )
  );

COMMIT;

-- После COMMIT выполнить вручную:
--   notify pgrst, 'reload schema';

-- Усиление доступа к анкетам, совпадениям и сообщениям
--
-- Блок 1. profiles: служебные поля и чужие координаты
-- Блок 2. messages:  UPDATE ограничен колонкой read_at
-- Блок 3. matches:   UPDATE ограничен колонками status/matched_at
-- Блок 4. matches:   запрещён лайк самому себе
-- Блок 5. messages:  переписка читается только по подтверждённым совпадениям
-- Блок 6. проверки:  если что-то не применилось — скрипт падает с ошибкой
--
-- ---------------------------------------------------------------------------
-- Что закрываем
-- ---------------------------------------------------------------------------
--
-- 1. ЭСКАЛАЦИЯ ПРИВИЛЕГИЙ. Политика "Редактирование своей анкеты"
--    (USING (id = auth.uid())) не ограничивает список изменяемых колонок,
--    поэтому запрос
--      UPDATE profiles SET is_admin = true WHERE id = auth.uid()
--    проходит и проверку, и WITH CHECK. После этого private.is_admin()
--    начинает возвращать true и выдаёт доступ ко всем анкетам, всем
--    жалобам, тикетам поддержки и праву редактировать чужие анкеты.
--    Служебные поля (moderation_status, moderation_note, is_admin)
--    защищаются триггером: для обычного пользователя они read-only.
--
-- 2. УТЕЧКА КООРДИНАТ. Политика "Просмотр одобренных анкет" отдаёт все
--    колонки строки, включая latitude/longitude, поэтому точные координаты
--    любого пользователя доступны обычным SELECT-запросом, хотя клиент
--    специально считает расстояние только через nearby_profiles().
--    Теперь эти колонки исключены из SELECT-гранта authenticated; свои
--    координаты отдаёт my_location(), чужие — по-прежнему только расстояние.
--
-- 3. ПРАВКА ЧУЖИХ СООБЩЕНИЙ. Политика "Отметка сообщений прочитанными"
--    (FOR UPDATE USING ...) не ограничена колонками, поэтому можно не
--    только поставить read_at, но и переписать content/фото в сообщении
--    собеседника. UPDATE ограничивается колонкой read_at.
--
-- 4. ПОДМЕНА УЧАСТНИКОВ ПАРЫ. На matches UPDATE тоже не ограничен
--    колонками, поэтому в своей паре можно переписать user_a/user_b.
--    UPDATE ограничивается колонками status и matched_at.
--
-- 5. ЛАЙК САМОМУ СЕБЕ. INSERT-политика на matches проверяет только
--    auth.uid() = user_a, то есть user_b = auth.uid() проходит.
--    Добавляется триггер.
--
-- 6. ЧТЕНИЕ ПЕРЕПИСКИ НЕ ПОДТВЕРЖДЁННЫХ СОВПАДЕНИЙ. SELECT-политика на
--    messages смотрит только на участие в паре, но не на её статус.
--
-- ---------------------------------------------------------------------------
-- ПОРЯДОК ВАЖЕН
-- ---------------------------------------------------------------------------
-- Сначала отзыв привилегии уровня таблицы, иначе grant уровня таблицы
-- перекрыл бы grant уровня колонок (это независимые наборы).


-- ===========================================================================
-- Блок 1. profiles
-- ===========================================================================

-- 1.1. latitude/longitude исключаются из выдачи authenticated.
--      Список колонок задан явно: если в таблицу добавят новую колонку,
--      её нужно будет дописать сюда, иначе она не будет отдаваться клиенту
--      (запись при этом продолжит работать).
REVOKE SELECT ON public.profiles FROM authenticated;

GRANT SELECT (
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
) ON public.profiles TO authenticated;

-- 1.2. Свои координаты — через отдельную функцию, потому что напрямую
--      они больше не выдаются.
CREATE OR REPLACE FUNCTION public.my_location()
RETURNS TABLE (latitude double precision, longitude double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select p.latitude, p.longitude
  from public.profiles p
  where p.id = auth.uid();
$$;

COMMENT ON FUNCTION public.my_location() IS
  'Координаты текущего пользователя. Нужна потому, что latitude/longitude '
  'исключены из SELECT-гранта authenticated, чтобы чужие координаты нельзя '
  'было прочитать обычным запросом.';

-- 1.3. nearby_profiles больше не зависит от SELECT-гранта на координаты.
--      Функция становится SECURITY DEFINER: владелец (postgres) обходит RLS,
--      поэтому координаты всех анкет становятся ей доступны, а фильтрация
--      переносится внутрь. Сигнатура не меняется, клиент ничего не заметит.
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
    and p.latitude is not null
    and p.longitude is not null
    and (auth.uid() is null or p.id <> auth.uid());
$$;

COMMENT ON FUNCTION public.nearby_profiles(double precision, double precision) IS
  'Расстояние в километрах от точки просмотра до всех одобренных анкет. '
  'Возвращает только расстояние — точные координаты чужих анкет недоступны '
  'на уровне SELECT-гранта.';

-- 1.4. Служебные поля профиля защищены от изменения пользователем.
--      Проверка в триггере, а не в политике RLS: политика не умеет
--      различать UPDATE по колонкам, а набор служебных полей может
--      расширяться.
--
--      auth.uid() is null — это service_role, дампы, SQL-консоль Supabase:
--      модерация обычно делается именно оттуда, такие вызовы не трогаем.
--      Модератор в приложении проходит по private.is_admin().
CREATE OR REPLACE FUNCTION public.protect_profile_service_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  if auth.uid() is not null and not private.is_admin() then
    if new.is_admin is distinct from old.is_admin
       or new.moderation_status is distinct from old.moderation_status
       or new.moderation_note is distinct from old.moderation_note then
      raise exception 'Служебные поля анкеты (модерация и права) изменяются только модератором'
        using errcode = '42501';
    end if;
  end if;

  -- updated_at проставляется в одном месте, чтобы приложение не могло
  -- откатить его в произвольное прошлое.
  new.updated_at := now();

  return new;
end;
$$;

DROP TRIGGER IF EXISTS protect_profile_service_fields ON public.profiles;

CREATE TRIGGER protect_profile_service_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_service_fields();

-- Схема private и функция is_admin() вызываются от имени пользователя: из
-- политик RLS и из триггера protect_profile_service_fields, который
-- срабатывает на ЛЮБОМ изменении анкеты. Роль authenticated обязана иметь
-- право заходить в схему private, иначе сохранение профиля падало бы с
-- "permission denied for schema private" у всех, включая модератора.
-- На практике это уже так (Supabase выдаёт EXECUTE на функции всем),
-- но зависимость от неявной выдачи лучше не оставлять.
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_admin() TO authenticated;


-- ===========================================================================
-- Блок 2. messages — UPDATE только на read_at
-- ===========================================================================
--
-- Приложение пишет в messages только insert (новое сообщение) и
-- update({ read_at }). Админских прав на таблицу нет ни у кого,
-- поэтому ограничение не ломает ничего.

REVOKE UPDATE ON public.messages FROM authenticated;
GRANT UPDATE (read_at) ON public.messages TO authenticated;


-- ===========================================================================
-- Блок 3. matches — UPDATE только на status и matched_at
-- ===========================================================================
--
-- Приложение обновляет на matches ровно эти два поля:
--   matches.ts        status: 'matched' | 'pending', matched_at
--   support.ts        status: 'matched', matched_at
--   IncomingLikes.tsx status: 'rejected'
-- Всё остальное (user_a, user_b, created_at) становится неизменяемым.

REVOKE UPDATE ON public.matches FROM authenticated;
GRANT UPDATE (status, matched_at) ON public.matches TO authenticated;


-- ===========================================================================
-- Блок 4. matches — запрет лайка самому себе
-- ===========================================================================
--
-- Сделано триггером, а не правкой INSERT-политики: в дампе её имя
-- обрезано до 63 байт, и DROP POLICY по имени мог бы тихо не сработать.
-- Триггер от имени политики не зависит. Уже существующие пары
-- "сам с собой" (если такие есть) триггер не трогает — см. проверку
-- в блоке 6.

CREATE OR REPLACE FUNCTION public.prevent_self_match()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  if new.user_a = new.user_b then
    raise exception 'Нельзя поставить лайк самому себе'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS no_self_match ON public.matches;

CREATE TRIGGER no_self_match
  BEFORE INSERT ON public.matches
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_self_match();


-- ===========================================================================
-- Блок 5. messages — читать переписку только подтверждённых совпадений
-- ===========================================================================
--
-- Политика снимается по факту наличия, а не по имени, чтобы обрезанное
-- в дампе имя не привело к тихому no-op. Перед снятием проверяем, что
-- политика ровно одна: если их неожиданно несколько (значит схема не та,
-- что мы ожидали) — падаем и не трогаем ничего.

DO $$
DECLARE
  p     record;
  cnt   integer;
BEGIN
  select count(*) into cnt
  from pg_policies
  where schemaname = 'public'
    and tablename   = 'messages'
    and cmd          = 'SELECT';

  if cnt <> 1 then
    raise exception
      'На public.messages ожидалась ровно одна SELECT-политика, найдено %. Политика чтения переписки НЕ ужесточена — разберись вручную.', cnt;
  end if;

  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'messages' and cmd = 'SELECT'
  loop
    execute format('drop policy %I on public.messages', p.policyname);
  end loop;
end;
$$;

CREATE POLICY "Сообщения своего совпадения"
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (
    exists (
      select 1
      from public.matches m
      where m.id = messages.match_id
        and m.status = 'matched'
        and (auth.uid() = m.user_a or auth.uid() = m.user_b)
    )
  );


-- ===========================================================================
-- Блок 6. Проверки
-- ===========================================================================
--
-- Скрипт применяют вручную, поэтому молчаливый провал был бы опасен:
-- приведённый ниже DO-блок валит транзакцию, если что-то не применилось.
-- Ошибка означает «миграция не доведена до конца», а не «проблема в базе».
--
-- Привилегии проверяются разбором pg_class.relacl / pg_attribute.attacl
-- через aclexplode, а не через information_schema: представления
-- information_schema ограничивают видимость текущей ролью, и из-под
-- postgres проверка могла бы молча увидеть пустоту.

DO $$
DECLARE
  v_table text;
  v_priv  text;
BEGIN
  -- Уровень таблицы: привилегии должны быть отозваны, иначе grant
  -- уровня колонок не имеет смысла — табличный перекроет колоночный.
  foreach v_table in array array['messages', 'matches'] loop
    if exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) acl
      join pg_roles r on r.oid = acl.grantee
      where n.nspname = 'public'
        and c.relname  = v_table
        and r.rolname  = 'authenticated'
        and acl.privilege_type = 'UPDATE'
    ) then
      raise exception 'На public.% всё ещё есть UPDATE уровня таблицы — ограничение по колонкам не действует.', v_table;
    end if;
  end loop;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) acl
    join pg_roles r on r.oid = acl.grantee
    where n.nspname = 'public'
      and c.relname  = 'profiles'
      and r.rolname  = 'authenticated'
      and acl.privilege_type = 'SELECT'
  ) then
    raise exception
      'На public.profiles всё ещё есть SELECT уровня таблицы — latitude/longitude по-прежнему отдаются.';
  end if;

  -- Уровень колонки: нужные привилегии должны быть выданы.
  if not exists (
    select 1
    from pg_attribute a
    cross join lateral aclexplode(a.attacl) acl
    join pg_roles r on r.oid = acl.grantee
    where a.attrelid = 'public.messages'::regclass
      and a.attname  = 'read_at'
      and a.attnum   > 0
      and not a.attisdropped
      and r.rolname  = 'authenticated'
      and acl.privilege_type = 'UPDATE'
  ) then
    raise exception 'Нет UPDATE на messages.read_at — приложение не сможет отмечать сообщения прочитанными.';
  end if;

  -- Объекты, которые обязаны появиться.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'my_location'
  ) then
    raise exception 'Функция public.my_location() не создана.';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'protect_profile_service_fields'
  ) then
    raise exception 'Триггер protect_profile_service_fields не создан.';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'no_self_match'
  ) then
    raise exception 'Триггер no_self_match не создан.';
  end if;

  -- Служебная диагностика, не блокирует применение.
  if exists (select 1 from public.matches where user_a = user_b) then
    raise notice
      'ВНИМАНИЕ: в matches есть пары "сам с собой". Новая вставка запрещена, '
      'но старые строки остались — удалить их можно так: '
      'delete from matches where user_a = user_b;';
  end if;

  raise notice 'Проверки пройдены. Осталось выполнить: notify pgrst, ''reload schema'';';
end;
$$;

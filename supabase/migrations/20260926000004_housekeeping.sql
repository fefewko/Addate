-- Чистка токенов, блокировки в nearby_profiles, дубль политики жалоб
--
-- 1. push_tokens: политика "Управление своими push-токенами" создана без
--    предложения FOR, то есть действует на все команды, включая DELETE.
--    Проверяем это и явно фиксируем намерение отдельной политикой: если
--    когда-нибудь у кого-то появится политика "только SELECT/INSERT", стирание
--    собственного токена не должно молча перестать работать.
--
-- 2. nearby_profiles не учитывал блокировки. Клиент отфильтровывал их сам, но
--    заблокированного человека можно было получить прямым вызовом RPC.
--    Функция и так SECURITY DEFINER, поэтому фильтр переносится внутрь.
--
-- 3. На reports две идентичные INSERT-политики: "Подать жалобу" и
--    "Пользователи могут создавать жалобы". Обе с WITH CHECK
--    (reporter_id = auth.uid()). Дубликат не дыра, но при правке одной
--    легко забыть про вторую.
--
-- Идемпотентно.

BEGIN;

-- 1. Удаление своего push-токена -------------------------------------------

DROP POLICY IF EXISTS "Удаление своих push-токенов" ON public.push_tokens;

CREATE POLICY "Удаление своих push-токенов"
  ON public.push_tokens
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

COMMENT ON POLICY "Удаление своих push-токенов" ON public.push_tokens IS
  'Нужна, чтобы при выходе из аккаунта снимать push-токен устройства: иначе '
  'разлогинившийся продолжает получать уведомления.';


-- 2. nearby_profiles с учётом блокировок ------------------------------------

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
    and (auth.uid() is null or p.id <> auth.uid())
    -- Заблокированные в любую сторону исключаются на уровне базы.
    -- Раньше фильтрация была только на клиенте, поэтому заблокированного
    -- человека можно было получить прямым вызовом этой функции.
    and not exists (
      select 1
      from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = p.id)
         or (b.blocked_id = auth.uid() and b.blocker_id = p.id)
    );
$$;

COMMENT ON FUNCTION public.nearby_profiles(double precision, double precision) IS
  'Расстояние в километрах от точки просмотра до одобренных анкет, кроме '
  'заблокированных в любую сторону. Возвращает только расстояние: точные '
  'координаты чужих анкет недоступны на уровне SELECT-гранта.';


-- 3. Убираем дублирующую политику на reports -------------------------------

DROP POLICY IF EXISTS "Подать жалобу" ON public.reports;

COMMIT;

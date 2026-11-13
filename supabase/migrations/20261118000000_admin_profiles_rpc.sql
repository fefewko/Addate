-- Чтение анкет для панели модерации (addate_moderation).
--
-- Проблема: панель читала public.profiles напрямую (`select('*')`). После
-- отзыва табличного SELECT в 20261117000000 она стала падать с
-- "permission denied for table profiles".
--
-- Вернуть табличный SELECT нельзя: он отдаёт latitude/longitude и всё
-- содержимое анкет ВСЕМ авторизованным, а не только админам. Гранты в
-- Postgres ролевые, «только администратору» через них не выражается.
--
-- Решение: панель читает через SECURITY DEFINER-функции с проверкой
-- private.is_admin(). Обычный пользователь получает ошибку 42501, а не данные.
--
-- Миграция идемпотентна.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_profiles()
RETURNS SETOF public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'Доступ только администратору' USING errcode = '42501';
  END IF;

  RETURN QUERY
    SELECT p.*
    FROM public.profiles p
    ORDER BY p.updated_at DESC;
END;
$$;

COMMENT ON FUNCTION public.admin_profiles() IS
  'Все анкеты для панели модерации. Только для администратора: проверка '
  'private.is_admin() внутри SECURITY DEFINER-функции.';

CREATE OR REPLACE FUNCTION public.admin_profile_names(p_ids uuid[])
RETURNS TABLE (id uuid, display_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.is_admin() THEN
    RAISE EXCEPTION 'Доступ только администратору' USING errcode = '42501';
  END IF;

  RETURN QUERY
    SELECT p.id, p.display_name
    FROM public.profiles p
    WHERE p.id = ANY (p_ids);
END;
$$;

COMMENT ON FUNCTION public.admin_profile_names(uuid[]) IS
  'Имена анкет по списку id для панели модерации. Только для администратора.';

REVOKE ALL ON FUNCTION public.admin_profiles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_profiles() TO authenticated;

REVOKE ALL ON FUNCTION public.admin_profile_names(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_profile_names(uuid[]) TO authenticated;

DO $$
BEGIN
  IF NOT has_function_privilege('authenticated','public.admin_profiles()','EXECUTE') THEN
    RAISE EXCEPTION 'admin_profiles(): нет доступа у authenticated.';
  END IF;

  IF has_function_privilege('anon','public.admin_profiles()','EXECUTE') THEN
    RAISE EXCEPTION 'admin_profiles(): доступна anon.';
  END IF;

  IF NOT has_function_privilege('authenticated','public.admin_profile_names(uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'admin_profile_names(): нет доступа у authenticated.';
  END IF;

  IF has_function_privilege('anon','public.admin_profile_names(uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'admin_profile_names(): доступна anon.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('admin_profiles', 'admin_profile_names')
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'Функции панели созданы без SECURITY DEFINER.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

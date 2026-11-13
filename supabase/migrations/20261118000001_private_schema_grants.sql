-- Доступ authenticated к схеме private.
--
-- Проблема: ROLLBACK_20260926000000.sql снял
--   GRANT USAGE ON SCHEMA private TO authenticated;
--   GRANT EXECUTE ON FUNCTION private.is_admin() TO authenticated;
--
-- Между тем private.is_admin() вызывается от имени пользователя:
--   * из триггера protect_profile_service_fields (любая правка анкеты);
--   * из политик RLS (reports, storage.objects, admin_profiles()).
--
-- Без USAGE на схему любая такая операция падает с
-- "permission denied for schema private" — в том числе одобрение анкеты
-- из панели модерации и сохранение профиля из приложения.
--
-- Безопасно: private.is_admin() — SECURITY DEFINER и возвращает только
-- boolean про текущего пользователя. Таблиц в схеме private нет.
-- anon доступа не получает.
--
-- Идемпотентно.

BEGIN;

-- На случай, если функции ещё нет (база собрана не по репозиторию).
CREATE OR REPLACE FUNCTION private.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.is_admin = true
  );
$$;

GRANT USAGE ON SCHEMA private TO authenticated;

REVOKE ALL ON FUNCTION private.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_admin() TO authenticated;

DO $$
BEGIN
  IF NOT has_schema_privilege('authenticated','private','USAGE') THEN
    RAISE EXCEPTION 'Шаг 12: у authenticated нет USAGE на схему private.';
  END IF;

  IF NOT has_function_privilege('authenticated','private.is_admin()','EXECUTE') THEN
    RAISE EXCEPTION 'Шаг 12: authenticated не может вызвать private.is_admin().';
  END IF;

  IF has_schema_privilege('anon','private','USAGE') THEN
    RAISE EXCEPTION 'Шаг 12: у anon есть доступ к схеме private.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

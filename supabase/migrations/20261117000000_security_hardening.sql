-- Усиление безопасности по итогам аудита 13.11.2026.
--
-- Файл состоит из независимых шагов. Каждый шаг — отдельная транзакция,
-- поэтому его можно выполнить в SQL Editor отдельно и проверить результат.
-- Порядок шагов не важен, кроме финальной проверки: её запускать последней.
--
-- Что здесь есть:
--   ШАГ 1. profiles: запрет клиентского INSERT, защита служебных полей на INSERT,
--          исправление испорченного DEFAULT moderation_status.
--   ШАГ 2. Согласия: отдельная таблица user_consents + RPC accept_documents
--          с серверной датой.
--   ШАГ 3. reports: жалоба больше не видна тому, на кого пожаловались.
--   ШАГ 4. Storage report-images: убрано чтение всех вложений всеми
--          авторизованными, загрузка ограничена своей папкой.
--   ШАГ 5. nearby_profiles()/my_location(): EXECUTE только authenticated.
--   ШАГ 6. handle_new_user(): search_path = '' вместо 'public'.
--   ФИНАЛ.  Проверка, что всё применилось.
--
-- Чего здесь сознательно НЕТ (требует правки клиента или решения продукта):
--   * отзыв moderation_note — сломает ModerationPending в текущем APK;
--   * приватный бакет avatars — сломает существующие публичные URL фото;
--   * взаимность лайков (matches) — нужен отдельный RPC и таблица лайков;
--   * отзыв DELETE на profiles — может сломать Edge Function delete-account,
--     исходников которой нет в репозитории.
-- Эти пункты вынесены в отдельную работу после обновления приложения.


-- ===========================================================================
-- ШАГ 1. profiles: закрыть INSERT и защитить служебные поля на вставку
-- ===========================================================================
--
-- Проблема: у authenticated оставались INSERT и политика «Создание своей
-- анкеты» (id = auth.uid()), а триггер protect_profile_service_fields стоял
-- только на UPDATE. Через DELETE + INSERT можно было создать себе строку
-- с is_admin = true и moderation_status = 'approved' — то есть обойти
-- модерацию и получить права администратора.
--
-- Что делаем:
--   1. отзываем INSERT: строку профиля создаёт только handle_new_user()
--      (SECURITY DEFINER), клиенту она не нужна;
--   2. ставим защитный триггер на INSERT OR UPDATE как второй рубеж;
--   3. чиним DEFAULT moderation_status: текущее значение
--      '''approved''::text' вместе с кавычками не проходит CHECK-ограничение.
--
-- DELETE не трогаем: удаление аккаунта может идти через него, а без INSERT
-- вернуть строку уже нельзя, поэтому эскалация всё равно закрыта.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'handle_new_user'
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION
      'handle_new_user() не SECURITY DEFINER: отзыв INSERT сломает регистрацию. Шаг не применён.';
  END IF;
END;
$$;

REVOKE INSERT ON public.profiles FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.profiles FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Создание своей анкеты" ON public.profiles;

CREATE OR REPLACE FUNCTION public.protect_profile_service_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.is_admin() THEN
    IF tg_op = 'INSERT' THEN
      -- Клиент не может назначить себе права, модерацию или дату согласия.
      -- Для handle_new_user() auth.uid() пуст, поэтому вставка не ломается.
      new.is_admin := false;
      new.moderation_status := 'pending';
      new.moderation_note := null;
      new.terms_accepted_at := null;  -- проставит stamp_terms_accepted
    ELSE
      IF new.is_admin IS DISTINCT FROM old.is_admin
         OR new.moderation_status IS DISTINCT FROM old.moderation_status
         OR new.moderation_note IS DISTINCT FROM old.moderation_note
         OR new.terms_accepted_at IS DISTINCT FROM old.terms_accepted_at THEN
        RAISE EXCEPTION 'Служебные поля анкеты (модерация, права и согласие с правилами) изменяются только модератором'
          USING errcode = '42501';
      END IF;
    END IF;
  END IF;

  new.updated_at := now();
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_service_fields ON public.profiles;

CREATE TRIGGER protect_profile_service_fields
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_service_fields();

ALTER TABLE public.profiles
  ALTER COLUMN moderation_status SET DEFAULT 'pending';

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.profiles', 'INSERT') THEN
    RAISE EXCEPTION 'Шаг 1: у authenticated остался INSERT на profiles.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'Шаг 1: INSERT-политика на profiles не удалена.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'protect_profile_service_fields'
      AND (tgtype & 4) = 4
  ) THEN
    RAISE EXCEPTION 'Шаг 1: триггер не срабатывает на INSERT.';
  END IF;
END;
$$;

COMMIT;


-- ===========================================================================
-- ШАГ 2. Согласия: отдельная таблица и RPC с серверной датой
-- ===========================================================================
--
-- Проблема: SignUp.tsx писал в profiles колонки, которых нет в миграциях
-- (terms_version, privacy_accepted_at и т.д.), а terms_accepted_at защищён
-- триггером. UPDATE падал целиком, и согласия не сохранялись.
--
-- Решение: хранить согласия отдельно, писать их только через RPC.
-- Дату и версию фиксирует сервер; клиент не может ни подделать дату,
-- ни удалить запись (DELETE не выдан).

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_consents (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document    text NOT NULL,
  version     text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_consents_document_check
    CHECK (document IN ('terms', 'privacy', 'special_data')),
  CONSTRAINT user_consents_version_check
    CHECK (length(btrim(version)) BETWEEN 1 AND 32),
  PRIMARY KEY (user_id, document, version)
);

COMMENT ON TABLE public.user_consents IS
  'Факты согласия с документами. Дату ставит сервер при вызове '
  'accept_documents(); клиент не может ни подделать дату, ни удалить запись.';

ALTER TABLE public.user_consents ENABLE ROW LEVEL SECURITY;

-- Таблицу наполняет только RPC (SECURITY DEFINER). Клиенту — чтение своих.
REVOKE ALL ON public.user_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_consents TO authenticated;

DROP POLICY IF EXISTS "Свои согласия: чтение" ON public.user_consents;

CREATE POLICY "Свои согласия: чтение"
  ON public.user_consents
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.accept_documents(
  p_terms_version text,
  p_privacy_version text,
  p_special_data_version text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Требуется вход в аккаунт' USING errcode = '42501';
  END IF;

  IF coalesce(btrim(p_terms_version), '') = ''
     OR coalesce(btrim(p_privacy_version), '') = ''
     OR coalesce(btrim(p_special_data_version), '') = '' THEN
    RAISE EXCEPTION 'Не указана версия документа' USING errcode = '22023';
  END IF;

  INSERT INTO public.user_consents (user_id, document, version, accepted_at)
  VALUES
    (v_uid, 'terms',        btrim(p_terms_version),        now()),
    (v_uid, 'privacy',      btrim(p_privacy_version),      now()),
    (v_uid, 'special_data', btrim(p_special_data_version), now())
  ON CONFLICT (user_id, document, version) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION public.accept_documents(text, text, text) IS
  'Фиксирует согласие с тремя документами от имени текущего пользователя. '
  'Дату ставит сервер, повторный вызов идемпотентен.';

REVOKE ALL ON FUNCTION public.accept_documents(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_documents(text, text, text) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_consents' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Шаг 2: на user_consents не включён RLS.';
  END IF;

  IF has_table_privilege('authenticated', 'public.user_consents', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_consents', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_consents', 'DELETE') THEN
    RAISE EXCEPTION 'Шаг 2: у authenticated остались права на запись в user_consents.';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.accept_documents(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Шаг 2: authenticated не может вызвать accept_documents().';
  END IF;

  IF has_function_privilege('anon', 'public.accept_documents(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Шаг 2: accept_documents() доступна anon.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ===========================================================================
-- ШАГ 3. reports: убрать доступ для reported_id
-- ===========================================================================
--
-- Проблема: политика «Просмотр жалоб» разрешала SELECT автору жалобы И тому,
-- на кого пожаловались. Второй видел и текст жалобы, и reporter_id.
--
-- Оставляем только автора и администратора.

BEGIN;

DROP POLICY IF EXISTS "Просмотр жалоб" ON public.reports;

CREATE POLICY "Просмотр жалоб"
  ON public.reports
  FOR SELECT
  TO authenticated
  USING (auth.uid() = reporter_id OR private.is_admin());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'reports'
      AND policyname = 'Просмотр жалоб'
      AND qual LIKE '%reporter_id%'
      AND qual NOT LIKE '%reported_id%'
  ) THEN
    RAISE EXCEPTION 'Шаг 3: политика reports всё ещё ссылается на reported_id.';
  END IF;
END;
$$;

COMMIT;


-- ===========================================================================
-- ШАГ 4. Storage report-images
-- ===========================================================================
--
-- Проблема: политика «Пользователи могут видеть фото жа» отдавала любой
-- авторизованной роли все объекты бакета report-images.
--
-- Что делаем:
--   * удаляем широкую SELECT-политику;
--   * пересоздаём безопасную: своя папка, вложение своей жалобы или админ;
--   * загрузку ограничиваем своей папкой {uid}/... (две прежние
--     INSERT-политики заменяем одной).

BEGIN;

DROP POLICY IF EXISTS "Пользователи могут видеть фото жа" ON storage.objects;

DROP POLICY IF EXISTS "Просмотр фото своей жалобы" ON storage.objects;

CREATE POLICY "Просмотр фото своей жалобы"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'report-images'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR EXISTS (
        SELECT 1
        FROM public.reports r
        JOIN public.report_attachments a ON a.report_id = r.id
        WHERE a.storage_path = objects.name
          AND r.reporter_id = auth.uid()
      )
      OR private.is_admin()
    )
  );

DROP POLICY IF EXISTS "Загрузка фото жалобы" ON storage.objects;
DROP POLICY IF EXISTS "Пользователи могут загружать фото" ON storage.objects;

CREATE POLICY "Загрузка фото жалобы"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'report-images'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND cmd = 'SELECT'
      AND qual LIKE '%report-images%'
      AND qual NOT LIKE '%foldername%'
      AND qual NOT LIKE '%report_attachments%'
  ) THEN
    RAISE EXCEPTION 'Шаг 4: осталась SELECT-политика, открывающая весь бакет report-images.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Просмотр фото своей жалобы'
  ) THEN
    RAISE EXCEPTION 'Шаг 4: безопасная SELECT-политика не создана.';
  END IF;
END;
$$;

COMMIT;


-- ===========================================================================
-- ШАГ 5. nearby_profiles()/my_location(): убрать доступ у PUBLIC и anon
-- ===========================================================================
--
-- Обе функции созданы без явного REVOKE, поэтому EXECUTE по умолчанию был
-- у PUBLIC. Аноним с anon-ключом мог получить список UUID одобренных анкет
-- и расстояния до них.
--
-- Права выдаются в цикле по pg_proc, а не по жёстко прописанной сигнатуре:
-- набор функций в базе может отличаться от репозитория (например, если
-- my_location() так и не была создана или была удалена откатом). Так шаг
-- не падает из-за отсутствующей функции и не оставляет работу полуприменённой.

BEGIN;

DO $$
DECLARE
  r      record;
  v_seen integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('nearby_profiles', 'my_location')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', r.sig);
    v_seen := v_seen + 1;
    RAISE NOTICE 'Шаг 5: обработана функция %', r.sig;
  END LOOP;

  IF v_seen = 0 THEN
    RAISE EXCEPTION 'Шаг 5: в схеме public не найдено ни nearby_profiles(), ни my_location().';
  END IF;

  FOR r IN
    SELECT p.proname, p.oid,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('nearby_profiles', 'my_location')
      AND (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  LOOP
    RAISE EXCEPTION 'Шаг 5: права на public.%(%) не приведены в порядок', r.proname, r.args;
  END LOOP;
END;
$$;

COMMIT;


-- ===========================================================================
-- ШАГ 6. handle_new_user(): search_path = ''
-- ===========================================================================
--
-- Приводим SECURITY DEFINER-функцию к тому же стилю, что и остальные:
-- пустой search_path и полностью квалифицированные имена.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    moderation_status,
    created_at,
    updated_at
  )
  VALUES (
    new.id,
    'pending',
    now(),
    now()
  );
  RETURN new;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'handle_new_user'
      AND p.prosecdef
      AND coalesce(array_to_string(p.proconfig, ','), '') LIKE '%search_path=%'
  ) THEN
    RAISE EXCEPTION 'Шаг 6: handle_new_user() без SECURITY DEFINER или без search_path.';
  END IF;
END;
$$;

COMMIT;


-- ===========================================================================
-- ФИНАЛЬНАЯ ПРОВЕРКА
-- ===========================================================================
--
-- Запускать после всех шагов. Ничего не меняет, только проверяет.
-- Если какой-то шаг пропущен, будет ошибка со списком невыполненного.

DO $$
DECLARE
  v_bad text := '';
BEGIN
  IF has_table_privilege('authenticated', 'public.profiles', 'INSERT')
     OR has_table_privilege('anon', 'public.profiles', 'INSERT') THEN
    v_bad := v_bad || E'\n  profiles: у клиентских ролей остался INSERT';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'profiles' AND cmd = 'INSERT') THEN
    v_bad := v_bad || E'\n  profiles: осталась INSERT-политика';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname = 'protect_profile_service_fields' AND (tgtype & 4) = 4) THEN
    v_bad := v_bad || E'\n  profiles: триггер не срабатывает на INSERT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'public.profiles'::regclass
      AND a.attname = 'moderation_status'
      AND pg_get_expr(d.adbin, d.adrelid) LIKE '%pending%'
  ) THEN
    v_bad := v_bad || E'\n  profiles: DEFAULT moderation_status не исправлен';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_consents' AND c.relrowsecurity
  ) THEN
    v_bad := v_bad || E'\n  user_consents: таблицы нет или RLS выключен';
  END IF;

  IF has_table_privilege('authenticated', 'public.user_consents', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_consents', 'DELETE') THEN
    v_bad := v_bad || E'\n  user_consents: у authenticated есть запись';
  END IF;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'user_consents') <> 1 THEN
    v_bad := v_bad || E'\n  user_consents: ожидалась ровно одна политика';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.accept_documents(text,text,text)', 'EXECUTE') THEN
    v_bad := v_bad || E'\n  accept_documents: нет доступа у authenticated';
  END IF;

  IF has_function_privilege('anon', 'public.accept_documents(text,text,text)', 'EXECUTE') THEN
    v_bad := v_bad || E'\n  accept_documents: доступна anon';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'reports' AND policyname = 'Просмотр жалоб'
      AND qual LIKE '%reporter_id%' AND qual NOT LIKE '%reported_id%'
  ) THEN
    v_bad := v_bad || E'\n  reports: политика всё ещё пускает reported_id';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'storage' AND tablename = 'objects'
               AND cmd = 'SELECT'
               AND qual LIKE '%report-images%'
               AND qual NOT LIKE '%foldername%'
               AND qual NOT LIKE '%report_attachments%') THEN
    v_bad := v_bad || E'\n  storage: есть SELECT-политика, открывающая весь бакет report-images';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('nearby_profiles', 'my_location')
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    v_bad := v_bad || E'\n  nearby_profiles/my_location: права на EXECUTE не приведены в порядок';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'Не все шаги применены:%', E'\n' || v_bad;
  END IF;

  RAISE NOTICE 'Все проверки пройдены: миграция применена полностью.';
END;
$$;


-- ===========================================================================
-- ШАГ 7. profiles: отозвать чтение координат (выполнять сразу)
-- ===========================================================================
--
-- Проблема: 20260926000000 отзывал колоночный SELECT на latitude/longitude,
-- но 20261116000001 перечислял чувствительные колонки заново и координаты
-- в список не включил. Гранты из 20260926000000 остались в силе, поэтому
-- authenticated читал точные координаты всех анкет обычным запросом
-- в обход nearby_profiles(). Проверка:
--   has_column_privilege('authenticated','public.profiles','latitude','SELECT') = true
--
-- Клиент координаты не читает: только пишет в Feed.tsx и Settings.tsx.
-- Свои координаты отдаёт SECURITY DEFINER-функция my_location().

BEGIN;

REVOKE SELECT (latitude, longitude) ON public.profiles FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF has_column_privilege('authenticated','public.profiles','latitude','SELECT')
     OR has_column_privilege('authenticated','public.profiles','longitude','SELECT')
     OR has_column_privilege('anon','public.profiles','latitude','SELECT') THEN
    RAISE EXCEPTION 'Шаг 7: координаты всё ещё читаются напрямую.';
  END IF;

  -- Запись координат нужна: её делают Feed.tsx и Settings.tsx.
  IF NOT has_column_privilege('authenticated','public.profiles','latitude','UPDATE') THEN
    RAISE EXCEPTION 'Шаг 7: authenticated потерял право записи координат.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;


-- ===========================================================================
-- ШАГ 8. profiles: отозвать чтение moderation_note
-- ===========================================================================
--
-- Проблема: moderation_note остаётся в колоночном SELECT-гранте authenticated.
-- Политика «Просмотр одобренных анкет» отдаёт чужие строки, поэтому любой
-- пользователь может прочитать заметки модератора о других людях.
--
-- ВАЖНО: применять только ПОСЛЕ установки сборки, где ModerationPending
-- читает статус через my_profile(), иначе экран модерации в старом APK
-- покажет ошибку. my_profile() — SECURITY DEFINER, отзыв её не затрагивает.

BEGIN;

REVOKE SELECT (moderation_note) ON public.profiles FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF has_column_privilege('authenticated','public.profiles','moderation_note','SELECT') THEN
    RAISE EXCEPTION 'Шаг 8: moderation_note всё ещё читается напрямую.';
  END IF;

  IF NOT has_function_privilege('authenticated','public.my_profile()','EXECUTE') THEN
    RAISE EXCEPTION 'Шаг 8: authenticated не может вызвать my_profile().';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

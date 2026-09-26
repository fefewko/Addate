-- Проверка результата миграции 20260926000000_lock_down_profiles.sql
--
-- Запускать в SQL Editor ПОСЛЕ применения миграции.
--
-- Скрипт ничего не изменяет: все проверки поведения выполняются внутри
-- транзакции, которая в конце откатывается. Можно запускать много раз.
--
-- Часть A — структурная: привилегии, триггеры, функции, политики.
-- Часть B — поведенческая: скрипт переключается на роль authenticated
--            от имени обычного пользователя и пытается совершить то, что
--            раньше было возможно. Каждая попытка ловится и превращается
--            в PASS/FAIL, поэтому одна неудача не роняет остальные.
--
-- В SQL Editor мы работаем как postgres (суперпользователь), который
-- обходит RLS, поэтому «просто попробовать сделать» в нём нельзя.
-- Часть B решает это через SET LOCAL ROLE + подмену auth.uid().

-- ===========================================================================
-- Часть A. Структурная проверка
-- ===========================================================================

\echo '=== A. Структурная проверка ==='

DO $$
DECLARE
  v_bad text := '';
BEGIN
  -- A1. UPDATE на messages/matches не должен остаться на уровне таблицы
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND c.relname IN ('messages', 'matches')
      AND r.rolname = 'authenticated' AND acl.privilege_type = 'UPDATE'
  ) THEN
    v_bad := v_bad || '  [ПРОВАЛ] на ' || (
      SELECT string_agg(c.relname, ', ')
      FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) acl
        JOIN pg_roles r ON r.oid = acl.grantee
      WHERE n.nspname = 'public' AND c.relname IN ('messages', 'matches')
        AND r.rolname = 'authenticated' AND acl.privilege_type = 'UPDATE'
    ) || ' остался UPDATE уровня таблицы (ограничение по колонкам не действует)' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] UPDATE на messages/matches ограничен уровнем колонки';
  END IF;

  -- A2. SELECT на profiles не должен остаться на уровне таблицы
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND r.rolname = 'authenticated' AND acl.privilege_type = 'SELECT'
  ) THEN
    v_bad := v_bad || '  [ПРОВАЛ] на profiles остался SELECT уровня таблицы — координаты всё ещё отдаются' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] SELECT на profiles ограничен списком колонок';
  END IF;

  -- A3. Нужные привилегии на уровне колонки выданы
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE a.attrelid = 'public.messages'::regclass AND a.attname = 'read_at'
      AND a.attnum > 0 AND NOT a.attisdropped
      AND r.rolname = 'authenticated' AND acl.privilege_type = 'UPDATE'
  ) THEN
    v_bad := v_bad || '  [ПРОВАЛ] нет UPDATE на messages.read_at — прочитанные не будут отмечаться' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] UPDATE на messages.read_at есть';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE a.attrelid = 'public.matches'::regclass AND a.attname IN ('status', 'matched_at')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND r.rolname = 'authenticated' AND acl.privilege_type = 'UPDATE'
  ) THEN
    v_bad := v_bad || '  [ПРОВАЛ] нет UPDATE на matches.status / matched_at' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] UPDATE на matches.status / matched_at есть';
  END IF;

  -- A4. latitude/longitude не должны попадать в выдачу
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE a.attrelid = 'public.profiles'::regclass
      AND a.attname IN ('latitude', 'longitude')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND r.rolname = 'authenticated' AND acl.privilege_type = 'SELECT'
  ) THEN
    v_bad := v_bad || '  [ПРОВАЛ] latitude/longitude всё ещё выдаются authenticated' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] latitude/longitude не выдаются authenticated';
  END IF;

  -- A5. Объекты, которые обязаны существовать
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'my_location') THEN
    v_bad := v_bad || '  [ПРОВАЛ] нет функции my_location()' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] функция my_location() есть';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_profile_service_fields') THEN
    v_bad := v_bad || '  [ПРОВАЛ] нет триггера protect_profile_service_fields' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] триггер protect_profile_service_fields есть';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'no_self_match') THEN
    v_bad := v_bad || '  [ПРОВАЛ] нет триггера no_self_match' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] триггер no_self_match есть';
  END IF;

  -- A6. Политика чтения переписки должна проверять статус совпадения
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'messages' AND cmd = 'SELECT'
      AND qual LIKE '%status%'
  ) THEN
    v_bad := v_bad || '  [ПРОВАЛ] политика чтения messages не проверяет статус совпадения' || E'\n';
  ELSE
    RAISE NOTICE '  [ОК] политика чтения messages проверяет статус совпадения';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'Часть A: часть проверок не пройдена:%', E'\n' || v_bad;
  END IF;

  RAISE NOTICE 'Часть A: все структурные проверки пройдены.';
END;
$$;

\echo ''
\echo '=== B. Поведенческая проверка (откатится в конце) ==='

BEGIN;

-- Фикстуры: два обычных пользователя, модератор и ещё одна анкета для
-- неподтверждённого совпадения. Карол нужна потому, что на matches есть
-- уникальный индекс matches_unique_pair на (LEAST(user_a,user_b), GREATEST(...)),
-- то есть пара может существовать только один раз и в любом направлении.
-- Вторую «неподтверждённую» пару на тех же людей создать нельзя.
--
-- ON CONFLICT указан по (id), а не просто DO NOTHING: иначе конфликт по
-- matches_unique_pair проглотился бы молча и фикстура не создалась бы.
DO $$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('a1000000-0000-4000-8000-000000000001', 'verify-alice@test.local'),
    ('a1000000-0000-4000-8000-000000000002', 'verify-bob@test.local'),
    ('a1000000-0000-4000-8000-000000000003', 'verify-admin@test.local'),
    ('a1000000-0000-4000-8000-000000000004', 'verify-carol@test.local')
  ON CONFLICT (id) DO NOTHING;

  UPDATE profiles SET
    display_name = 'Verify Alice', moderation_status = 'approved',
    latitude = 55.75, longitude = 37.61
  WHERE id = 'a1000000-0000-4000-8000-000000000001';

  UPDATE profiles SET
    display_name = 'Verify Bob', moderation_status = 'approved',
    latitude = 55.80, longitude = 37.70
  WHERE id = 'a1000000-0000-4000-8000-000000000002';

  UPDATE profiles SET
    display_name = 'Verify Admin', moderation_status = 'approved', is_admin = true
  WHERE id = 'a1000000-0000-4000-8000-000000000003';

  UPDATE profiles SET
    display_name = 'Verify Carol', moderation_status = 'approved',
    latitude = 56.10, longitude = 37.90
  WHERE id = 'a1000000-0000-4000-8000-000000000004';

  -- подтверждённое совпадение Алиса ↔ Боб с перепиской
  INSERT INTO matches (id, user_a, user_b, status, matched_at) VALUES
    ('b1000000-0000-4000-8000-000000000001',
     'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002',
     'matched', now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO messages (match_id, sender_id, content)
  SELECT 'b1000000-0000-4000-8000-000000000001',
         'a1000000-0000-4000-8000-000000000002', 'проверочное сообщение'
  WHERE NOT EXISTS (
    SELECT 1 FROM messages WHERE match_id = 'b1000000-0000-4000-8000-000000000001'
  );

  -- неподтверждённое совпадение Алиса ↔ Кэрол с «секретным» сообщением Кэрол.
  -- Сообщение вставлено от имени суперпользователя (обходит RLS): в реальности
  -- отправить его в pending-паре нельзя, но именно такая строка и не должна
  -- быть прочитана Алисой.
  INSERT INTO matches (id, user_a, user_b, status) VALUES
    ('b1000000-0000-4000-8000-000000000002',
     'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000004',
     'pending')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO messages (match_id, sender_id, content)
  SELECT 'b1000000-0000-4000-8000-000000000002',
         'a1000000-0000-4000-8000-000000000004', 'секретное сообщение'
  WHERE NOT EXISTS (
    SELECT 1 FROM messages WHERE match_id = 'b1000000-0000-4000-8000-000000000002'
  );
END;
$$;

-- Теперь мы — обычный пользователь Alice.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

-- B1. Не может выдать себе права админа
DO $$
BEGIN
  UPDATE profiles SET is_admin = true
    WHERE id = 'a1000000-0000-4000-8000-000000000001';
  RAISE NOTICE '  [ПРОВАЛ] UPDATE profiles SET is_admin = true — ПРОШЁЛ, эскалация возможна';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '  [ОК] выдать себе is_admin = true нельзя (%, %)', SQLSTATE, SQLERRM;
END;
$$;

-- B2. Не может одобрить собственную анкету
DO $$
BEGIN
  UPDATE profiles SET moderation_status = 'approved'
    WHERE id = 'a1000000-0000-4000-8000-000000000001';
  RAISE NOTICE '  [ПРОВАЛ] self-moderation — ПРОШЛА, анкету можно согласовать себе';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '  [ОК] одобрить свою анкету нельзя (%, %)', SQLSTATE, SQLERRM;
END;
$$;

-- B3. Не может прочитать точные координаты другого человека
DO $$
DECLARE v_cnt integer;
BEGIN
  SELECT count(*) INTO v_cnt FROM profiles
    WHERE id = 'a1000000-0000-4000-8000-000000000002'
      AND latitude IS NOT NULL;
  IF v_cnt = 0 THEN
    RAISE NOTICE '  [ПРОВАЛ] чужие координаты вернули пустоту — колонка всё ещё выдаётся';
  ELSE
    RAISE NOTICE '  [ПРОВАЛ] чужие координаты прочитаны, строк: %', v_cnt;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '  [ОК] чужие координаты недоступны (%, %)', SQLSTATE, SQLERRM;
END;
$$;

-- B4. Не может изменить текст чужого сообщения
DO $$
BEGIN
  UPDATE messages SET content = 'взломано'
    WHERE match_id = 'b1000000-0000-4000-8000-000000000001'
      AND sender_id = 'a1000000-0000-4000-8000-000000000002';
  RAISE NOTICE '  [ПРОВАЛ] правка чужого сообщения — ПРОШЛА';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '  [ОК] текст чужого сообщения защищён (%, %)', SQLSTATE, SQLERRM;
END;
$$;

-- B5. Не может подменить участника своей пары
DO $$
BEGIN
  UPDATE matches SET user_b = 'a1000000-0000-4000-8000-000000000001'
    WHERE id = 'b1000000-0000-4000-8000-000000000001';
  RAISE NOTICE '  [ПРОВАЛ] подмена user_b — ПРОШЛА';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '  [ОК] участники пары неизменяемы (%, %)', SQLSTATE, SQLERRM;
END;
$$;

-- B6. Не может поставить лайк самому себе
DO $$
BEGIN
  INSERT INTO matches (user_a, user_b) VALUES (
    'a1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001'
  );
  RAISE NOTICE '  [ПРОВАЛ] лайк самому себе — ПРОШЁЛ';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '  [ОК] лайк самому себе запрещён (%, %)', SQLSTATE, SQLERRM;
END;
$$;

-- B7. Не может читать переписку неподтверждённого совпадения
DO $$
DECLARE v_cnt integer;
BEGIN
  SELECT count(*) INTO v_cnt FROM messages
    WHERE match_id = 'b1000000-0000-4000-8000-000000000002';
  IF v_cnt = 0 THEN
    RAISE NOTICE '  [ОК] переписка неподтверждённого совпадения не читается';
  ELSE
    RAISE NOTICE '  [ПРОВАЛ] прочитано % строк переписки pending-совпадения', v_cnt;
  END IF;
END;
$$;

-- B8. Приложение не сломано: всё, что нужно обычному пользователю, работает
DO $$
DECLARE
  v_profiles integer;
  v_read     integer;
  v_matched  integer;
  v_location integer;
  v_nearby   integer;
  v_bad      text := '';
BEGIN
  SELECT count(*) INTO v_profiles FROM profiles
    WHERE id = 'a1000000-0000-4000-8000-000000000002'
      AND display_name = 'Verify Bob';
  IF v_profiles <> 1 THEN
    v_bad := v_bad || '  [ПРОВАЛ] чужую одобренную анкету не видно' || E'\n';
  END IF;

  SELECT count(*) INTO v_matched FROM matches
    WHERE id = 'b1000000-0000-4000-8000-000000000001';
  IF v_matched <> 1 THEN
    v_bad := v_bad || '  [ПРОВАЛ] своё совпадение не видно' || E'\n';
  END IF;

  SELECT count(*) INTO v_read FROM messages
    WHERE match_id = 'b1000000-0000-4000-8000-000000000001';
  IF v_read <> 1 THEN
    v_bad := v_bad || '  [ПРОВАЛ] переписку подтверждённого совпадения не видно' || E'\n';
  END IF;

  -- отметка прочитанным (единственный UPDATE, который нужен приложению)
  UPDATE messages SET read_at = now()
    WHERE match_id = 'b1000000-0000-4000-8000-000000000001'
      AND sender_id <> 'a1000000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    v_bad := v_bad || '  [ПРОВАЛ] отметка прочитанным не сработала' || E'\n';
  END IF;

  -- свои координаты через my_location()
  SELECT count(*) INTO v_location FROM my_location();
  IF v_location <> 1 THEN
    v_bad := v_bad || '  [ПРОВАЛ] my_location() не вернул свои координаты' || E'\n';
  END IF;

  -- расстояние до анкет
  SELECT count(*) INTO v_nearby FROM nearby_profiles(55.75, 37.61);
  IF v_nearby < 2 THEN
    v_bad := v_bad || '  [ПРОВАЛ] nearby_profiles() вернул % строк, ожидалось минимум 2', v_nearby;
  END IF;

  -- свои разрешённые поля править можно
  UPDATE profiles SET city = 'Москва', bio = 'проверка'
    WHERE id = 'a1000000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    v_bad := v_bad || '  [ПРОВАЛ] не удалось изменить свои city/bio' || E'\n';
  END IF;

  -- записать свои координаты можно
  UPDATE profiles SET latitude = 55.70, longitude = 37.50
    WHERE id = 'a1000000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    v_bad := v_bad || '  [ПРОВАЛ] не удалось записать свои координаты' || E'\n';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'Часть B8: приложение сломано:%', E'\n' || v_bad;
  END IF;

  RAISE NOTICE '  [ОК] приложение не сломано: чужие анкеты видны, переписка и read_at работают,';
  RAISE NOTICE '       my_location() и nearby_profiles() отвечают, свои поля правятся';
END;
$$;

ROLLBACK;

\echo ''
\echo '=== Готово. Транзакция откачена, база не изменена. ==='

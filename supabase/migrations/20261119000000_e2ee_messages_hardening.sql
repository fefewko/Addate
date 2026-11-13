-- E2EE-переписка: идемпотентная отправка и удаление сообщений.
--
-- Закрывает три пункта из требований:
--   1. Защита от повторной отправки. У сообщения появляется client_message_id,
--      который генерирует клиент. Повторная отправка (двойной тап, ретрай после
--      обрыва сети) упирается в уникальный индекс и не создаёт дубль.
--   2. Удаление у себя. Отдельная таблица message_deletions: строка скрывает
--      сообщение только у одного участника, остальные продолжают его видеть.
--   3. Удаление у обоих. Автор может очистить content и image_path; строка
--      остаётся как «Сообщение удалено», чтобы не ломать порядок и id.
--
-- Почему RPC, а не прямой UPDATE: в шаге 10 миграции 20261117000000 у
-- authenticated осталось право UPDATE только на messages.read_at. Это сделано
-- намеренно — content и image_path нельзя переписывать с клиента. Очистку
-- делает SECURITY DEFINER-функция с проверкой авторства.
--
-- Каждый шаг — отдельная транзакция, шаги идемпотентны: файл можно применять
-- целиком или по одному блоку в SQL Editor.

-- ===========================================================================
-- ШАГ 1. client_message_id: идемпотентная отправка
-- ===========================================================================
--
-- NULL разрешён: старые строки и сообщения из панели поддержки его не имеют.
-- Уникальность считается только по непустым значениям и в пределах
-- отправителя.

BEGIN;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS client_message_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_client_id_key
  ON public.messages (sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

COMMENT ON COLUMN public.messages.client_message_id IS
  'Идентификатор отправки, сгенерированный клиентом. Повторный INSERT с тем же '
  'значением не создаёт дубль (идемпотентность при ретраях).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name = 'client_message_id'
  ) THEN
    RAISE EXCEPTION 'Шаг 1: нет messages.client_message_id.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'messages'
      AND indexname = 'messages_sender_client_id_key'
  ) THEN
    RAISE EXCEPTION 'Шаг 1: нет уникального индекса по client_message_id.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ===========================================================================
-- ШАГ 2. deleted_at: удаление у обоих
-- ===========================================================================
--
-- Старая CHECK-констрейнта требовала content или image_path. У удалённого
-- сообщения оба поля становятся NULL, поэтому её нужно ослабить.

BEGIN;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_content_or_image;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_content_or_image CHECK (
    deleted_at IS NOT NULL
    OR (content IS NOT NULL AND length(btrim(content)) > 0)
    OR image_path IS NOT NULL
  );

COMMENT ON COLUMN public.messages.deleted_at IS
  'Момент удаления сообщения у обоих участников. content и image_path при этом '
  'очищаются: расшифровывать больше нечего.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name = 'deleted_at'
  ) THEN
    RAISE EXCEPTION 'Шаг 2: нет messages.deleted_at.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_content_or_image'
      AND pg_get_constraintdef(oid) LIKE '%deleted_at%'
  ) THEN
    RAISE EXCEPTION 'Шаг 2: CHECK-констрейнта не учитывает deleted_at.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ===========================================================================
-- ШАГ 3. message_deletions: удаление у себя
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.message_deletions (
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

ALTER TABLE public.message_deletions ENABLE ROW LEVEL SECURITY;

-- Видеть и создавать можно только свои скрытия и только для сообщений из
-- переписки, где пользователь действительно участник.
DROP POLICY IF EXISTS "Свои скрытые сообщения" ON public.message_deletions;

CREATE POLICY "Свои скрытые сообщения"
  ON public.message_deletions
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.messages msg
      JOIN public.matches m ON m.id = msg.match_id
      WHERE msg.id = message_deletions.message_id
        AND m.status = 'matched'
        AND (m.user_a = auth.uid() OR m.user_b = auth.uid())
    )
  );

COMMENT ON POLICY "Свои скрытые сообщения" ON public.message_deletions IS
  'Пользователь скрывает сообщения только у себя и только в своей переписке.';

REVOKE ALL ON public.message_deletions FROM PUBLIC, anon;
GRANT SELECT, INSERT, DELETE ON public.message_deletions TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'message_deletions'
  ) THEN
    RAISE EXCEPTION 'Шаг 3: нет таблицы message_deletions.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.message_deletions'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Шаг 3: на message_deletions не включён RLS.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ===========================================================================
-- ШАГ 4. RPC удаления сообщения
-- ===========================================================================
--
-- p_for_everyone = false: скрыть у себя (INSERT в message_deletions).
-- p_for_everyone = true:  очистить у обоих, только автор.
--
-- Проверка участия в переписке обязательна: без неё любой авторизованный мог
-- бы удалить чужое сообщение по известному uuid.

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_message(
  p_message_id uuid,
  p_for_everyone boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sender uuid;
  v_match  uuid;
BEGIN
  SELECT msg.sender_id, msg.match_id
    INTO v_sender, v_match
  FROM public.messages msg
  WHERE msg.id = p_message_id;

  IF v_sender IS NULL THEN
    RAISE EXCEPTION 'Сообщение не найдено' USING errcode = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.matches m
    WHERE m.id = v_match
      AND m.status = 'matched'
      AND (m.user_a = auth.uid() OR m.user_b = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Нет доступа к этой переписке' USING errcode = '42501';
  END IF;

  IF p_for_everyone THEN
    IF v_sender <> auth.uid() THEN
      RAISE EXCEPTION 'Удалить сообщение у обоих может только его автор'
        USING errcode = '42501';
    END IF;

    UPDATE public.messages
       SET content = NULL,
           image_path = NULL,
           deleted_at = COALESCE(deleted_at, now())
     WHERE id = p_message_id;

    -- Превью в списке диалогов общее для обоих, поэтому пересчитываем его
    -- после удаления. Для «удалить у себя» превью не трогаем: второй участник
    -- по-прежнему видит сообщение.
    UPDATE public.matches m
       SET last_message_preview = COALESCE((
             SELECT CASE
                      WHEN last.image_path IS NOT NULL THEN 'Фото'
                      WHEN last.content IS NULL THEN 'Сообщение удалено'
                      WHEN left(last.content, 1) <> '{' THEN left(last.content, 80)
                      ELSE '🔒 Сообщение'
                    END
             FROM public.messages last
             WHERE last.match_id = v_match
               AND last.deleted_at IS NULL
             ORDER BY last.created_at DESC
             LIMIT 1
           ), 'Сообщение удалено')
     WHERE m.id = v_match;

    RETURN 'deleted_for_all';
  END IF;

  INSERT INTO public.message_deletions (message_id, user_id)
  VALUES (p_message_id, auth.uid())
  ON CONFLICT (message_id, user_id) DO NOTHING;

  RETURN 'deleted_for_me';
END;
$$;

COMMENT ON FUNCTION public.delete_message(uuid, boolean) IS
  'Удаление сообщения: false — скрыть у себя, true — очистить у обоих (только '
  'автор). Проверяет участие в подтверждённой переписке.';

REVOKE ALL ON FUNCTION public.delete_message(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_message(uuid, boolean) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'delete_message' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'Шаг 4: delete_message() создана без SECURITY DEFINER.';
  END IF;

  IF NOT has_function_privilege('authenticated','public.delete_message(uuid, boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'Шаг 4: authenticated не может вызвать delete_message().';
  END IF;

  IF has_function_privilege('anon','public.delete_message(uuid, boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'Шаг 4: delete_message() доступна anon.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ===========================================================================
-- ШАГ 5. Storage: удаление фото из переписки
-- ===========================================================================
--
-- Раньше у chat-images были только INSERT и SELECT. При удалении сообщения
-- у обоих клиент чистит и объект в хранилище; без DELETE-политики он остался
-- бы лежать вечно. Доступ — как у SELECT: только участники этой переписки.

BEGIN;

DROP POLICY IF EXISTS "Удаление фото из своего чата" ON storage.objects;

CREATE POLICY "Удаление фото из своего чата"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-images'
    AND EXISTS (
      SELECT 1
      FROM public.matches m
      WHERE m.id::text = (storage.foldername(name))[1]
        AND m.status = 'matched'
        AND (m.user_a = auth.uid() OR m.user_b = auth.uid())
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Удаление фото из своего чата'
  ) THEN
    RAISE EXCEPTION 'Шаг 5: нет DELETE-политики на chat-images.';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

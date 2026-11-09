-- Фото профиля и фото в чате: восстановление политик Storage.
--
-- Симптом: загрузка аватарки падает с
--   new row violates row-level security policy
-- Это ошибка INSERT-политики на storage.objects: роль authenticated не может
-- создать объект в бакете avatars.
--
-- Политики для storage.objects есть в 20260919164719_local_baseline.sql, но
-- этот блок в дампе идёт ПОСЛЕ строки "PostgreSQL database dump complete" и в
-- некоторых способах накатывания базы не выполняется. В результате таблицы и
-- функции на сервере есть, а бакетов и политик нет. То же самое, что было с
-- грантами на profiles.public_key.
--
-- Миграция идемпотентна: удаляет политики по именам и создаёт заново.

BEGIN;

-- 1. Бакеты ------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-images', 'chat-images', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- 2. avatars: загрузка/замена/чтение/удаление своих файлов -------------------

DROP POLICY IF EXISTS "Загрузка своего аватара" ON storage.objects;
CREATE POLICY "Загрузка своего аватара"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

DROP POLICY IF EXISTS "Обновление своего аватара" ON storage.objects;
CREATE POLICY "Обновление своего аватара"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

DROP POLICY IF EXISTS "Публичное чтение аватаров" ON storage.objects;
CREATE POLICY "Публичное чтение аватаров"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Удаление своих файлов" ON storage.objects;
CREATE POLICY "Удаление своих файлов"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );

-- 3. chat-images: путь {matchId}/..., доступ только участникам совпадения ----

DROP POLICY IF EXISTS "Загрузка фото в свой чат" ON storage.objects;
CREATE POLICY "Загрузка фото в свой чат"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-images'
    AND EXISTS (
      SELECT 1
      FROM public.matches m
      WHERE m.id::text = (storage.foldername(name))[1]
        AND m.status = 'matched'
        AND (m.user_a = auth.uid() OR m.user_b = auth.uid())
    )
  );

DROP POLICY IF EXISTS "Просмотр фото своего чата" ON storage.objects;
CREATE POLICY "Просмотр фото своего чата"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-images'
    AND EXISTS (
      SELECT 1
      FROM public.matches m
      WHERE m.id::text = (storage.foldername(name))[1]
        AND (m.user_a = auth.uid() OR m.user_b = auth.uid())
    )
  );

COMMIT;

-- Фикс прав после миграции приватности 20261116000000.
--
-- 1. На public.profiles отсутствовал UPDATE уровня таблицы: у authenticated
--    была только колоночная привилегия на public_key (20261111000000).
--    Поэтому любое сохранение настроек приватности падало с
--    "permission denied for table profiles". Служебные поля (is_admin,
--    moderation_status, moderation_note, terms_accepted_at) по-прежнему
--    защищены триггером protect_profile_service_fields, так что табличный
--    UPDATE не даёт эскалации.
--
-- 2. REVOKE SELECT на уровне таблицы НЕ снимает ранее выданные колоночные
--    гранты. Гранты из 20260926000000 продолжали отдавать чувствительные
--    колонки напрямую через PostgREST в обход profile_cards. Отзываем их явно.
--
-- Идемпотентно.

BEGIN;

GRANT UPDATE ON public.profiles TO authenticated;

REVOKE SELECT (
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
  additional_photos,
  height_cm,
  weight_kg,
  last_seen_at
) ON public.profiles FROM authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

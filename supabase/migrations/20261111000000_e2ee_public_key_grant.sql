-- E2EE: права на profiles.public_key.
--
-- Колонка добавлена миграцией 20261109000000_e2ee_chat.sql уже ПОСЛЕ того,
-- как 20260926000000_lock_down_profiles.sql выдал authenticated доступ к
-- profiles по колонкам (SELECT public_key в тот список не входил, а новые
-- колонки в старый грант не попадают).
--
-- Без этого приложение не может ни прочитать чужой публичный ключ, ни
-- сохранить свой. Внешне это выглядит так: ключи создаются локально, но в
-- профиле остаются пустыми, и чат пишет «у собеседника нет ключа».

GRANT SELECT (public_key) ON public.profiles TO authenticated;
GRANT UPDATE (public_key) ON public.profiles TO authenticated;

-- PostgREST кеширует схему: без этого запросы к public_key могут ещё какое-то
-- время отвечать «column not found».
NOTIFY pgrst, 'reload schema';

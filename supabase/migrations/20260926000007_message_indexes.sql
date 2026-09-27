-- Индексы под реальные запросы приложения
--
-- Зачем:
--
-- 1. messages(read_at) WHERE read_at IS NULL. Непрочитанные ищутся дважды:
--    бейдж на вкладке «Сообщения» (App.tsx) и точки в списке диалогов
--    (ChatList.tsx). Условие read_at IS NULL селективно: у прочитанных
--    сообщений индексные записи не создаются, поэтому индекс остаётся
--    маленьким по мере накопления истории. Частичный индекс здесь уместнее
--    обычного, потому что читается именно это подмножество.
--
-- 2. messages(match_id, created_at). Открытый чат — это
--    "where match_id = X order by created_at", то есть нужен сортирующий
--    индекс. Был только idx_messages_match_id по одному столбцу, поэтому
--    Postgres сортировал найденное в памяти. Составной индекс снимает сортировку.
--
-- Оба индекса не меняют результат запроса, только убирают последовательные
-- сканы и сортировки, поэтому применяются на работающей базе безопасно.
--
-- Идемпотентно.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON public.messages (sender_id)
  WHERE read_at IS NULL;

COMMENT ON INDEX public.idx_messages_unread IS
  'Частичный индекс под непрочитанные сообщения: условие read_at IS NULL '
  'выбирается и в бейдже непрочитанных, и в списке диалогов. Селективный, '
  'поэтому не растёт вместе с историей.';

CREATE INDEX IF NOT EXISTS idx_messages_match_created
  ON public.messages (match_id, created_at DESC);

COMMENT ON INDEX public.idx_messages_match_created IS
  'Открытый чат читается как where match_id = X order by created_at. Без '
  'составного индекса Postgres сортировал выборку в памяти.';

COMMIT;

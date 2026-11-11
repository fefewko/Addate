-- Права приложения на push_tokens.
--
-- Симптом: проверка уведомлений в приложении показывает «Токен в базе — не
-- удалось сохранить», хотя push-токен устройства получен. Уведомления не
-- приходят, потому что серверу некуда их отправлять: строки в push_tokens нет.
--
-- Причина: на таблице включён RLS, а политики разрешают только DELETE
-- («Удаление своих push-токенов»). Для SELECT/INSERT/UPDATE политик нет, поэтому
-- upsert из приложения отклоняется. Плюс у роли authenticated может не быть
-- грантов на запись, если таблицу создавали вручную.
--
-- Идемпотентно: можно выполнять повторно, ничего не сломает.

BEGIN;

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

-- Политика на все команды сразу. Имя заменяем на понятное, старые убираем,
-- чтобы не оставлять противоречивых правил.
DROP POLICY IF EXISTS "Управление своими push-токенами" ON public.push_tokens;
DROP POLICY IF EXISTS "Свои push-токены" ON public.push_tokens;

CREATE POLICY "Свои push-токены"
  ON public.push_tokens
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON POLICY "Свои push-токены" ON public.push_tokens IS
  'Пользователь видит и меняет только свои push-токены. Без INSERT/UPDATE '
  'приложение не может сохранить токен устройства, и уведомления не приходят.';

-- Гранты на уровне таблицы: RLS ограничивает строки, но не заменяет гранты.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_tokens TO authenticated;

COMMIT;

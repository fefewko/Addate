-- Диагностика push-уведомлений (только чтение, ничего не меняет).
--
-- Зачем: цепочка длинная — приложение → Expo push-токен → push_tokens →
-- триггер на messages → Edge Function → Expo Push API → FCM → телефон.
-- Клиентская часть проверяется в приложении: Настройки → «Проверить, доходят ли
-- уведомления». Этот скрипт показывает серверную часть.
--
-- Выполнять целиком в Supabase → SQL Editor. Если какой-то запрос упадёт
-- (например, нет pg_net), это само по себе диагностический признак — просто
-- переходите к следующему.

-- ---------------------------------------------------------------------------
-- 1. Токены устройств
-- ---------------------------------------------------------------------------
-- Если здесь нет строки нужного пользователя, отправлять некуда: приложение
-- не зарегистрировало токен (нет разрешения / ошибка FCM на клиенте).
select user_id, expo_push_token, updated_at
from public.push_tokens
order by updated_at desc
limit 20;

-- ---------------------------------------------------------------------------
-- 2. Триггер на новые сообщения
-- ---------------------------------------------------------------------------
-- Ожидается триггер вида send_push_on_message / notify_new_message на
-- public.messages FOR EACH ROW. Пусто — значит push на сервере не запускается
-- вообще, и дело не в приложении.
select t.tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'messages'
  and not t.tgisinternal;

-- ---------------------------------------------------------------------------
-- 3. Исходящие HTTP-запросы триггера (pg_net)
-- ---------------------------------------------------------------------------
-- Строка с status_code = 200 и телом {"ok":true} — функция отработала.
-- 401 — не совпал секрет PUSH_NOTIFY_SECRET. 404 — функция не задеплоена.
select extname from pg_extension where extname = 'pg_net';

select id, status_code, content, created
from net._http_response
order by created desc
limit 10;

-- ---------------------------------------------------------------------------
-- 4. Секрет, зашитый в триггер
-- ---------------------------------------------------------------------------
-- Показывает текст функции триггера: в нём видно URL Edge Function и заголовок
-- с секретом. Секрет в функции обязан совпадать с секретом функции
-- PUSH_NOTIFY_SECRET в Supabase → Edge Functions → Secrets.
select p.proname, pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname ilike '%push%' or p.proname ilike '%notif%');

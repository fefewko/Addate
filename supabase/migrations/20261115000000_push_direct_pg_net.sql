-- Push-уведомления о новых сообщениях напрямую из базы.
--
-- Зачем: раньше цепочка была «триггер → Edge Function send-message-push →
-- Expo Push API». Если функция не задеплоена, секрет PUSH_NOTIFY_SECRET не
-- совпадает или pg_net не установлен, уведомления молча не доходят, а
-- проверить это из приложения нельзя. Здесь отправка идёт сразу из триггера
-- в Expo Push API через pg_net: меньше звеньев, нечему рассинхронизироваться.
--
-- Текст сообщения не отправляется: переписка зашифрована на клиенте, сервер
-- видит только шифртекст. В уведомлении — имя отправителя и «Новое сообщение».
--
-- Идемпотентно: можно выполнять повторно.

BEGIN;

-- pg_net даёт базе асинхронные HTTP-запросы. Функции живут в схеме net.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.notify_new_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  recipient uuid;
  sender_name text;
  payload jsonb;
BEGIN
  IF NEW.sender_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Второй участник переписки.
  SELECT CASE WHEN m.user_a = NEW.sender_id THEN m.user_b ELSE m.user_a END
    INTO recipient
  FROM public.matches m
  WHERE m.id = NEW.match_id;

  IF recipient IS NULL OR recipient = NEW.sender_id THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(btrim(p.display_name), '')
    INTO sender_name
  FROM public.profiles p
  WHERE p.id = NEW.sender_id;

  -- Одно уведомление на каждое устройство получателя. Нет токенов — значит,
  -- человек выключил уведомления или ещё не входил с телефона: молча выходим.
  SELECT jsonb_agg(
           jsonb_build_object(
             'to', t.expo_push_token,
             'title', COALESCE(sender_name, 'ADDate'),
             'body', 'Новое сообщение',
             'sound', 'default',
             'priority', 'high',
             'channelId', 'default',
             'data', jsonb_build_object(
               'matchId', NEW.match_id,
               'otherUserId', NEW.sender_id,
               'otherName', sender_name
             )
           )
         )
    INTO payload
  FROM public.push_tokens t
  WHERE t.user_id = recipient;

  IF payload IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    body := payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Accept', 'application/json'
    ),
    timeout_milliseconds := 10000
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_new_message() IS
  'При новом сообщении отправляет push получателю через Expo Push API. '
  'Текст переписки не передаёт: он зашифрован на клиенте.';

-- Убираем прежние триггеры на messages, которые звали Edge Function: иначе
-- на одно сообщение ушло бы два уведомления (или старое падало бы с 401).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public'
      AND c.relname = 'messages'
      AND NOT t.tgisinternal
      AND t.tgname <> 'send_push_on_message'
      AND (p.proname ILIKE '%push%' OR p.proname ILIKE '%notif%')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.messages', r.tgname);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS send_push_on_message ON public.messages;

CREATE TRIGGER send_push_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_message();

COMMIT;

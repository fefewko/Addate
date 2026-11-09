-- E2EE: превью последнего сообщения в списке диалогов.
--
-- С phase 1 текст уходит в messages.content в виде JSON-конверта
-- {v, nonce, ct} (crypto_box_easy). С phase 2 изображения — как зашифрованные
-- байты в том же JSON-формате, плюс image_path на ciphertext в storage.
-- Сервер не умеет читать plaintext, поэтому left(content, 80) раньше
-- выводил шифртекст (например, {"v":1,"nonce":"... в диалоги.
--
-- Для шифрованных сообщений теперь фиксируем читаемый плейсхолдер:
--   - фото  -> 'Фото'
--   - текст -> '🔒 Сообщение'
-- Для не-шифрованных (legacy plaintext) оставляем прежнюю выжимку.

BEGIN;

CREATE OR REPLACE FUNCTION public.touch_match_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
begin
  update public.matches
     set last_message_at = new.created_at,
         last_message_preview = case
           when new.image_path is not null and new.content is null then 'Фото'
           when new.content is null or left(new.content, 1) <> '{' then left(new.content, 80)
           when new.image_path is not null then 'Фото'
           else '🔒 Сообщение'
         end
    where id = new.match_id;

  return new;
end;
$$;

COMMENT ON FUNCTION public.touch_match_last_message() IS
  'Обновляет last_message_at и last_message_preview в паре при вставке '
  'сообщения. Нужен, чтобы список диалогов сортировался по свежести '
  'переписки, а не по дате совпадения.';

DROP TRIGGER IF EXISTS touch_match_last_message ON public.messages;

CREATE TRIGGER touch_match_last_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_match_last_message();

-- Backfill: у пар с уже существующими шифрованными сообщениями поправить
-- сохранённые превью, чтобы они не содержали шифртекст.
update public.matches m
   set last_message_preview = sub.preview
  from (
    select distinct on (msg.match_id)
           msg.match_id,
           case
             when msg.image_path is not null and msg.content is null then 'Фото'
             when msg.content is null or left(msg.content, 1) <> '{' then left(msg.content, 80)
             when msg.image_path is not null then 'Фото'
             else '🔒 Сообщение'
           end as preview
      from public.messages msg
     order by msg.match_id, msg.created_at desc
  ) as sub
 where m.id = sub.match_id;

COMMIT;

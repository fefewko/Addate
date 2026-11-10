-- E2EE: резервная копия приватного ключа.
--
-- Приватный ключ переписки хранится только на устройстве (profiles.public_key —
-- лишь открытая половина пары). Переустановка приложения или очистка данных
-- означали потерю ключа и всей истории переписки: расшифровать старые
-- сообщения больше нечем.
--
-- Теперь клиент может положить на сервер копию приватного ключа, зашифрованную
-- паролем учётной записи: PBKDF2-HMAC-SHA512 (соль — случайные 16 байт на
-- пользователя) + XSalsa20-Poly1305. Сервер видит только шифртекст, без
-- пароля он бесполезен — гарантия «сервер не читает переписку» сохраняется.
--
-- Почему отдельная таблица, а не колонка в profiles: RLS в profiles построчная
-- и разрешает читать чужие анкеты, спрятать одну колонку от других
-- пользователей там нельзя. Копия должна быть доступна только владельцу.

create table if not exists public.e2ee_key_backups (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  backup     text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.e2ee_key_backups is
  'Копия приватного ключа E2EE, зашифрованная паролем пользователя '
  '(PBKDF2-HMAC-SHA512 + XSalsa20-Poly1305). Строка доступна только владельцу.';

alter table public.e2ee_key_backups enable row level security;

-- Права выдаём явно: таблица создана вручную, и полагаться на default
-- privileges схемы public не стоит. Лишние права отзываем.
revoke all on public.e2ee_key_backups from anon, authenticated;
grant select, insert, update, delete on public.e2ee_key_backups to authenticated;

drop policy if exists "Своя копия ключа: чтение" on public.e2ee_key_backups;
create policy "Своя копия ключа: чтение"
  on public.e2ee_key_backups
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Своя копия ключа: создание" on public.e2ee_key_backups;
create policy "Своя копия ключа: создание"
  on public.e2ee_key_backups
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Своя копия ключа: обновление" on public.e2ee_key_backups;
create policy "Своя копия ключа: обновление"
  on public.e2ee_key_backups
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Своя копия ключа: удаление" on public.e2ee_key_backups;
create policy "Своя копия ключа: удаление"
  on public.e2ee_key_backups
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Проверка: скрипт применяют вручную, молчаливый провал был бы опасен —
-- без RLS копия стала бы доступна всем авторизованным.
do $$
declare
  policy_count integer;
begin
  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'e2ee_key_backups';

  if policy_count <> 4 then
    raise exception 'На public.e2ee_key_backups ожидалось 4 политики, найдено %.', policy_count;
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'e2ee_key_backups'
      and c.relrowsecurity
  ) then
    raise exception 'На public.e2ee_key_backups не включён RLS.';
  end if;
end;
$$;

-- PostgREST кеширует схему: без этого запросы к новой таблице могут ещё
-- какое-то время отвечать «relation not found».
notify pgrst, 'reload schema';

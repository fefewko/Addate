-- Email пользователей для панели модерации.
--
-- Email живёт в auth.users, а схема auth клиентам через PostgREST не выдаётся.
-- Добавлять email в public.profiles нельзя: у authenticated есть SELECT по
-- колонкам profiles (см. 20260926000000_lock_down_profiles.sql), поэтому email
-- стал бы виден всем пользователям, а не только администратору.
--
-- Поэтому выдаём администратору отдельный SECURITY DEFINER-функционал: он
-- читает auth.users от имени владельца функции, но возвращает строки только
-- если вызывающий — администратор. Остальные получают пустой набор.

create or replace function public.admin_user_emails()
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email::text
  from auth.users u
  where u.deleted_at is null
    and private.is_admin();
$$;

comment on function public.admin_user_emails() is
  'Email пользователей для панели модерации. Возвращает строки только '
  'администратору (private.is_admin()), остальным — пустой набор.';

-- Функции по умолчанию доступны PUBLIC: отзываем и выдаём только authenticated.
revoke all on function public.admin_user_emails() from public;
revoke all on function public.admin_user_emails() from anon;
grant execute on function public.admin_user_emails() to authenticated;

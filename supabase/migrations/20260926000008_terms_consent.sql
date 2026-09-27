-- Запись согласия с правилами
--
-- Зачем:
--
-- Галочка «я согласен(на) с правилами» — это юридический факт, а не
-- оформление интерфейса. Но галочка, которую нигде не сохраняют, не
-- доказывает ничего: при споре о правилах или о дате их изменения
-- предъявлять нечего, потому что у сервиса нет ни одной записи о том,
-- когда конкретный человек согласился.
--
-- Отдельно от 18+ (миграция 20260926000003): это разные вещи. Возраст —
-- техническое ограничение, проверяется триггером. Согласие с правилами —
-- договорной факт, и его нельзя вывести из даты рождения.
--
-- Что важно в реализации:
--
-- 1. Дату ставит БАЗА, а не клиент. Клиент не присылает terms_accepted_at,
--    поэтому подделать её нельзя. Можно солгать, что поставил галочку, — но
--    нельзя указать «я согласился шесть месяцев назад», чтобы обойти новую
--    редакцию правил. Это единственная часть согласия, которую клиент
--    физически не может подделать.
--
-- 2. Колонка защищена от изменения пользователем: добавлена в проверку
--    protect_profile_service_fields. Иначе после регистрации можно было бы
--    выполнить update profiles set terms_accepted_at = ... и переписать
--    собственное согласие, в том числе обнулить его.
--
-- Чего эта миграция НЕ делает, и это осознанно:
--
--   * Не требует согласия на уровне БД. Триггер не проверяет, что клиент
--     действительно показал галочку: у мобильного клиента с anon-ключом нет
--     способа отличить «человек поставил галочку» от «скрипт отправил запрос».
--     Настоящая проверка потребовала бы Edge Function на регистрации.
--     Сейчас галочка остаётся проверкой на клиенте, а база гарантирует
--     достоверность даты, а не самого факта.
--
--   * Не проставляет дату существующим анкетам. Согласия, которого не было,
--     не случилось задним числом: у старых аккаунтов колонка останется null,
--     и это честное значение. Применять правила к ним можно, но утверждать,
--     что они согласились задним числом, нельзя.
--
-- Идемпотентно.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

COMMENT ON COLUMN public.profiles.terms_accepted_at IS
  'Момент, когда пользователь принял правила сервиса при регистрации. '
  'Проставляется базой автоматически, клиентом не подделывается. null — '
  'анкета зарегистрирована до появления обязательного согласия.';

-- Проставляем дату сами, иначе клиент присылал бы её в INSERT и мог бы
-- подставить любую, включая дату в прошлом.
CREATE OR REPLACE FUNCTION public.stamp_terms_accepted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  if new.terms_accepted_at is null then
    new.terms_accepted_at := now();
  end if;

  return new;
end;
$$;

COMMENT ON FUNCTION public.stamp_terms_accepted() IS
  'Проставляет дату согласия с правилами в момент создания анкеты, если '
  'клиент её не прислал. Клиент эту колонку не заполняет и не должен: '
  'иначе он смог бы указать произвольную дату.';

DROP TRIGGER IF EXISTS stamp_terms_accepted ON public.profiles;

CREATE TRIGGER stamp_terms_accepted
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_terms_accepted();

-- Запрет переписывания согласия. Функция пересоздаётся целиком, а не
-- патчится: её тело и так короткое, а частичное обновление plpgsql
-- оставляет в базе код, который никто не видел.
CREATE OR REPLACE FUNCTION public.protect_profile_service_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  if auth.uid() is not null and not private.is_admin() then
    if new.is_admin is distinct from old.is_admin
       or new.moderation_status is distinct from old.moderation_status
       or new.moderation_note is distinct from old.moderation_note
       or new.terms_accepted_at is distinct from old.terms_accepted_at then
      raise exception 'Служебные поля анкеты (модерация, права и согласие с правилами) изменяются только модератором'
        using errcode = '42501';
    end if;
  end if;

  -- updated_at проставляется в одном месте, чтобы приложение не могло
  -- откатить его в произвольное прошлое.
  new.updated_at := now();

  return new;
end;
$$;

-- Колонка намеренно НЕ добавлена в GRANT SELECT (... ) из миграции
-- 20260926000000. Приложение её не читает, а правило «новая колонка не
-- выдаётся клиенту автоматически» должно остаться в силе: читать дату
-- согласия обычным SELECT не нужно, она нужна только при разборе инцидента.

-- ---------------------------------------------------------------------------
-- Проверки
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and column_name  = 'terms_accepted_at'
  ) then
    raise exception 'Колонка profiles.terms_accepted_at не создана.';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'stamp_terms_accepted' and not tgisinternal
  ) then
    raise exception 'Триггер stamp_terms_accepted не создан.';
  end if;

  -- Триггер защиты мог пропасть при пересоздании функции: CREATE OR REPLACE
  -- FUNCTION на функцию не меняет, но проверять дешевле, чем потом искать
  -- причину ошибки "permission denied" на каждом сохранении анкеты.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'protect_profile_service_fields' and not tgisinternal
  ) then
    raise exception 'Триггер protect_profile_service_fields не создан.';
  end if;

  -- Сколько анкет осталось без согласия. Не блокирует применение: у старых
  -- аккаунтов это ожидаемо, а не поломка.
  if exists (
    select 1 from public.profiles where terms_accepted_at is null
  ) then
    raise notice
      'ВНИМАНИЕ: % анкет(ы) без даты согласия (зарегистрированы до этого '
      'правила). Значение null означает «согласия не было» — это честно, '
      'проставлять дату задним числом не нужно.', count(*)
      from public.profiles where terms_accepted_at is null;
  else
    raise notice 'Все анкеты имеют дату согласия.';
  end if;

  raise notice 'Проверки пройдены. Осталось выполнить: notify pgrst, ''reload schema'';';
end;
$$;

COMMIT;

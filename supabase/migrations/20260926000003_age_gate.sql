-- Серверная проверка возраста 18+
--
-- Зачем:
--
-- Проверка возраста существовала только на клиенте: чекбокс «мне есть 18» в
-- SignUp и validateBirthDate() в ProfileSetup. Любой зарегистрировавшийся
-- мог обойти её одним запросом к API:
--     update profiles set birth_date = '1990-01-01'
-- Для приложения, где вся аудитория 18+, это содержательная дыра: ограничение
-- обязано проверяться базой, а не формой.
--
-- Сделано триггером, а не CHECK-ограничением, по двум причинам:
--   * CHECK с current_date планировщик считает "запечённым" значением, и
--     сообщение об ошибке нельзя сделать осмысленным для пользователя;
--   * триггер позволяет вернуть текст ошибки, который клиент уже умеет
--     показывать, и не трогает существующие строки при применении.
--
-- BEFORE INSERT OR UPDATE — важно: ограничение действует и на вставку,
-- поэтому нельзя обойти его, создав профиль без даты и проставив её потом.
--
-- Идемпотентно.

BEGIN;

-- Сначала считаем, есть ли уже не проходящие проверку анкеты. Ничего не меняем:
-- триггер проверяет только новые и обновляемые строки, а молча портить
-- существующие данные без ведома владельца нельзя.
DO $$
DECLARE
  v_bad integer;
BEGIN
  select count(*) into v_bad
  from public.profiles
  where birth_date is not null
    and (
      birth_date > (current_date - interval '18 years')
      or birth_date < (current_date - interval '120 years')
    );

  if v_bad > 0 then
    raise notice
      'ВНИМАНИЕ: % анкет(ы) с датой рождения вне диапазона 18-120 лет. Проверка применится к новым правкам, эти строки нужно исправить вручную:', v_bad;
  else
    raise notice 'Анкет с некорректной датой рождения нет.';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION public.check_profile_age()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
begin
  -- null означает «дата не указана»: ограничение на возраст тут не проверяем,
  -- наличие даты контролирует анкета, а не триггер.
  if new.birth_date is null then
    return new;
  end if;

  if new.birth_date > (current_date - interval '18 years') then
    raise exception 'Регистрация доступна только с 18 лет'
      using errcode = 'check_violation';
  end if;

  if new.birth_date < (current_date - interval '120 years') then
    raise exception 'Проверьте дату рождения'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

COMMENT ON FUNCTION public.check_profile_age() IS
  'Серверная проверка совершеннолетия. Раньше возраст проверялся только на '
  'клиенте и обходился прямым запросом к API.';

DROP TRIGGER IF EXISTS check_profile_age ON public.profiles;

CREATE TRIGGER check_profile_age
  BEFORE INSERT OR UPDATE OF birth_date ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.check_profile_age();

COMMIT;

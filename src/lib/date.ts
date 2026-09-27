// src/lib/date.ts
//
// Работа с датой рождения в одном месте. Раньше эти функции жили в
// ProfileSetup, а при добавлении ввода на экран регистрации пришлось бы
// завести вторую копию вместе со всеми её расхождениями.

export const MIN_AGE_YEARS = 18;
export const MAX_AGE_YEARS = 100;

export type BirthDateParts = {
  day: string;
  month: string;
  year: string;
};

export const EMPTY_PARTS: BirthDateParts = { day: '', month: '', year: '' };

function onlyDigits(value: string, max: number): string {
  return value.replace(/\D/g, '').slice(0, max);
}

export function sanitizeParts(parts: BirthDateParts): BirthDateParts {
  return {
    day: onlyDigits(parts.day, 2),
    month: onlyDigits(parts.month, 2),
    year: onlyDigits(parts.year, 4),
  };
}

// Строгая проверка календарной даты. Через new Date(y, m - 1, d) и сравнение
// компонентов: такая проверка не зависит от того, как движок разбирает
// ISO-строки, и корректно отсекает 31 февраля и 32 января.
export function toDate(parts: BirthDateParts): Date | null {
  const { day, month, year } = parts;
  if (day.length !== 2 || month.length !== 2 || year.length !== 4) return null;

  const d = Number(day);
  const m = Number(month);
  const y = Number(year);

  const date = new Date(y, m - 1, d);
  const valid =
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  return valid ? date : null;
}

// Полных лет на сегодня. Считается по календарю, а не долей года: иначе
// 18-летним человеком считался бы тот, кому 18 исполнится через месяц.
export function ageFrom(date: Date, today = new Date()): number {
  let age = today.getFullYear() - date.getFullYear();
  const beforeBirthday =
    today.getMonth() < date.getMonth() ||
    (today.getMonth() === date.getMonth() && today.getDate() < date.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function partsToIso(parts: BirthDateParts): string | null {
  const date = toDate(parts);
  if (!date) return null;
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

export function isoToParts(iso: string | null): BirthDateParts {
  if (!iso) return EMPTY_PARTS;
  const match = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return EMPTY_PARTS;
  const [, year, month, day] = match;
  return { day, month, year };
}

// Текст ошибки или null, если дата корректна.
export function validateBirthDateParts(parts: BirthDateParts): string | null {
  if (!parts.day && !parts.month && !parts.year) {
    return 'Укажите дату рождения: день, месяц и год.';
  }

  const date = toDate(parts);
  if (!date) {
    return 'Такой даты не бывает. Проверьте день, месяц и год.';
  }

  const age = ageFrom(date);
  if (age < MIN_AGE_YEARS) {
    return `Регистрация доступна только с ${MIN_AGE_YEARS} лет.`;
  }
  if (age > MAX_AGE_YEARS) {
    return `Проверьте дату рождения: больше ${MAX_AGE_YEARS} лет не принимаем.`;
  }

  return null;
}

export function formatForDisplay(iso: string | null): string {
  const { day, month, year } = isoToParts(iso);
  if (!day || !month || !year) return '';
  return `${day}.${month}.${year}`;
}

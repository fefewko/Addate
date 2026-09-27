// src/lib/log.ts
//
// Единая точка логирования вместо разбросанных console.*.
//
// Зачем: console.warn и console.error попадают в релизную сборку и наполняют
// консоль телефона, из-за чего настоящие проблемы теряются в шуме. В релизной
// сборке логи не выводятся вовсе, в разработке — выводятся полностью.
// В production можно поднять уровень до 'error', оставив только сбои, без
// смены кода на каждом экране.

type Level = 'debug' | 'warn' | 'error';

// __DEV__ определяется Metro и в релизной сборке равен false. Фолбэк на
// process.env.NODE_ENV нужен на случай запуска вне Expo (тесты, node).
const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : process.env.NODE_ENV !== 'production';

const MIN_LEVEL: Level = isDev ? 'debug' : 'error';

const ORDER: Record<Level, number> = { debug: 0, warn: 1, error: 2 };

function write(level: Level, args: unknown[]) {
  if (ORDER[level] < ORDER[MIN_LEVEL]) return;

  const prefix = `[addate:${level}]`;
  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

export const log = {
  debug: (...args: unknown[]) => write('debug', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

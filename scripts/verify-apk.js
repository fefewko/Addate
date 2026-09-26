// scripts/verify-apk.js
//
// Проверяет, что собранный APK не пустой: внутри бандла должны быть ключи
// Supabase. Без этой проверки нерабочая сборка выглядит как «приложение падает
// на старте», и разбираться приходится уже на телефоне.
//
// Нужен потому, что .env лежит в .gitignore и в сборку не попадает: если
// переменные окружения не подставились, process.env.EXPO_PUBLIC_SUPABASE_URL
// превращается в undefined, бандл собирается без ошибок, а приложение падает.
//
// Использование:
//   node scripts/verify-apk.js [путь-к-apk]
//   node scripts/verify-apk.js --check-env
//
// Чтение байтов самого APK бесполезно: это zip, содержимое сжато DEFLATE.
// Поэтому ниже свой разбор zip central directory, без внешних зависимостей.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_APK = path.join(
  ROOT,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk'
);

function findEocd(buf) {
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('APK не похож на zip: не найден End of Central Directory');
}

function listEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('битый central directory');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) {
    throw new Error('битый local header');
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

function readEnv(name) {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return null;
  const line = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith(name + '='));
  if (!line) return null;
  return line.slice(line.indexOf('=') + 1).trim();
}

function main() {
  const apkPath = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : DEFAULT_APK;

  if (!fs.existsSync(apkPath)) {
    console.error(`APK не найден: ${apkPath}\nСначала соберите: npm run build:apk`);
    process.exit(1);
  }

  const supabaseUrl = readEnv('EXPO_PUBLIC_SUPABASE_URL');
  if (!supabaseUrl) {
    console.error(
      'В .env нет EXPO_PUBLIC_SUPABASE_URL — нечем проверять.\n' +
        'Без него в сборку попадёт undefined и приложение упадёт на старте.'
    );
    process.exit(1);
  }

  // Ищем характерную часть адреса проекта, а не сам URL целиком: в бандле
  // строка может встретиться в разных местах.
  const ref = supabaseUrl.replace(/^https?:\/\//, '').split('.')[0];
  const key = readEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  const keyProbe = key ? key.slice(30, 70) : null;

  console.log(`APK:    ${apkPath}`);
  console.log(`        ${(fs.statSync(apkPath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Ищем:   реф проекта "${ref}"${keyProbe ? ' и фрагмент anon-ключа' : ''}\n`);

  const buf = fs.readFileSync(apkPath);
  const entries = listEntries(buf);

  const bundleEntry = entries.find(
    (e) => e.name === 'assets/index.android.bundle' || /\.bundle$/.test(e.name)
  );
  if (!bundleEntry) {
    console.error('В APK нет assets/index.android.bundle — сборка подозрительна.');
    process.exit(1);
  }

  const text = readEntry(buf, bundleEntry).toString('latin1');

  const checks = [
    ['реф Supabase-проекта', text.includes(ref)],
    ['схема addate://', text.includes('addate://')],
    ['маршрут auth/callback', text.includes('auth/callback')],
    ['экран AuthCallback', text.includes('AuthCallback')],
    ['функция feed_profiles', text.includes('feed_profiles')],
    ['функция my_location', text.includes('my_location')],
  ];
  if (keyProbe) {
    checks.splice(1, 0, ['фрагмент anon-ключа', text.includes(keyProbe)]);
  }

  let hardFail = false;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    // Ключи обязательны: без них приложение не запустится. Остальное —
    // полезный сигнал о том, какая версия кода попала в сборку.
    if (!ok && /Supabase|ключа|адрес/.test(label)) hardFail = true;
  }

  console.log('');
  if (hardFail) {
    console.error(
      'Ключи Supabase в сборке отсутствуют: приложение упадёт на старте.\n' +
        'Проверьте, что .env существует и читается при сборке.'
    );
    process.exit(1);
  }
  console.log('Сборка выглядит рабочей.');
}

main();

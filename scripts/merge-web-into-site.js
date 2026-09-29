// scripts/merge-web-into-site.js
//
// Встраивает веб-версию в уже существующий сайт: копирует приложение в web/
// и ДОПИСЫВАЕТ правила в _redirects и _headers.
//
// Зачем отдельный шаг, а не «скопируйте папку вручную»:
//
//   _redirects и _headers управляют всем сайтом, а не только /web. Если
//   положить готовые файлы из сборки в корень, они заменят чужие — и
//   перестанут работать существующие страницы. Ошибка выглядит безобидно:
//   /web работает, а сломалось всё остальное, и находится это не сразу.
//
//   Скрипт поэтому только дописывает строки, которых там ещё нет, и
//   отказывается молча перетирать существующие правила для /web.
//
// Использование:
//   npm run build:web
//   node scripts/merge-web-into-site.js C:\путь\к\корню-сайта
//   npm run merge:web -- C:\путь\к\корню-сайта
//
// Что делает:
//   <сайт>/web/**            <- приложение
//   <сайт>/_redirects        += /web  /web/  301  и  /web/*  /web/index.html  200
//   <сайт>/_headers          += блок /web/* с запретом кэша
//
// Ничего не удаляет. Если правила для /web уже есть, скрипт скажет об этом
// и оставит файл как есть.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'web-build');

function fail(msg) {
  console.error(`\nОШИБКА: ${msg}\n`);
  process.exit(1);
}

const siteArg = process.argv[2];
if (!siteArg) {
  fail('Не указан путь к корню сайта.\nПример: node scripts/merge-web-into-site.js C:\\www\\addate');
}

const SITE = path.resolve(siteArg);

if (!fs.existsSync(SITE) || !fs.statSync(SITE).isDirectory()) {
  fail(`Каталога ${SITE} не существует.`);
}

if (!fs.existsSync(path.join(BUILD, 'web', 'index.html'))) {
  fail('Нет собранной веб-версии. Сначала выполните: npm run build:web');
}

if (SITE === BUILD) fail('Указан каталог самой сборки — сливается не с чем.');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyDir(src, dst);
    else {
      fs.copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

// Правила для /web, которые обязаны быть в корне сайта.
//
// Порядок важен и повторяет public/_redirects: Cloudflare применяет правила
// всегда, даже если по пути лежит файл, поэтому /web/* перехватил бы и
// запросы к бандлу. Строки для ассетов идут перед catch-all.
const REDIRECT_LINES = [
  '/web  /web/  301',
  '/web/_expo/*  /web/_expo/:splat  200',
  '/web/assets/*  /web/assets/:splat  200',
  '/web/favicon.ico  /web/favicon.ico  200',
  '/web/*  /web/index.html  200',
];

const HEADER_BLOCK = [
  '# ADDate: веб-версия. Папка web/ меняет имя бандла только при сборке,',
  '# поэтому index.html запрещено кэшировать — иначе после выкладки браузер',
  '# продолжит открывать прошлую версию.',
  '/web/*',
  '  Cache-Control: no-cache, must-revalidate',
  '',
  '/web/_expo/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '/web/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
];

console.log(`Корневой каталог сайта: ${SITE}\n`);

// 1. Приложение
const targetApp = path.join(SITE, 'web');
if (fs.existsSync(targetApp)) {
  console.log('Папка web/ уже есть — будет заменена содержимым новой сборки.');
}
const files = copyDir(path.join(BUILD, 'web'), targetApp);
console.log(`  ✓ приложение скопировано в web/ (${files} файлов)`);

// 2. _redirects
const redirectsPath = path.join(SITE, '_redirects');
let redirects = fs.existsSync(redirectsPath) ? fs.readFileSync(redirectsPath, 'utf8') : '';

if (redirects.includes('/web/index.html')) {
  console.log('  – _redirects: правила для /web уже есть, файл не тронут');
} else {
  const part = redirects.trim() ? redirects.replace(/\s*$/, '\n\n') : '';
  const comment = '# ADDate: веб-версия (web.output=single, поэтому любой путь\n'
    + '# внутри /web отдаёт index.html).\n';
  fs.writeFileSync(redirectsPath, part + comment + REDIRECT_LINES.join('\n') + '\n', 'utf8');
  console.log('  ✓ _redirects: добавлены правила для /web');
}

// 3. _headers
const headersPath = path.join(SITE, '_headers');
let headers = fs.existsSync(headersPath) ? fs.readFileSync(headersPath, 'utf8') : '';

if (headers.includes('/web/*')) {
  console.log('  – _headers: правила для /web уже есть, файл не тронут');
} else {
  const part = headers.trim() ? headers.replace(/\s*$/, '\n') : '';
  fs.writeFileSync(headersPath, part + HEADER_BLOCK.join('\n') + '\n', 'utf8');
  console.log('  ✓ _headers: добавлены заголовки для /web');
}

console.log('\nГотово. Осталось задеплоить этот каталог на Cloudflare Pages.');
console.log('Проверить локально до выкладки можно так:');
console.log(`  npx serve ${SITE}`);

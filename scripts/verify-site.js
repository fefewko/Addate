// scripts/verify-site.js
//
// Проверка сайта с веб-версией ДО выкладки на Cloudflare Pages.
//
// Зачем: Cloudflare отдаёт статические файлы только если запрос не попал под
// правило из _redirects. Документация прямо говорит: "Redirects are always
// followed, regardless of whether or not an asset matches the incoming
// request". Правило /web/* -> index.html поэтому перехватывает и запросы к
// ассетам, и страница открывается белой без ошибок в консоли.
//
// Локальный сервер, на котором веб-версия проверяется отдельно, отдаёт
// файлы первыми и такую ошибку не воспроизводит. Этот скрипт повторяет
// именно порядок Cloudflare: сначала правила, потом файл.
//
// Использование:
//   node scripts/verify-site.js C:\путь\к\корню-сайта
//   npm run verify:site -- C:\путь\к\корню-сайта
//
// Что проверяет:
//   * главная страница и существующие страницы сайта не сломаны;
//   * /web отдаёт редирект на /web/, а /web/ — приложение;
//   * любой маршрут внутри /web отдаёт приложение (SPA-маршрутизация);
//   * и главное: каждый ассет, на который ссылается index.html приложения,
//     отдаётся с правильным типом содержимого, а не как text/html.

const fs = require('fs');
const path = require('path');

const siteArg = process.argv[2];
if (!siteArg) {
  console.error('Не указан путь к корню сайта.');
  console.error('Пример: node scripts/verify-site.js C:\\www\\addate');
  process.exit(1);
}

const SITE = path.resolve(siteArg);
const APP = path.join(SITE, 'web');

let failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------- правила
function readRules() {
  const file = path.join(SITE, '_redirects');
  if (!fs.existsSync(file)) {
    console.error(`\nНет ${file}. Cloudflare Pages без него не сделает SPA-маршрутизацию.\n`);
    process.exit(1);
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(\d{3})?$/);
      return m ? { source: m[1], dest: m[2], code: Number(m[3] || 302) } : null;
    })
    .filter(Boolean);
}

const rules = readRules();

// Порядок Cloudflare: первое подошедшее правило выигрывает, и оно
// срабатывает всегда, даже если по этому пути лежит файл.
function applyRules(urlPath) {
  for (const rule of rules) {
    const sourcePattern = new RegExp(
      '^' +
        rule.source
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('(.*)') +
        '$'
    );
    const m = urlPath.match(sourcePattern);
    if (!m) continue;
    const splat = m[1] === undefined ? '' : m[1];
    return { rule, dest: rule.dest.replace(':splat', splat) };
  }
  return null;
}

function fileAt(p) {
  const full = path.join(SITE, p.replace(/^\//, ''));
  if (!full.startsWith(SITE)) return null;
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    const index = path.join(full, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return fs.existsSync(full) ? full : null;
}

function resolve(urlPath) {
  const hit = applyRules(urlPath);
  if (hit) {
    if (hit.rule.code === 200) {
      const file = fileAt(hit.dest);
      return { status: file ? 200 : 404, file, viaRewrite: true };
    }
    return { status: hit.rule.code, location: hit.dest };
  }
  const file = fileAt(urlPath);
  return { status: file ? 200 : 404, file };
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ---------------------------------------------------------------- проверки
console.log(`Проверяю сайт: ${SITE}\n`);

console.log('Сайт не сломан');
const main = resolve('/');
check(main.status === 200, 'главная страница отдаётся', main.file ? path.basename(main.file) : 'нет файла');

console.log('\nСуществующие страницы');
// Правила веб-версии проверяются отдельно, ниже: catch-all /web/* ведёт на
// index.html и к страницам сайта отношения не имеет.
const sitePageRules = rules.filter((r) => r.dest.includes('.html') && !r.source.startsWith('/web'));
if (sitePageRules.length === 0) {
  console.log('  – правил на страницы нет, проверять нечего');
} else {
  for (const r of sitePageRules) {
    // Путь берётся как есть: source уже начинается со слеша, и добавление
    // второго давало //rules, которое не совпадало ни с одним правилом.
    const res = resolve(r.source.replace('*', 'проверка'));
    check(res.status === 200, `${r.source} -> ${r.dest}`, res.status !== 200 ? `статус ${res.status}` : '');
  }
}

console.log('\nВеб-версия');
if (!fs.existsSync(path.join(APP, 'index.html'))) {
  check(false, 'в web/ лежит index.html', 'приложение не собрано или не скопировано');
  console.log('\nИтог: есть проблемы.\n');
  process.exit(1);
}

const rootRedirect = resolve('/web');
check(
  rootRedirect.status === 301 && rootRedirect.location === '/web/',
  '/web перенаправляет на /web/',
  rootRedirect.status === 301 ? `Location: ${rootRedirect.location}` : `статус ${rootRedirect.status}`
);

for (const p of ['/web/', '/web/feed', '/web/chats', '/web/me', '/web/all', '/web/settings', '/web/signin', '/web/signup', '/web/profile/1f0c-uuid']) {
  const res = resolve(p);
  const isApp = res.file && mimeOf(res.file) === 'text/html' && res.file.includes(`${path.sep}web${path.sep}`);
  check(res.status === 200 && isApp, `${p} отдаёт приложение`, res.status !== 200 ? `статус ${res.status}` : '');
}

console.log('\nАссеты (главное: правила не должны перехватывать файлы)');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => u.startsWith('/'));

if (assets.length === 0) {
  check(false, 'index.html ссылается на ассеты', 'ссылок не найдено — проверять нечего');
} else {
  for (const asset of assets) {
    const res = resolve(asset);
    const type = res.file ? mimeOf(res.file) : 'нет файла';
    const ok = res.status === 200 && type !== 'text/html';
    check(
      ok,
      asset,
      ok ? type : `отдаётся как ${type} — это index.html вместо файла, страница будет белой`
    );
  }
}

// Отдельно: реальные файлы бандла, а не только те, что перечислены в index.html.
const bundleDir = path.join(APP, '_expo', 'static', 'js', 'web');
if (fs.existsSync(bundleDir)) {
  for (const file of fs.readdirSync(bundleDir).filter((f) => f.endsWith('.js'))) {
    const url = `/web/_expo/static/js/web/${file}`;
    const res = resolve(url);
    check(res.status === 200 && mimeOf(res.file || '') === 'text/javascript', url, `статус ${res.status}`);
  }
} else {
  check(false, 'найден бандл в web/_expo/static/js/web', 'каталога нет');
}

const fontsDir = path.join(APP, 'assets');
if (fs.existsSync(fontsDir)) {
  const ttf = findFirst(fontsDir, '.ttf');
  if (ttf) {
    const url = '/' + path.relative(SITE, ttf).split(path.sep).join('/');
    const res = resolve(url);
    check(res.status === 200 && mimeOf(res.file || '') === 'font/ttf', 'шрифт иконок отдаётся как font/ttf', `статус ${res.status}`);
  }
}

function findFirst(dir, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findFirst(p, ext);
      if (found) return found;
    } else if (e.name.endsWith(ext)) {
      return p;
    }
  }
  return null;
}

console.log('');
if (failed === 0) {
  console.log('все проверки пройдены — сайт можно выкладывать');
} else {
  console.log(`провалено: ${failed}. Выкладывать нельзя.`);
  process.exit(1);
}

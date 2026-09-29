// scripts/build-web.js
//
// Сборка веб-версии в раскладку, пригодную для выкладки на Cloudflare Pages.
//
// Зачем скрипт, если есть `expo export`:
//
//   1. Приложение живёт по адресу /web, а `expo export` кладёт index.html в
//      корень папки сборки. По умолчанию получилось бы, что /web отдаёт
//      404, а сам index.html висит на главной странице сайта — то есть
//      затирает существующую landing page. Скрипт переносит всё в web/.
//   2. Файлы _redirects и _headers работают только в корне проекта Pages,
//      но собирать их в web/ бессмысленно. Они копируются в корень отдельно,
//      чтобы их можно было положить рядом с главной страницей.
//   3. Сборка проверяется сразу: отсутствие файла, на который ссылается
//      index.html, на Cloudflare выглядит как пустая страница без объяснений,
//      и найти это можно только в браузере.
//
// Использование:
//   npm run build:web
//   npm run build:web -- --out dist-web
//   npm run build:web -- --skip-export     пересобрать раскладку без expo export
//                                          (после правки public/_headers и т.п.)
//
// Результат (по умолчанию в web-build/):
//   web/index.html, web/_expo/..., web/assets/...   — само приложение
//   _redirects, _headers                            — файлы для корня Pages

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = 'web';

function flagValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

const OUT_DIR = path.resolve(ROOT, flagValue('out', 'web-build'));
// Промежуточная сборка expo живёт вне web-build: иначе её нельзя переиспользовать
// для --skip-export, не смешав со странными файлами в корне результата.
const RAW_DIR = path.join(ROOT, 'node_modules', '.cache', 'expo-web-raw');
const SKIP_EXPORT = process.argv.includes('--skip-export');

function log(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`\nОШИБКА: ${msg}\n`);
  process.exit(1);
}

function rimraf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// 1. Сборка
//    CLI Expo вызывается напрямую через node, а не через `npx` с shell: true —
//    при shell Node выдаёт предупреждение о склейке аргументов, а путь к
//    CLI заранее известен и не требует разрешения имён в cmd.
if (!SKIP_EXPORT) {
  rimraf(RAW_DIR);
  log('Собираю веб-версию (expo export)...');
  const expoCli = path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli');
  if (!fs.existsSync(expoCli)) {
    fail('не найден node_modules/expo/bin/cli — выполните npm install.');
  }
  const result = spawnSync(
    process.execPath,
    [expoCli, 'export', '--platform', 'web', '--output-dir', RAW_DIR, '--clear'],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) fail('expo export завершился с ошибкой.');
} else {
  log('Пропускаю expo export (--skip-export), перекладываю прошлую сборку.');
}

if (!fs.existsSync(path.join(RAW_DIR, 'index.html'))) {
  fail(`В ${RAW_DIR} нет index.html — сборка не удалась.`);
}

// 2. Перенос в web/
//    Корень результата очищается целиком: там не должно остаться ничего от
//    прошлых сборок. Именно лишний index.html в корне перезаписал бы главную
//    страницу сайта — на Cloudflare это незаметно, пока не проверишь.
rimraf(OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });
copyDir(RAW_DIR, path.join(OUT_DIR, APP_DIR));

// 3. Файлы Cloudflare Pages — в корень
for (const name of ['_redirects', '_headers']) {
  const from = path.join(OUT_DIR, APP_DIR, name);
  if (!fs.existsSync(from)) {
    fail(`Нет ${name}. Ожидался в public/${name} — без него маршруты /web/* отдадут 404.`);
  }
  fs.copyFileSync(from, path.join(OUT_DIR, name));
}

// 4. Проверка
log('\nПроверяю результат:');

const indexPath = path.join(OUT_DIR, APP_DIR, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

const problems = [];

// 4.1. Все пути из index.html должны начинаться с /web и существовать на диске
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const local = refs.filter((r) => r.startsWith('/') && !r.startsWith('//'));

if (local.length === 0) fail('index.html не ссылается ни на один локальный ресурс.');

for (const ref of local) {
  if (!ref.startsWith(`/${APP_DIR}/`)) {
    problems.push(
      `ссылка ${ref} не начинается с /${APP_DIR}/. Похоже, experiments.baseUrl в app.json ` +
        'разошёлся с фактическим адресом.'
    );
    continue;
  }
  const onDisk = path.join(OUT_DIR, ref.replace(/^\//, ''));
  if (!fs.existsSync(onDisk)) problems.push(`файл ${ref} есть в index.html, но отсутствует в сборке.`);
}

// 4.2. Ручная проверка: без переноса в web/ главная страница сайта была бы
//      перезаписана сгенерированным index.html.
if (fs.existsSync(path.join(OUT_DIR, 'index.html'))) {
  problems.push('в корне сборки лежит index.html — он перезапишет главную страницу сайта.');
}

// 4.3. Адрес в бандле, в коде и в конфиге должны совпадать.
//      Константа живёт в webPaths.ts, а не в webLinks.ts: webLinks тянет
//      react-native и не годится для скрипта, а проверять надо именно то
//      значение, из которого собираются адреса.
const webPaths = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'webPaths.ts'), 'utf8');
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
// baseUrl лежит внутри experiments — так он описан в документации Expo.
const baseUrl = appJson.expo?.experiments?.baseUrl ?? '';
const codeBasePath = (webPaths.match(/WEB_BASE_PATH\s*=\s*'([^']+)'/) || [])[1];

if (!codeBasePath) {
  problems.push('в src/lib/webPaths.ts не найдено WEB_BASE_PATH.');
} else if (`/${APP_DIR}` !== codeBasePath) {
  problems.push(
    `WEB_BASE_PATH в коде это '${codeBasePath}', а сборка кладётся в '/${APP_DIR}'. ` +
      'Ссылки в письмах и в адресной строке разойдутся с тем, что отдаётся.'
  );
} else if (baseUrl !== codeBasePath) {
  problems.push(`experiments.baseUrl в app.json это '${baseUrl}', а в коде '${codeBasePath}'.`);
}

// 4.4. Публичные ключи Supabase обязаны попасть в бандл: без них страница
//      откроется и сразу упадёт на запросах. Их отсутствие, наоборот, было бы
//      тихим поломом — поэтому проверяем именно наличие.
const bundleDir = path.join(OUT_DIR, APP_DIR, '_expo', 'static', 'js', 'web');
const bundles = fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir).filter((f) => f.endsWith('.js')) : [];
if (bundles.length === 0) {
  problems.push('не найден ни один JS-бандл в _expo/static/js/web.');
} else {
  const code = bundles.map((f) => fs.readFileSync(path.join(bundleDir, f), 'utf8')).join('');
  if (!code.includes('supabase.co')) {
    problems.push('в бандле нет адреса Supabase — страница откроется пустой, запросы падают.');
  }
}

if (problems.length > 0) {
  console.error('\nПРОБЛЕМЫ:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const size = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .reduce((sum, e) => sum + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);

log(`  ✓ ресурсы из index.html на месте (${local.length} шт., префикс /${APP_DIR}/)`);
log(`  ✓ главная страница сайта не затрагивается (index.html только внутри ${APP_DIR}/)`);
log(`  ✓ experiments.baseUrl, WEB_BASE_PATH и папка сборки совпадают: ${codeBasePath}`);
log(`  ✓ адрес Supabase попал в бандл`);
log(`  ✓ _redirects и _headers готовы к выкладке в корень Pages`);
log(`\nГотово. Размер: ${(size(path.join(OUT_DIR, APP_DIR)) / 1024 / 1024).toFixed(1)} МБ`);
log(`\nЧто дальше: скопируйте ${path.relative(ROOT, OUT_DIR)} в корень проекта Cloudflare Pages.`);
log('Подробности в WEB_DEPLOY.md.');

// scripts/serve-web.js
//
// Локальный просмотр веб-версии ровно по тому адресу, который будет на
// addate.ru: http://127.0.0.1:8081/web/
//
// Зачем нельзя просто открыть web-build/index.html или подать папку в корень:
// в сборке путь /web зашит в ссылки на ассеты (experiments.baseUrl), и без
// префикса они не найдутся. Сервер повторяет то, что делает хостинг:
// монтирует сборку под /web и отдаёт index.html на любой маршрут внутри
// него — иначе переход на /web/feed или /web/profile/<id> даёт 404.
//
// Использование:
//   npm run build:web
//   npm run serve:web
//   npm run serve:web -- --port 3000

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'web-build', 'web');
const PREFIX = '/web';

function flagValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

const PORT = Number(flagValue('port', 8081));

if (!fs.existsSync(path.join(BUILD, 'index.html'))) {
  console.error(`Нет сборки в ${path.relative(ROOT, BUILD)}.`);
  console.error('Сначала выполните: npm run build:web');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    if (urlPath !== PREFIX && !urlPath.startsWith(PREFIX + '/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — вне /web. Так же ведёт себя и хостинг: главная страница сайта не затронута.');
      return;
    }

    let filePath = path.join(BUILD, urlPath.slice(PREFIX.length) || '/');
    if (!filePath.startsWith(BUILD)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(BUILD, 'index.html');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
        // Без запрета кэша браузер держит старую сборку и показывает
        // результат правок, которых в коде уже нет.
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Веб-версия ADDate: http://127.0.0.1:${PORT}${PREFIX}/`);
    console.log('Остановить: Ctrl+C');
  });

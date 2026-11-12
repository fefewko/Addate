// scripts/make-icons.js
//
// Готовит иконки приложения из исходного логотипа assets/Logo.png.
//
// Раньше в app.json и icon.png, и foregroundImage для Android указывали на
// один и тот же файл — чёрный квадрат 1024x1024, внутри которого лежал
// прямоугольник логотипа на белом фоне. Android обрезает такой значок по
// кругу (адаптивная иконка), поэтому на телефоне был виден чёрный круг с
// белым прямоугольником внутри, а сам логотип тонул в нём.
//
// Теперь:
//   assets/icon.png           — квадрат 1024x1024, логотип по центру (iOS и
//                               старые Android, где иконка не адаптивная);
//   assets/adaptive-icon.png  — прозрачный фон, логотип строго внутри safe
//                               zone (66% ширины), фон задаётся цветом
//                               android.adaptiveIcon.backgroundColor;
//   assets/favicon.png        — то же в 192x192 для веба.
//
// Белый фон исходника убирается по цвету заливки, поэтому логотип не тащит
// за собой прямоугольник. Внутренний белый завиток логотипа тоже становится
// прозрачным — на светлом фоне он выглядит ровно как в оригинале.
//
// Запуск: node scripts/make-icons.js

const path = require('path');
const Jimp = require('jimp-compact');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'Logo.png');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const ADAPTIVE = path.join(ROOT, 'assets', 'adaptive-icon.png');
const FAVICON = path.join(ROOT, 'assets', 'favicon.png');
const SPLASH = path.join(ROOT, 'assets', 'splash-logo.png');

// Цвет бумаги в исходнике — тёплый белый. Он же становится фоном иконки и
// background-цветом адаптивной иконки в app.json.
const PAPER = 0xf9faf5;

// Пиксель считается фоном, если он светлый и почти нейтральный: сама бумага
// (249, 250, 245), её лёгкая текстура и белые зазоры внутри логотипа. Цветные
// части логотипа — тёмно-зелёная и оранжевая — под правило не попадают.
function isPaper(r, g, b) {
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  return min >= 215 && max - min <= 22;
}

// Прямоугольник, который реально занимает логотип: по нему обрезаем поля
// исходника, чтобы логотип занимал иконку, а не тонул в пустом фоне.
function contentBounds(image) {
  const { width, height, data } = image.bitmap;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isPaper(data[i], data[i + 1], data[i + 2])) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) throw new Error('Не удалось найти логотип на исходнике.');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Вырезает логотип и делает фон прозрачным, сохраняя сглаженные края.
async function extractLogo() {
  const source = await Jimp.read(SOURCE);
  const box = contentBounds(source);

  // Небольшой запас, чтобы не срезать сглаженный край логотипа.
  const pad = 4;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const width = Math.min(source.bitmap.width - x, box.width + pad * 2);
  const height = Math.min(source.bitmap.height - y, box.height + pad * 2);

  const logo = source.crop(x, y, width, height);

  logo.scan(0, 0, logo.bitmap.width, logo.bitmap.height, function (px, py, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    if (isPaper(r, g, b)) this.bitmap.data[idx + 3] = 0;
  });

  return logo;
}

function place(logo, size, box) {
  const scale = box / logo.bitmap.height;
  const art = logo.clone().resize(Math.round(logo.bitmap.width * scale), box, Jimp.RESIZE_BICUBIC);
  return { art, x: Math.round((size - art.bitmap.width) / 2), y: Math.round((size - art.bitmap.height) / 2) };
}

async function main() {
  const logo = await extractLogo();

  // Иконка приложения (iOS, веб-манифест, старые Android). Логотип — 62%
  // высоты: у iOS скругление срезает только самый край, больше не нужно.
  const icon = new Jimp(1024, 1024, PAPER * 256 + 0xff);
  const iconArt = place(logo, 1024, 640);
  icon.composite(iconArt.art, iconArt.x, iconArt.y);
  await icon.writeAsync(ICON);

  // Адаптивная иконка Android: прозрачный фон, логотип внутри safe zone.
  // 58% от 1024 — это ~60dp из 108dp, круг любой формы его не срежет.
  const adaptive = new Jimp(1024, 1024, 0x00000000);
  const adaptiveArt = place(logo, 1024, 600);
  adaptive.composite(adaptiveArt.art, adaptiveArt.x, adaptiveArt.y);
  await adaptive.writeAsync(ADAPTIVE);

  // favicon для веба — та же композиция в 192x192.
  const favicon = new Jimp(192, 192, PAPER * 256 + 0xff);
  const faviconArt = place(logo, 192, 120);
  favicon.composite(faviconArt.art, faviconArt.x, faviconArt.y);
  await favicon.writeAsync(FAVICON);

  // Заставка при запуске. Раньше здесь использовался тот же Logo.png, то есть
  // на тёмном фоне (#121212) висел белый прямоугольник с логотипом внутри.
  // Теперь фон прозрачный, и на заставке виден только сам логотип.
  const splashHeight = 480;
  const splash = logo
    .clone()
    .resize(Math.round(logo.bitmap.width * (splashHeight / logo.bitmap.height)), splashHeight, Jimp.RESIZE_BICUBIC);
  await splash.writeAsync(SPLASH);

  console.log('Готово:');
  console.log('  assets/icon.png           1024x1024');
  console.log('  assets/adaptive-icon.png  1024x1024 (прозрачный фон)');
  console.log('  assets/favicon.png        192x192');
  console.log('  assets/splash-logo.png    прозрачный фон для заставки');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
